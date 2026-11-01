import { env } from "cloudflare:workers";
import { SMS_PROVIDERS, getSmsProviderDefinition, validSmsSender, type SmsProviderId, type SmsProviderState, type SmsProviderDefinition } from "./sms-provider-catalog";
import { getProviderState, readProviderConfig, checkProviderConnection, ProviderSettingsError } from "./provider-settings";
import { dashboardBalance } from "./provider-account";
import { decryptSecret, encryptSecret, isEncryptionKeyReady } from "./secret-store";
import { smsAdapter } from "./sms-providers";
import type { SmsCredentials } from "./sms-providers/types";
import { ProviderError } from "./termii";

type Row = Record<string, any>;
type Sender = { senderId: string; senderApproved: boolean; ratePerSegment: number | null; transactionalEnabled: boolean };
const conflict = () => new ProviderSettingsError("The provider settings changed. Refresh and review the latest connection before continuing.", 409, "provider_revision_conflict");
const context = (owner: string, provider: string) => JSON.stringify(["trezad-sms", "sms-provider", owner, provider]);
const encryptionKey = () => {
  if (!isEncryptionKeyReady(env.SMS_SETTINGS_ENCRYPTION_KEY)) throw new ProviderSettingsError("Secure API configuration is temporarily unavailable. No credential was saved.", 503);
  return env.SMS_SETTINGS_ENCRYPTION_KEY!;
};
function providerDefinition(id: unknown) {
  const definition = getSmsProviderDefinition(id);
  if (!definition) throw new ProviderSettingsError("Choose one of the supported SMS providers.", 404);
  return definition;
}
function object(value: string | null | undefined): Row {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
async function termiiSender(db: D1Database, owner: string): Promise<Sender> {
  const row = await db.prepare("SELECT s.*,p.credential_revision AS current_credential_revision FROM settings s LEFT JOIN provider_settings p ON p.owner=s.owner WHERE s.owner=?").bind(owner).first<Row>();
  return { senderId: row?.sender_id || "Trezad", senderApproved: !!row?.sender_approved && (row?.sender_approval_source !== "termii" || row.sender_credential_revision === (row.current_credential_revision ?? 0)), ratePerSegment: row?.rate_per_segment ?? null, transactionalEnabled: !!row?.transactional_enabled };
}

type LegacyProvider = Awaited<ReturnType<typeof getProviderState>>;
function publicSmsProvider(definition: SmsProviderDefinition, row: Row | null | undefined, termii?: LegacyProvider, settings?: Sender): SmsProviderState {
  const available = isEncryptionKeyReady(env.SMS_SETTINGS_ENCRYPTION_KEY);
  const fields = termii ? { apiKey: termii.apiKeyConfigured, baseUrl: termii.baseUrlConfigured } : object(row?.configured_fields);
  const publicValues = termii ? { baseUrl: termii.baseUrl } : object(row?.public_values);
  const configured = termii ? termii.configured : !!row?.credentials_ciphertext && available && definition.fields.every(field => fields[field.key] === true);
  const verifiedAt = termii ? termii.verifiedAt : row?.verified_at ?? null;
  const senderId = settings ? settings.senderId : row?.sender_id || (definition.id === "sendchamp" ? "Sendchamp" : "");
  const senderApproved = settings ? settings.senderApproved : !!row?.sender_approved;
  const readiness: string[] = [];
  if (!available) readiness.push("Secure API configuration is temporarily unavailable.");
  if (!configured) readiness.push(`Save the ${definition.name} credentials.`);
  if (configured && !verifiedAt) readiness.push("Verify the saved connection.");
  if (!validSmsSender(definition.id, senderId)) readiness.push("Save a valid sender name or permitted sending number.");
  if (!senderApproved) readiness.push(definition.id === "termii" ? "Choose an active Nigerian sender ID from Termii, or confirm an already approved sender in setup." : `Confirm this sender is permitted by ${definition.name}.`);
  return { ...definition, configured, credentialsConfigured: Object.fromEntries(definition.fields.map(field => [field.key, fields[field.key] === true])), publicValues,
    configurationAvailable: available, verifiedAt, revision: termii ? termii.revision : row?.revision ?? 0,
    credentialRevision: termii ? termii.credentialRevision : row?.credential_revision ?? 0,
    senderId, senderApproved, ratePerSegment: settings ? settings.ratePerSegment : row?.rate_per_segment ?? null,
    transactionalEnabled: settings ? settings.transactionalEnabled : false, isActive: false, readiness };
}

function applyActiveRouting(provider: SmsProviderState, routing: Row | null, legacyLive = false) {
  const selected = routing ? routing.active_provider : legacyLive ? "termii" : null;
  const legacyActive = !routing && provider.id === "termii" && legacyLive;
  provider.isActive = selected === provider.id && provider.configured && provider.senderApproved && validSmsSender(provider.id, provider.senderId)
    && (!!provider.verifiedAt || legacyActive) && (!routing || routing.active_credential_revision === provider.credentialRevision);
  return provider;
}

export async function getSmsProviderDirectory(db: D1Database, owner: string, sender?: Sender, legacyProvider?: Awaited<ReturnType<typeof getProviderState>>) {
  const [rows, routing, settings] = await Promise.all([
    db.prepare("SELECT * FROM sms_provider_accounts WHERE owner=?").bind(owner).all<Row>(),
    db.prepare("SELECT * FROM sms_routing WHERE owner=?").bind(owner).first<Row>(),
    sender ? Promise.resolve(sender) : termiiSender(db, owner),
  ]);
  const termii = legacyProvider || await getProviderState(db, owner, settings);
  const smsProviders: SmsProviderState[] = SMS_PROVIDERS.map(definition => {
    const row = rows.results.find(row => row.provider === definition.id);
    return applyActiveRouting(publicSmsProvider(definition, row, definition.id === "termii" ? termii : undefined, definition.id === "termii" ? settings : undefined), routing, termii.liveEnabled);
  });
  // Existing environment-backed Termii activation remains usable until the user
  // makes an explicit routing choice. All new activations require a balance test.
  return { smsProviders, activeSmsProviderId: smsProviders.find(provider => provider.isActive)?.id ?? null, smsRoutingRevision: routing?.revision ?? 0 };
}

async function smsAccountSnapshot(db: D1Database, owner: string, id: unknown) {
  const definition = providerDefinition(id);
  if (definition.id === "termii") {
    const [sender, routing] = await Promise.all([
      termiiSender(db, owner),
      db.prepare("SELECT * FROM sms_routing WHERE owner=?").bind(owner).first<Row>(),
    ]);
    const termii = await getProviderState(db, owner, sender);
    return { provider: applyActiveRouting(publicSmsProvider(definition, null, termii, sender), routing, termii.liveEnabled), row: null };
  }
  // Read only the selected provider and its routing gate. Both come from one
  // database snapshot, without loading/decrypting unrelated provider accounts.
  const row = await db.prepare(`SELECT a.*,r.active_provider AS routing_active_provider,r.active_credential_revision AS routing_credential_revision,r.revision AS routing_revision
    FROM (SELECT ? AS owner) o LEFT JOIN sms_provider_accounts a ON a.owner=o.owner AND a.provider=? LEFT JOIN sms_routing r ON r.owner=o.owner`)
    .bind(owner, definition.id).first<Row>();
  const routing = row?.routing_revision == null ? null : { active_provider: row.routing_active_provider, active_credential_revision: row.routing_credential_revision };
  return { provider: applyActiveRouting(publicSmsProvider(definition, row), routing), row };
}

export async function getSmsProvider(db: D1Database, owner: string, id: unknown) {
  return (await smsAccountSnapshot(db, owner, id)).provider;
}

async function decryptCredentials(row: Row | null, owner: string, provider: string): Promise<SmsCredentials> {
  if (!row?.credentials_ciphertext) return {};
  try { return JSON.parse(await decryptSecret(row.credentials_ciphertext, encryptionKey(), context(owner, provider))); }
  catch (error) {
    if (error instanceof ProviderSettingsError) throw error;
    throw new ProviderSettingsError("The saved credentials could not be opened. Remove this connection and save its credentials again.", 409);
  }
}
export async function readSmsConnection(db: D1Database, owner: string, id: SmsProviderId, expectedCredentialRevision?: number) {
  const { provider, row } = await smsAccountSnapshot(db, owner, id);
  if (!provider.configured) throw new ProviderSettingsError(`Save the ${provider.name} credentials before continuing.`, 409);
  if (expectedCredentialRevision !== undefined && provider.credentialRevision !== expectedCredentialRevision) throw conflict();
  if (id === "termii") {
    const credentials = await readProviderConfig(db, owner, false, provider.revision);
    return { provider, credentials: { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl } as SmsCredentials };
  }
  if (!row || row.revision !== provider.revision || row.credential_revision !== provider.credentialRevision) throw conflict();
  return { provider, credentials: await decryptCredentials(row, owner, id) };
}

export async function saveSmsProvider(db: D1Database, owner: string, id: unknown, body: Row) {
  const definition = providerDefinition(id);
  if (definition.id === "termii") throw new ProviderSettingsError("Use the Termii connection and sender settings to update this provider.", 400);
  const key = encryptionKey();
  const previous = await db.prepare("SELECT * FROM sms_provider_accounts WHERE owner=? AND provider=?").bind(owner, definition.id).first<Row>();
  if (!Number.isSafeInteger(body.revision) || body.revision !== (previous?.revision ?? 0)) throw conflict();
  if (body.credentials !== undefined && (!body.credentials || typeof body.credentials !== "object" || Array.isArray(body.credentials))) throw new ProviderSettingsError("Enter valid API credentials.");
  const supplied = body.credentials || {};
  if (Object.keys(supplied).some(key => !definition.fields.some(field => field.key === key))) throw new ProviderSettingsError("The credential fields do not match this provider.");
  const original = await decryptCredentials(previous, owner, definition.id);
  const credentials = { ...original };
  for (const field of definition.fields) {
    if (supplied[field.key] !== undefined && typeof supplied[field.key] !== "string") throw new ProviderSettingsError(`Enter a valid ${field.label}.`);
    const value = supplied[field.key]?.trim();
    if (value && (value.length > 1500 || !/^[\x21-\x7e]+$/.test(value))) throw new ProviderSettingsError(`Paste the complete ${field.label} without spaces or line breaks.`);
    if (value) credentials[field.key] = value;
  }
  if (definition.id === "twilio" && credentials.accountSid && !/^AC[0-9a-f]{32}$/i.test(credentials.accountSid)) throw new ProviderSettingsError("Enter the Account SID beginning with AC followed by 32 hexadecimal characters.");
  if (definition.id === "africastalking" && credentials.username?.toLowerCase() === "sandbox") throw new ProviderSettingsError("Use a live Africa’s Talking application username. Sandbox credentials cannot activate live SMS.");
  const changed = definition.fields.some(field => credentials[field.key] !== original[field.key]);
  const senderId = body.senderId === undefined ? previous?.sender_id || (definition.id === "sendchamp" ? "Sendchamp" : "") : typeof body.senderId === "string" ? body.senderId.trim() : "";
  if (senderId && !validSmsSender(definition.id, senderId)) throw new ProviderSettingsError(definition.senderType === "flexible" ? "Enter a permitted sender name (3–11 letters, digits or spaces) or a phone number in +international format." : definition.id === "bulksmsnigeria" ? "Enter a sender name of 1–11 letters or digits, including a letter, without spaces." : "Enter a sender name of 3–11 letters, digits or spaces, including a letter.");
  if (body.senderApproved !== undefined && typeof body.senderApproved !== "boolean") throw new ProviderSettingsError("Confirm whether this sender is permitted by the provider.");
  if (body.transactionalEnabled === true) throw new ProviderSettingsError("This integration uses the provider’s standard route. It does not enable a separate DND route.");
  const senderChanged = senderId !== previous?.sender_id;
  const senderApproved = !!senderId && (changed && !!previous?.credentials_ciphertext ? false : body.senderApproved ?? (!senderChanged && !!previous?.sender_approved));
  const rate = body.ratePerSegment === "" || body.ratePerSegment === null ? null : body.ratePerSegment ?? previous?.rate_per_segment ?? null;
  if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 10000)) throw new ProviderSettingsError("Enter a valid naira estimate per SMS segment, or leave it blank.");
  const credentialRevision = previous ? previous.credential_revision + Number(changed) : 1;
  const ciphertext = Object.keys(credentials).length ? changed || !previous?.credentials_ciphertext ? await encryptSecret(JSON.stringify(credentials), key, context(owner, definition.id)) : previous.credentials_ciphertext : null;
  const publicValues = Object.fromEntries(definition.fields.filter(field => !field.secret).map(field => [field.key, credentials[field.key] || ""]));
  const configuredFields = Object.fromEntries(definition.fields.map(field => [field.key, !!credentials[field.key]]));
  const now = Date.now(), revision = (previous?.revision ?? 0) + 1;
  const values = [ciphertext, JSON.stringify(publicValues), JSON.stringify(configuredFields), changed ? null : previous?.verified_at ?? null, revision, credentialRevision, senderId, Number(senderApproved), rate, now];
  const result = previous
    ? await db.prepare("UPDATE sms_provider_accounts SET credentials_ciphertext=?,public_values=?,configured_fields=?,verified_at=?,revision=?,credential_revision=?,sender_id=?,sender_approved=?,rate_per_segment=?,updated_at=? WHERE owner=? AND provider=? AND revision=?").bind(...values, owner, definition.id, previous.revision).run()
    : await db.prepare("INSERT INTO sms_provider_accounts (credentials_ciphertext,public_values,configured_fields,verified_at,revision,credential_revision,sender_id,sender_approved,rate_per_segment,updated_at,owner,provider,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,provider) DO NOTHING").bind(...values, owner, definition.id, now).run();
  if (result.meta.changes !== 1) throw conflict();
  const directory = await getSmsProviderDirectory(db, owner);
  return { ...directory, provider: directory.smsProviders.find(provider => provider.id === definition.id) };
}

