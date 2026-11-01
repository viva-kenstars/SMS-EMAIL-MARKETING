import { getProviderState, readProviderConfig, ProviderSettingsError } from "./provider-settings";
import { getBalance, getSenderIds, requestSenderId, validateSenderIdRequest, ProviderError } from "./termii";
import { validateSenderId } from "./sms";

type Row = Record<string, any>;
const changedConnection = () => new ProviderSettingsError("The API connection changed. Refresh and use the sender IDs from the current account.", 409, "provider_revision_conflict");

async function account(db: D1Database, owner: string, expected?: unknown) {
  const provider = await getProviderState(db, owner, { senderApproved: false });
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== provider.credentialRevision)) throw changedConnection();
  const config = await readProviderConfig(db, owner, false, provider.revision);
  return { provider, config };
}

type Account = Awaited<ReturnType<typeof account>>;
async function isCurrent(db: D1Database, owner: string, context: Account) {
  const current = await getProviderState(db, owner, { senderApproved: false });
  return current.configured && current.credentialRevision === context.provider.credentialRevision && current.baseUrl === context.provider.baseUrl;
}

async function requireCurrent(db: D1Database, owner: string, context: Account) {
  if (!await isCurrent(db, owner, context)) throw changedConnection();
}

export async function dashboardBalance(db: D1Database, owner: string) {
  const context = await account(db, owner);
  const balance = await getBalance(context.config);
  await requireCurrent(db, owner, context);
  // A dashboard read neither enables sending nor changes connection verification.
  return { ...balance, fetchedAt: Date.now(), credentialRevision: context.provider.credentialRevision };
}

export async function senderIdsForAccount(db: D1Database, owner: string) {
  const context = await account(db, owner);
  const startedAt = Date.now();
  const result = await getSenderIds(context.config);
  await requireCurrent(db, owner, context);
  let senderApprovalRevoked = false;
  const selected = await db.prepare("SELECT sender_id,sender_verified_at FROM settings WHERE owner = ? AND sender_approved = 1 AND sender_approval_source = 'termii' AND sender_credential_revision = ?").bind(owner, context.provider.credentialRevision).first<Row>();
  if (selected) {
    const matches = result.senderIds.filter(row => row.senderId === selected.sender_id && row.country.toLowerCase() === "nigeria");
    // Explicit inactive records are evidence; absence from a partial page is not.
    const inactive = matches.length ? matches.some(row => row.status !== "active") : result.complete;
    if (inactive) {
      const revoked = await db.prepare("UPDATE settings SET sender_approved = 0,updated_at = ? WHERE owner = ? AND sender_id = ? AND sender_approval_source = 'termii' AND sender_credential_revision = ? AND sender_approved = 1 AND sender_verified_at <= ?").bind(Date.now(), owner, selected.sender_id, context.provider.credentialRevision, startedAt).run();
      senderApprovalRevoked = revoked.meta.changes === 1;
      if (senderApprovalRevoked) {
        await db.prepare("UPDATE provider_settings SET live_enabled = 0,revision = revision + 1,updated_at = ? WHERE owner = ? AND credential_revision = ? AND live_enabled = 1").bind(Date.now(), owner, context.provider.credentialRevision).run();
        await db.prepare("UPDATE sms_routing SET active_provider=NULL,active_credential_revision=NULL,revision=revision+1,updated_at=? WHERE owner=? AND active_provider='termii' AND active_credential_revision=?").bind(Date.now(), owner, context.provider.credentialRevision).run();
      }
    }
  }
  const requests = await db.prepare("SELECT sender_id,status,reason,created_at FROM sender_id_requests WHERE owner = ? AND credential_revision = ? ORDER BY updated_at DESC LIMIT 50").bind(owner, context.provider.credentialRevision).all<Row>();
  await requireCurrent(db, owner, context);
  return {
    ...result, fetchedAt: Date.now(), credentialRevision: context.provider.credentialRevision, senderApprovalRevoked,
    requests: requests.results.map(row => ({ senderId: row.sender_id, status: row.status, reason: row.reason, requestedAt: row.created_at })),
  };
}

