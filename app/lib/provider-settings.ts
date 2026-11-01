import { env } from "cloudflare:workers";
import { decryptSecret, encryptSecret, isEncryptionKeyReady } from "./secret-store";
import { getBalance, validateBaseUrl, ProviderError, type TermiiConfig } from "./termii";

type Row = Record<string, any>;
type SenderSettings = { senderApproved: boolean };
export class ProviderSettingsError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) { super(message); this.status = status; this.code = code; }
}

type Snapshot = {
  row: Row | null; baseUrl: string; apiKeyConfigured: boolean; baseUrlConfigured: boolean;
  liveEnabled: boolean; verifiedAt: number | null; revision: number; credentialRevision: number;
  source: "app" | "environment" | "none"; updatedAt: number | null;
};
const contextFor = (owner: string, baseUrl: string) => JSON.stringify(["trezad-sms", "termii", owner, baseUrl]);
const conflict = () => new ProviderSettingsError("These settings changed in another session. Refresh, review the latest values and save again.", 409, "provider_revision_conflict");
const masterKey = () => {
  if (!isEncryptionKeyReady(env.SMS_SETTINGS_ENCRYPTION_KEY)) throw new ProviderSettingsError("Secure API settings are temporarily unavailable. No credential was saved. Please contact the app administrator.", 503);
  return env.SMS_SETTINGS_ENCRYPTION_KEY!;
};

async function snapshot(db: D1Database, owner: string): Promise<Snapshot> {
  const row = await db.prepare("SELECT * FROM provider_settings WHERE owner = ?").bind(owner).first<Row>();
  const baseUrl = row ? row.base_url : env.TERMII_BASE_URL || "";
  let baseUrlConfigured = false;
  try { validateBaseUrl(baseUrl); baseUrlConfigured = true; } catch { /* Public status never contains a raw validation exception. */ }
  const apiKeyConfigured = row ? !!row.api_key_ciphertext : !!env.TERMII_API_KEY?.trim();
  return {
    row, baseUrl, apiKeyConfigured, baseUrlConfigured,
    liveEnabled: row ? !!row.live_enabled && !!row.verified_at : env.SMS_LIVE_ENABLED === "true",
    verifiedAt: row?.verified_at ?? null,
    revision: row?.revision ?? 0,
    credentialRevision: row ? row.credential_revision ?? 1 : 0,
    source: row ? "app" : apiKeyConfigured || baseUrl ? "environment" : "none",
    updatedAt: row?.updated_at ?? null,
  };
}

async function secretFrom(value: Snapshot, owner: string): Promise<string> {
  if (!value.apiKeyConfigured) throw new ProviderSettingsError("Save your Termii API key in Provider & settings first.", 409);
  if (!value.row) return env.TERMII_API_KEY!;
  try { return await decryptSecret(value.row.api_key_ciphertext, masterKey(), contextFor(owner, value.baseUrl)); }
  catch (error) {
    if (error instanceof ProviderSettingsError) throw error;
    throw new ProviderSettingsError("The saved API key could not be opened. Replace it in Provider & settings and test the connection again.", 409);
  }
}

function publicState(value: Snapshot, sender: SenderSettings) {
  const configurationAvailable = isEncryptionKeyReady(env.SMS_SETTINGS_ENCRYPTION_KEY);
  const configured = value.apiKeyConfigured && value.baseUrlConfigured && (!value.row || configurationAvailable);
  const liveEnabled = configured && value.liveEnabled;
  const readiness: string[] = [];
  if (!configurationAvailable) readiness.push("Secure API configuration is temporarily unavailable.");
  if (!value.apiKeyConfigured) readiness.push("Save your Termii API key in Provider & settings.");
  if (!value.baseUrlConfigured) readiness.push("Enter the account-specific HTTPS base URL from your Termii dashboard.");
  if (configured && !value.verifiedAt) readiness.push("Test the saved connection to verify account access.");
  if (!sender.senderApproved) readiness.push("Confirm the sender ID approved by Termii.");
  if (!liveEnabled) readiness.push("Enable live sending after verifying the connection and sender ID.");
  return {
    name: "Termii", configured, apiKeyConfigured: value.apiKeyConfigured,
    baseUrlConfigured: value.baseUrlConfigured, liveEnabled, readiness,
    baseUrl: value.baseUrl, configurationAvailable, verifiedAt: value.verifiedAt,
    revision: value.revision, credentialRevision: value.credentialRevision, source: value.source, updatedAt: value.updatedAt,
  };
}

export async function getProviderState(db: D1Database, owner: string, sender: SenderSettings) {
  return publicState(await snapshot(db, owner), sender);
}