export async function removeSmsProvider(db: D1Database, owner: string, id: unknown, body: Row) {
  const definition = providerDefinition(id);
  if (definition.id === "termii") throw new ProviderSettingsError("Use the Termii connection settings to remove this shared SMS and WhatsApp connection.");
  const previous = await getSmsProvider(db, owner, definition.id);
  if (!Number.isSafeInteger(body.revision) || body.revision !== previous.revision) throw conflict();
  if (!previous.revision) return { ...await getSmsProviderDirectory(db, owner), removed: true };
  const result = await db.prepare("UPDATE sms_provider_accounts SET credentials_ciphertext=NULL,public_values='{}',configured_fields='{}',verified_at=NULL,sender_approved=0,revision=revision+1,credential_revision=credential_revision+1,updated_at=? WHERE owner=? AND provider=? AND revision=?").bind(Date.now(), owner, definition.id, previous.revision).run();
  if (result.meta.changes !== 1) throw conflict();
  return { ...await getSmsProviderDirectory(db, owner), removed: true };
}

export async function smsProviderBalance(db: D1Database, owner: string, id: unknown, check = false, expected?: unknown) {
  const definition = providerDefinition(id);
  const connection = await readSmsConnection(db, owner, definition.id);
  if (expected !== undefined && (!Number.isSafeInteger(expected) || connection.provider.credentialRevision !== expected)) throw conflict();
  let balance;
  if (definition.id === "termii") {
    balance = check ? await checkProviderConnection(db, owner, await termiiSender(db, owner)) : await dashboardBalance(db, owner);
    // The first verified legacy environment connection is persisted at generation 1.
    const current = await getSmsProvider(db, owner, definition.id);
    if (current.credentialRevision !== balance.credentialRevision) throw conflict();
    return { ...balance, providerId: definition.id, unit: "money" as const, provider: current };
  }
  try { balance = await smsAdapter(definition.id).balance(connection.credentials); }
  catch (error) {
    if (check && error instanceof ProviderError && error.upstreamStatus === 401) {
      // An explicit authentication failure invalidates only the verification
      // that was checked, never a replacement or a newer successful check.
      await db.prepare("UPDATE sms_provider_accounts SET verified_at=NULL,revision=revision+1,updated_at=? WHERE owner=? AND provider=? AND revision=? AND credential_revision=? AND verified_at IS ? AND verified_at IS NOT NULL")
        .bind(Date.now(), owner, definition.id, connection.provider.revision, connection.provider.credentialRevision, connection.provider.verifiedAt).run();
    }
    throw error;
  }
  const current = await getSmsProvider(db, owner, definition.id);
  if (!current.configured || current.credentialRevision !== connection.provider.credentialRevision) throw conflict();
  if (check) {
    const result = await db.prepare("UPDATE sms_provider_accounts SET verified_at=?,updated_at=? WHERE owner=? AND provider=? AND revision=? AND credential_revision=? AND credentials_ciphertext IS NOT NULL").bind(Date.now(), Date.now(), owner, definition.id, current.revision, connection.provider.credentialRevision).run();
    if (result.meta.changes !== 1) throw conflict();
  }
  const final = await getSmsProvider(db, owner, definition.id);
  if (!final.configured || final.credentialRevision !== connection.provider.credentialRevision) throw conflict();
  return { ...balance, providerId: definition.id, fetchedAt: Date.now(), credentialRevision: connection.provider.credentialRevision, ...(check ? { connected: true } : {}), provider: final };
}