export async function selectApprovedSenderId(db: D1Database, owner: string, body: Row) {
  if (!Number.isSafeInteger(body.credentialRevision)) throw changedConnection();
  const sender = typeof body.senderId === "string" ? body.senderId.trim() : "";
  if (!validateSenderId(sender)) throw new ProviderSettingsError("Choose a branded sender ID containing 3–11 letters, numbers or spaces, including a letter.");
  const context = await account(db, owner, body.credentialRevision);
  const result = await getSenderIds(context.config);
  await requireCurrent(db, owner, context);
  const matches = result.senderIds.filter(row => row.senderId === sender && row.country.toLowerCase() === "nigeria");
  if (!matches.length || matches.some(row => row.status !== "active")) {
    throw new ProviderSettingsError("Termii has not confirmed this sender ID as active for Nigeria. Refresh the list or check its approval in Termii.", 409, "sender_not_active");
  }
  const now = Date.now(), revision = context.provider.credentialRevision;
  // Check the credential generation inside the write, so a replaced account
  // cannot inherit an approval returned by an earlier in-flight lookup.
  const selected = await db.prepare(`INSERT INTO settings (owner,sender_id,sender_approved,sender_approval_source,sender_credential_revision,sender_verified_at,rate_per_segment,transactional_enabled,updated_at)
    SELECT ?,?,1,'termii',?,?,NULL,0,? WHERE
      (? = 0 AND NOT EXISTS (SELECT 1 FROM provider_settings WHERE owner = ?))
      OR EXISTS (SELECT 1 FROM provider_settings WHERE owner = ? AND credential_revision = ? AND base_url = ? AND api_key_ciphertext IS NOT NULL)
    ON CONFLICT(owner) DO UPDATE SET sender_id=excluded.sender_id,sender_approved=1,sender_approval_source='termii',sender_credential_revision=excluded.sender_credential_revision,sender_verified_at=excluded.sender_verified_at,updated_at=excluded.updated_at`)
    .bind(owner, sender, revision, now, now, revision, owner, owner, revision, context.provider.baseUrl).run();
  if (selected.meta.changes !== 1) throw changedConnection();
}

export async function submitSenderIdRequest(db: D1Database, owner: string, body: Row) {
  if (!Number.isSafeInteger(body.credentialRevision)) throw changedConnection();
  let input;
  try { input = validateSenderIdRequest(body); }
  catch (error) {
    if (error instanceof ProviderError) throw new ProviderSettingsError(error.message, 400, "sender_request_invalid");
    throw error;
  }
  const context = await account(db, owner, body.credentialRevision);
  const revision = context.provider.credentialRevision, senderKey = input.senderId.toLowerCase();
  const existing = await db.prepare("SELECT status FROM sender_id_requests WHERE owner = ? AND credential_revision = ? AND sender_key = ?").bind(owner, revision, senderKey).first<Row>();
  if (existing && existing.status !== "rejected") {
    throw new ProviderSettingsError("A request for this sender ID is already submitted or awaiting confirmation. Refresh the sender list and check Termii before requesting it again.", 409, "sender_request_exists");
  }
  // Prevent a new registration when this account already has the sender.
  const listed = await getSenderIds(context.config);
  if (listed.senderIds.some(row => row.senderId.toLowerCase() === senderKey && row.country.toLowerCase() === "nigeria")) {
    throw new ProviderSettingsError("This sender ID is already listed in your Termii account. Use the active ID or review its existing approval status.", 409, "sender_already_registered");
  }
  await requireCurrent(db, owner, context);
  const now = Date.now();
  const claim = await db.prepare(`INSERT INTO sender_id_requests (id,owner,credential_revision,sender_id,sender_key,status,reason,created_at,updated_at)
    VALUES (?,?,?,?,?,'submitting',NULL,?,?)
    ON CONFLICT(owner,credential_revision,sender_key) DO UPDATE SET status='submitting',reason=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE sender_id_requests.status='rejected'`)
    .bind(crypto.randomUUID(), owner, revision, input.senderId, senderKey, now, now).run();
  if (claim.meta.changes !== 1) throw new ProviderSettingsError("A request for this sender ID is already in progress. Refresh the sender list before trying again.", 409, "sender_request_exists");
  try {
    await requireCurrent(db, owner, context);
    await requestSenderId(context.config, input);
  } catch (error) {
    const rejected = error instanceof ProviderSettingsError || error instanceof ProviderError && error.outcome === "rejected";
    const reason = error instanceof ProviderError || error instanceof ProviderSettingsError ? error.message : "The sender ID request could not be confirmed. Check the sender list in Termii before submitting again.";
    await db.prepare("UPDATE sender_id_requests SET status = ?,reason = ?,updated_at = ? WHERE owner = ? AND credential_revision = ? AND sender_key = ? AND status = 'submitting'").bind(rejected ? "rejected" : "unknown", reason, Date.now(), owner, revision, senderKey).run();
    throw error;
  }
  await db.prepare("UPDATE sender_id_requests SET status = 'pending',updated_at = ? WHERE owner = ? AND credential_revision = ? AND sender_key = ? AND status = 'submitting'").bind(Date.now(), owner, revision, senderKey).run();
  return { submitted: true, status: "pending", senderId: input.senderId, requestedAt: now, credentialRevision: revision, connectionChanged: !await isCurrent(db, owner, context) };
}
