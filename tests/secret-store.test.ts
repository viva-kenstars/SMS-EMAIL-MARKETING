import test from 'node:test';
import assert from 'node:assert/strict';
import { isEncryptionKeyReady, encryptSecret, decryptSecret } from '../app/lib/secret-store.ts';

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function fakeMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

const CONTEXT = 'owner:fixture-owner|provider:termii|base:https://api.ng.termii.com';
const FAKE_SECRET = 'fixture-only-credential-never-used-for-network-abc123';

test('valid fake key is ready and credentials round-trip with authenticated context', async () => {
  const masterKey = fakeMasterKey();
  assert.equal(isEncryptionKeyReady(masterKey), true);
  const envelope = await encryptSecret(FAKE_SECRET, masterKey, CONTEXT);
  assert.equal(await decryptSecret(envelope, masterKey, CONTEXT), FAKE_SECRET);
  const [version, iv, ciphertext] = envelope.split(':');
  assert.equal(version, 'v1');
  assert.equal(atob(iv).length, 12);
  assert.equal(atob(ciphertext).length, new TextEncoder().encode(FAKE_SECRET).length + 16);
});

test('each encryption uses a fresh random 96-bit IV', async () => {
  const masterKey = fakeMasterKey();
  const envelopes = await Promise.all(Array.from({ length: 8 }, () => encryptSecret(FAKE_SECRET, masterKey, CONTEXT)));
  assert.equal(new Set(envelopes).size, 8);
  assert.equal(new Set(envelopes.map((envelope) => envelope.split(':')[1])).size, 8);
});

test('wrong key or owner/provider/base URL context cannot decrypt', async () => {
  const masterKey = fakeMasterKey();
  const envelope = await encryptSecret(FAKE_SECRET, masterKey, CONTEXT);
  await assert.rejects(decryptSecret(envelope, fakeMasterKey(), CONTEXT), { message: 'Could not open SMS credentials.' });
  for (const otherContext of [
    CONTEXT.replace('fixture-owner', 'other-owner'),
    CONTEXT.replace('provider:termii', 'provider:other'),
    CONTEXT.replace('api.ng.termii.com', 'api.termii.com'),
  ]) {
    await assert.rejects(decryptSecret(envelope, masterKey, otherContext), { message: 'Could not open SMS credentials.' });
  }
});

test('ciphertext or IV modification fails authentication', async () => {
  const masterKey = fakeMasterKey();
  const envelope = await encryptSecret(FAKE_SECRET, masterKey, CONTEXT);
  const parts = envelope.split(':');
  for (const index of [1, 2]) {
    const corrupt = [...parts];
    const bytes = Uint8Array.from(atob(corrupt[index]), (character) => character.charCodeAt(0));
    bytes[0] ^= 1;
    corrupt[index] = toBase64(bytes);
    await assert.rejects(decryptSecret(corrupt.join(':'), masterKey, CONTEXT), { message: 'Could not open SMS credentials.' });
  }
});

test('master keys require canonical standard base64 encoding of exactly 32 bytes', async () => {
  const key = fakeMasterKey();
  const noncanonicalPadBits = `${'A'.repeat(42)}B=`;
  const invalid: unknown[] = [
    null, undefined, '', {}, 123, 'password', key.slice(0, -1), `${key}\n`, ` ${key}`,
    toBase64(new Uint8Array(31)), toBase64(new Uint8Array(33)),
    `${'_'.repeat(43)}=`, `${'-'.repeat(43)}=`, noncanonicalPadBits,
    `${key}=`, `${'A'.repeat(4096)}=`,
  ];
  for (const value of invalid) {
    assert.equal(isEncryptionKeyReady(value), false);
    await assert.rejects(encryptSecret(FAKE_SECRET, value as string, CONTEXT), { message: 'Could not protect SMS credentials.' });
  }
  const envelope = await encryptSecret(FAKE_SECRET, key, CONTEXT);
  await assert.rejects(decryptSecret(envelope, 'not-a-key', CONTEXT), { message: 'Could not open SMS credentials.' });
});

test('unsupported versions and malformed, truncated, or oversized envelopes are rejected', async () => {
  const masterKey = fakeMasterKey();
  const envelope = await encryptSecret(FAKE_SECRET, masterKey, CONTEXT);
  const [, iv, ciphertext] = envelope.split(':');
  for (const invalid of [
    '', 'v2:' + iv + ':' + ciphertext, 'v1', envelope + ':extra',
    'v1::' + ciphertext, 'v1:' + toBase64(new Uint8Array(11)) + ':' + ciphertext,
    'v1:' + iv + ':' + ciphertext.slice(0, -4),
    'v1:' + iv + ':' + toBase64(new Uint8Array(16)),
    'v1:' + iv + ':' + toBase64(new Uint8Array(4113)),
    'v1:' + iv + ':' + '_'.repeat(5000),
    'v1:' + iv + ':' + ciphertext + '\n',
  ]) {
    await assert.rejects(decryptSecret(invalid, masterKey, CONTEXT), { message: 'Could not open SMS credentials.' });
  }
});

test('UTF-8 secret and context limits are enforced in bytes', async () => {
  const masterKey = fakeMasterKey();
  const maximumSecret = '🙂'.repeat(1024);
  const maximumContext = '🙂'.repeat(256);
  const envelope = await encryptSecret(maximumSecret, masterKey, maximumContext);
  assert.equal(await decryptSecret(envelope, masterKey, maximumContext), maximumSecret);
  for (const invalidSecret of ['', 'a'.repeat(4097), '🙂'.repeat(1025), '\uD800']) {
    await assert.rejects(encryptSecret(invalidSecret, masterKey, CONTEXT), { message: 'Could not protect SMS credentials.' });
  }
  for (const invalidContext of ['', 'a'.repeat(1025), '🙂'.repeat(257), '\uD800']) {
    await assert.rejects(encryptSecret(FAKE_SECRET, masterKey, invalidContext), { message: 'Could not protect SMS credentials.' });
    await assert.rejects(decryptSecret(envelope, masterKey, invalidContext), { message: 'Could not open SMS credentials.' });
  }
});

test('envelopes contain no plaintext or master key, and errors disclose no supplied values', async () => {
  const masterKey = fakeMasterKey();
  const envelope = await encryptSecret(FAKE_SECRET, masterKey, CONTEXT);
  assert.equal(envelope.includes(FAKE_SECRET), false);
  assert.equal(envelope.includes(masterKey), false);
  assert.equal(atob(envelope.split(':')[2]).includes(FAKE_SECRET), false);
  await assert.rejects(decryptSecret(FAKE_SECRET, masterKey, CONTEXT), (error: Error) => {
    assert.equal(error.message, 'Could not open SMS credentials.');
    assert.equal(error.message.includes(FAKE_SECRET), false);
    assert.equal(error.message.includes(masterKey), false);
    assert.equal('cause' in error, false);
    return true;
  });
});