export async function activateSmsProvider(db: D1Database, owner: string, body: Row) {
  if (!Number.isSafeInteger(body.routingRevision) || body.routingRevision < 0) throw conflict();
  const id = body.providerId === null ? null : providerDefinition(body.providerId).id;
  const directory = await getSmsProviderDirectory(db, owner);
  if (directory.smsRoutingRevision !== body.routingRevision) throw conflict();
  let accountCondition = "1=1", conditionValues: unknown[] = [];
  if (id) {
    const provider = directory.smsProviders.find(provider => provider.id === id)!;
    if (!Number.isSafeInteger(body.credentialRevision) || provider.credentialRevision !== body.credentialRevision) throw conflict();
    if (!provider.configured || !provider.verifiedAt || !provider.senderApproved || !validSmsSender(id, provider.senderId)) throw new ProviderSettingsError(`${provider.name} is not ready to activate. ${provider.readiness.join(" ")}`, 409, "provider_not_ready");
    if (id === "termii") {
      accountCondition = "EXISTS (SELECT 1 FROM provider_settings p JOIN settings s ON s.owner=p.owner WHERE p.owner=? AND p.credential_revision=? AND p.verified_at IS NOT NULL AND p.api_key_ciphertext IS NOT NULL AND s.sender_approved=1 AND s.sender_id=? AND (s.sender_approval_source IS NOT 'termii' OR s.sender_credential_revision=p.credential_revision))";
      conditionValues = [owner, provider.credentialRevision, provider.senderId];
    } else {
      accountCondition = "EXISTS (SELECT 1 FROM sms_provider_accounts WHERE owner=? AND provider=? AND credential_revision=? AND revision=? AND verified_at IS NOT NULL AND credentials_ciphertext IS NOT NULL AND sender_approved=1)";
      conditionValues = [owner, id, provider.credentialRevision, provider.revision];
    }
  }
  const now = Date.now();
  // A single row is the source of truth: selecting one provider replaces the
  // previous provider atomically, including concurrent browser sessions.
  const result = await db.prepare(`INSERT INTO sms_routing (owner,active_provider,active_credential_revision,revision,updated_at)
    SELECT ?,?,?,1,? WHERE ${accountCondition} AND (?=0 OR EXISTS (SELECT 1 FROM sms_routing WHERE owner=?))
    ON CONFLICT(owner) DO UPDATE SET active_provider=excluded.active_provider,active_credential_revision=excluded.active_credential_revision,revision=sms_routing.revision+1,updated_at=excluded.updated_at WHERE sms_routing.revision=?`)
    .bind(owner, id, id ? body.credentialRevision : null, now, ...conditionValues, body.routingRevision, owner, body.routingRevision).run();
  if (result.meta.changes !== 1) throw conflict();
  return getSmsProviderDirectory(db, owner);
}

