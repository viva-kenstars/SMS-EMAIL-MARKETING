/**
 * Server-side credential protection. Import only from server/API modules.
 * The master key comes from the host's secret environment, never browser data.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_BYTES = 4096;
const MAX_CONTEXT_BYTES = 1024;
const MAX_CIPHERTEXT_BYTES = MAX_SECRET_BYTES + TAG_BYTES;
const MAX_ENVELOPE_LENGTH = 3 + 16 + 1 + 4 * Math.ceil(MAX_CIPHERTEXT_BYTES / 3);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: unknown, minimumBytes: number, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4 * Math.ceil(maximumBytes / 3)
    || !BASE64_PATTERN.test(value)
  ) throw new Error('Invalid protected credential data.');

  const binary = atob(value);
  if (binary.length < minimumBytes || binary.length > maximumBytes) {
    throw new Error('Invalid protected credential data.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // Reject noncanonical pad bits as well as missing/extra padding.
  if (toBase64(bytes) !== value) {
    bytes.fill(0);
    throw new Error('Invalid protected credential data.');
  }
  return bytes;
}

function encodeText(value: unknown, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumBytes) {
    throw new Error('Invalid protected credential data.');
  }
  const bytes = new TextEncoder().encode(value);
  // Reject ill-formed UTF-16 rather than silently changing a supplied secret.
  if (bytes.length > maximumBytes || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== value) {
    bytes.fill(0);
    throw new Error('Invalid protected credential data.');
  }
  return bytes;
}

async function importMasterKey(value: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const bytes = fromBase64(value, KEY_BYTES, KEY_BYTES);
  try {
    return await crypto.subtle.importKey('raw', bytes.buffer, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    bytes.fill(0);
  }
}

/** True only for a canonical standard-base64 encoding of exactly 32 bytes. */
export function isEncryptionKeyReady(value: unknown): boolean {
  try {
    const bytes = fromBase64(value, KEY_BYTES, KEY_BYTES);
    bytes.fill(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Protect a nonempty UTF-8 secret of at most 4096 bytes with AES-256-GCM.
 * Context must be nonempty UTF-8 of at most 1024 bytes, using the exact same
 * provider/owner/base-URL binding when decrypting. The tag is 128 bits.
 */
export async function encryptSecret(secret: string, masterKey: string, context: string): Promise<string> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  let additionalData: Uint8Array<ArrayBuffer> | undefined;
  try {
    plaintext = encodeText(secret, MAX_SECRET_BYTES);
    additionalData = encodeText(context, MAX_CONTEXT_BYTES);
    const key = await importMasterKey(masterKey, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.buffer, additionalData: additionalData.buffer, tagLength: TAG_BYTES * 8 },
      key,
      plaintext.buffer,
    );
    return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`;
  } catch {
    throw new Error('Could not protect SMS credentials.');
  } finally {
    plaintext?.fill(0);
    additionalData?.fill(0);
  }
}

/** Open a v1 envelope only when the key, authentication tag, and context match. */
export async function decryptSecret(envelope: string, masterKey: string, context: string): Promise<string> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  let additionalData: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_LENGTH) {
      throw new Error('Invalid protected credential data.');
    }
    const parts = envelope.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') {
      throw new Error('Invalid protected credential data.');
    }
    const iv = fromBase64(parts[1], IV_BYTES, IV_BYTES);
    const ciphertext = fromBase64(parts[2], TAG_BYTES + 1, MAX_CIPHERTEXT_BYTES);
    additionalData = encodeText(context, MAX_CONTEXT_BYTES);
    const key = await importMasterKey(masterKey, 'decrypt');
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer, additionalData: additionalData.buffer, tagLength: TAG_BYTES * 8 },
      key,
      ciphertext.buffer,
    );
    plaintext = new Uint8Array(decrypted);
    if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
      throw new Error('Invalid protected credential data.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new Error('Could not open SMS credentials.');
  } finally {
    plaintext?.fill(0);
    additionalData?.fill(0);
  }
}