export async function readProviderConfig(db: D1Database, owner: string, requireLive = false, expectedRevision?: number): Promise<TermiiConfig> {
  const value = await snapshot(db, owner);
  if (expectedRevision !== undefined && value.revision !== expectedRevision) throw new ProviderSettingsError("The API settings changed. Review and enable the current connection before sending.", 409);
  // Read the activation gate and its credentials from the same saved revision.
  if (requireLive && !value.liveEnabled) throw new ProviderSettingsError("Live sending is not active. Complete the Termii connection in Provider & settings.", 409);
  if (!value.baseUrlConfigured) throw new ProviderSettingsError("Save the account-specific HTTPS base URL from your Termii dashboard first.", 409);
  return { apiKey: await secretFrom(value, owner), baseUrl: validateBaseUrl(value.baseUrl) };
}

function assertRevision(body: Row, current: Snapshot) {
  if (!Number.isSafeInteger(body.revision) || body.revision !== current.revision) throw conflict();
}

export async function saveProviderSettings(db: D1Database, owner: string, body: Row, sender: SenderSettings) {
  const encryptionKey = masterKey();
  const previous = await snapshot(db, owner);
  assertRevision(body, previous);
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new ProviderSettingsError("Enter a valid API key, or leave the field blank to keep the saved key.");
  if (body.baseUrl !== undefined && typeof body.baseUrl !== "string") throw new ProviderSettingsError("Enter the HTTPS base URL shown on your Termii dashboard.");
  if (body.liveEnabled !== undefined && typeof body.liveEnabled !== "boolean") throw new ProviderSettingsError("Choose whether live sending is enabled.");
  const enteredKey = (body.apiKey || "").trim();
  if (enteredKey && (enteredKey.length < 8 || enteredKey.length > 4096 || !/^[\x21-\x7E]+$/.test(enteredKey))) throw new ProviderSettingsError("Paste the complete API key without spaces or line breaks.");
  const candidateUrl = body.baseUrl === undefined ? previous.baseUrl : body.baseUrl.trim();
  let baseUrl = "";
  if (candidateUrl) {
    try { baseUrl = validateBaseUrl(candidateUrl); }
    catch { throw new ProviderSettingsError("Use only the HTTPS API base URL from your Termii dashboard, without an /api path."); }
  }
  const hasKey = !!enteredKey || previous.apiKeyConfigured;
  if (hasKey && !baseUrl) throw new ProviderSettingsError("Enter your account-specific API base URL before saving a key.");
  // Re-entering the saved key is a common setup action, not a new account.
  // Preserve its verification, approved sender and pinned campaigns when the
  // actual credentials are unchanged. A replacement can also repair a key
  // that can no longer be decrypted, without treating it as already verified.
  let keyChanged = !!enteredKey;
  if (enteredKey && previous.apiKeyConfigured) {
    try { keyChanged = enteredKey !== await secretFrom(previous, owner); }
    catch { keyChanged = true; }
  }
  const credentialsChanged = keyChanged || baseUrl !== previous.baseUrl || (!previous.row && previous.apiKeyConfigured);
  let ciphertext: string | null = previous.row?.api_key_ciphertext ?? null;
  if (hasKey && (credentialsChanged || !ciphertext)) {
    const secret = enteredKey || await secretFrom(previous, owner);
    ciphertext = await encryptSecret(secret, encryptionKey, contextFor(owner, baseUrl));
  }
  const verifiedAt = credentialsChanged ? null : previous.verifiedAt;
  let liveEnabled = credentialsChanged ? false : previous.liveEnabled;
  if (body.liveEnabled !== undefined) liveEnabled = body.liveEnabled;
  if (liveEnabled && (!ciphertext || !baseUrl || !verifiedAt)) throw new ProviderSettingsError("Save and successfully test the API connection before enabling live sending.", 409);
  if (liveEnabled && !sender.senderApproved) throw new ProviderSettingsError("Save your approved sender ID before enabling live sending.", 409);
  const now = Date.now(), revision = previous.revision + 1;
  // Channel activation changes keep the credential generation stable. WhatsApp
  // can use this generation without depending on the independent SMS switch.
  const credentialRevision = previous.row ? previous.credentialRevision + Number(credentialsChanged) : 1;
  const result = previous.row
    ? await db.prepare("UPDATE provider_settings SET api_key_ciphertext = ?, base_url = ?, live_enabled = ?, verified_at = ?, revision = ?, credential_revision = ?, updated_at = ? WHERE owner = ? AND revision = ?").bind(ciphertext, baseUrl, Number(liveEnabled), verifiedAt, revision, credentialRevision, now, owner, previous.revision).run()
    : await db.prepare("INSERT INTO provider_settings (owner,api_key_ciphertext,base_url,live_enabled,verified_at,revision,credential_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO NOTHING").bind(owner, ciphertext, baseUrl, Number(liveEnabled), verifiedAt, revision, credentialRevision, now, now).run();
  if (result.meta.changes !== 1) throw conflict();
  return { provider: await getProviderState(db, owner, sender) };
}