export async function requireSmsCampaignConnection(db: D1Database, owner: string, campaign: Row) {
  const id = providerDefinition(campaign.sms_provider_id || "termii").id;
  if (campaign.sms_credential_revision === null || campaign.sms_credential_revision === undefined) throw new ProviderSettingsError("This older campaign has no recorded provider account version. Duplicate it and review the new draft before sending.", 409);
  const provider = await getSmsProvider(db, owner, id);
  if (!provider.isActive) throw new ProviderSettingsError(`Activate ${providerDefinition(id).name} to send this campaign, or create a new campaign for the active provider.`, 409);
  if (campaign.sms_credential_revision !== null && campaign.sms_credential_revision !== undefined && campaign.sms_credential_revision !== provider.credentialRevision) throw new ProviderSettingsError("This provider’s credentials changed after the campaign was created. Review a new draft before sending.", 409);
  if (!provider.senderApproved || campaign.sender_id !== provider.senderId) throw new ProviderSettingsError("The campaign sender must match the permitted sender saved for this provider. Review a new draft.", 409);
  if (campaign.channel === "dnd" && (!provider.supportsDnd || !provider.transactionalEnabled)) throw new ProviderSettingsError("This provider does not have an approved DND route enabled. Review a standard-route campaign or the provider’s route settings.", 409);
  const connection = await readSmsConnection(db, owner, id, provider.credentialRevision);
  if (connection.provider.revision !== provider.revision || !connection.provider.isActive || !connection.provider.senderApproved || connection.provider.senderId !== campaign.sender_id
    || campaign.channel === "dnd" && (!connection.provider.supportsDnd || !connection.provider.transactionalEnabled)) throw conflict();
  return connection;
}