export async function removeProviderSettings(db: D1Database, owner: string, body: Row, sender: SenderSettings) {
  const previous = await snapshot(db, owner);
  assertRevision(body, previous);
  const now = Date.now();
  // Keep an explicit disconnected record, so legacy environment credentials never reappear after removal.
  const result = previous.row
    ? await db.prepare("UPDATE provider_settings SET api_key_ciphertext = NULL, base_url = '', live_enabled = 0, verified_at = NULL, revision = ?, credential_revision = ?, updated_at = ? WHERE owner = ? AND revision = ?").bind(previous.revision + 1, previous.credentialRevision + 1, now, owner, previous.revision).run()
    : await db.prepare("INSERT INTO provider_settings (owner,api_key_ciphertext,base_url,live_enabled,verified_at,revision,created_at,updated_at) VALUES (?,NULL,'',0,NULL,1,?,?) ON CONFLICT(owner) DO NOTHING").bind(owner, now, now).run();
  if (result.meta.changes !== 1) throw conflict();
  return { provider: await getProviderState(db, owner, sender) };
}

export async function checkProviderConnection(db: D1Database, owner: string, sender: SenderSettings) {
  const previous = await snapshot(db, owner);
  if (!previous.baseUrlConfigured) throw new ProviderSettingsError("Save your API base URL and key before testing the connection.", 409);
  const secret = await secretFrom(previous, owner);
  // This endpoint only reads the provider balance. It cannot submit an SMS.
  let balance;
  try { balance = await getBalance({ apiKey: secret, baseUrl: validateBaseUrl(previous.baseUrl) }); }
  catch (error) {
    // A definitive credential rejection cannot leave an older successful test
    // eligible for activation. Transient failures and service-specific 403s do
    // not establish that the account credentials themselves are invalid.
    if (error instanceof ProviderError && error.upstreamStatus === 401) {
      const now = Date.now();
      if (previous.row) {
        await db.prepare("UPDATE provider_settings SET verified_at=NULL,live_enabled=0,revision=revision+1,updated_at=? WHERE owner=? AND revision=? AND credential_revision=? AND verified_at IS ? AND (verified_at IS NOT NULL OR live_enabled=1)")
          .bind(now, owner, previous.revision, previous.credentialRevision, previous.verifiedAt).run();
      } else if (previous.liveEnabled) {
        const ciphertext = await encryptSecret(secret, masterKey(), contextFor(owner, previous.baseUrl));
        await db.prepare("INSERT INTO provider_settings (owner,api_key_ciphertext,base_url,live_enabled,verified_at,revision,credential_revision,created_at,updated_at) VALUES (?,?,?,0,NULL,1,1,?,?) ON CONFLICT(owner) DO NOTHING")
          .bind(owner, ciphertext, previous.baseUrl, now, now).run();
      }
    }
    throw error;
  }
  const now = Date.now();
  let changes: number;
  if (previous.row) {
    const result = await db.prepare("UPDATE provider_settings SET verified_at = ?, updated_at = ? WHERE owner = ? AND revision = ?").bind(now, now, owner, previous.revision).run();
    changes = result.meta.changes;
  } else {
    const ciphertext = await encryptSecret(secret, masterKey(), contextFor(owner, previous.baseUrl));
    const result = await db.prepare("INSERT INTO provider_settings (owner,api_key_ciphertext,base_url,live_enabled,verified_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(owner) DO NOTHING").bind(owner, ciphertext, previous.baseUrl, Number(previous.liveEnabled), now, now, now).run();
    changes = result.meta.changes;
  }
  if (changes !== 1) throw new ProviderSettingsError("The API settings changed while the connection was being checked. Test the newly saved settings again.", 409, "provider_revision_conflict");
  const provider = await getProviderState(db, owner, sender);
  const checkedCredentialRevision = previous.row ? previous.credentialRevision : 1;
  if (!provider.configured || provider.credentialRevision !== checkedCredentialRevision || provider.baseUrl !== previous.baseUrl || !provider.verifiedAt) {
    throw new ProviderSettingsError("The API settings changed while the connection was being checked. Test the newly saved settings again.", 409, "provider_revision_conflict");
  }
  return { ...balance, fetchedAt: now, credentialRevision: provider.credentialRevision, connected: true, provider };
}
