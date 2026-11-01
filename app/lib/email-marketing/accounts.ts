import { decryptSecret, encryptSecret, isEncryptionKeyReady } from "../secret-store";
import { accountContext, assertKey, conflict, cursorFor, cursorValue, day, email, integer, MarketingError, publicHost, relayContext, relayOrigin, text, type Context, type Row } from "./common";
import { checkAccount, checkRelay, type RelayConnection, type SmtpCredentials } from "./relay";
import type { MarketingSettings, SmtpAccount } from "./types";

export const settingsRow = (context: Pick<Context, "db" | "owner">) => context.db.prepare("SELECT * FROM marketing_settings WHERE owner=?").bind(context.owner).first<Row>();
export function settingsDto(row: Row | null, key?: string): MarketingSettings {
  return { relayUrl: row?.relay_url || "", relayConfigured: !!row?.relay_token_ciphertext && isEncryptionKeyReady(key), relayVerifiedAt: row?.relay_verified_at ?? null, postalAddress: row?.postal_address || "", revision: row?.revision || 0, configurationAvailable: isEncryptionKeyReady(key) };
}
export async function relayConnection(context: Context, row?: Row | null): Promise<RelayConnection> {
  assertKey(context.masterKey);
  const saved = row === undefined ? await settingsRow(context) : row;
  if (!saved?.relay_token_ciphertext) throw new MarketingError("Configure the SMTP service in Email marketing settings first.", 409);
  try { return { url: saved.relay_url, token: await decryptSecret(saved.relay_token_ciphertext, context.masterKey, relayContext(context.owner, saved.credential_revision)) }; }
  catch { throw new MarketingError("The saved SMTP service credential could not be opened. Replace and test it in settings.", 409); }
}
export async function saveSettings(context: Context, body: Row) {
  assertKey(context.masterKey);
  const previous = await settingsRow(context);
  if (body.revision !== (previous?.revision ?? 0)) throw conflict();
  const url = relayOrigin(body.relayUrl ?? previous?.relay_url);
  const rawPostal = body.postalAddress ?? previous?.postal_address ?? "";
  if (typeof rawPostal !== "string" || rawPostal.length > 500 || /[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f]/.test(rawPostal)) throw new MarketingError("Enter a business mailing address of at most 500 characters.");
  const postal = rawPostal.replace(/\r\n?/g, "\n").trim();
  if (body.relayToken !== undefined && typeof body.relayToken !== "string") throw new MarketingError("Enter a valid SMTP service token.");
  const entered = (body.relayToken || "").trim();
  if (previous && url !== previous.relay_url && !entered) throw new MarketingError("Enter the SMTP service token again when changing the service URL.");
  if (entered && (!/^[\x21-\x7e]{32,4096}$/.test(entered))) throw new MarketingError("Use an SMTP service token of at least 32 characters without spaces or line breaks.");
  if (!entered && !previous?.relay_token_ciphertext) throw new MarketingError("Enter the SMTP service token.");
  let oldToken = "";
  if (previous?.relay_token_ciphertext) { try { oldToken = (await relayConnection(context, previous)).token; } catch { if (!entered) throw new MarketingError("Replace the saved SMTP service token.", 409); } }
  const changed = !previous || url !== previous.relay_url || entered && entered !== oldToken;
  const credentialRevision = (previous?.credential_revision ?? 0) + Number(!!changed);
  const ciphertext = changed ? await encryptSecret(entered || oldToken, context.masterKey, relayContext(context.owner, credentialRevision)) : previous!.relay_token_ciphertext;
  const revision = (previous?.revision ?? 0) + 1;
  const params = [url, ciphertext, revision, credentialRevision, changed ? null : previous?.relay_verified_at ?? null, postal, Date.now()];
  const result = previous
    ? await context.db.prepare("UPDATE marketing_settings SET relay_url=?,relay_token_ciphertext=?,revision=?,credential_revision=?,relay_verified_at=?,postal_address=?,updated_at=? WHERE owner=? AND revision=?").bind(...params, context.owner, previous.revision).run()
    : await context.db.prepare("INSERT INTO marketing_settings(relay_url,relay_token_ciphertext,revision,credential_revision,relay_verified_at,postal_address,updated_at,owner) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO NOTHING").bind(...params, context.owner).run();
  if (result.meta.changes !== 1) throw conflict();
  return { settings: settingsDto(await settingsRow(context), context.masterKey) };
}
export async function testSettings(context: Context) {
  const current = await settingsRow(context), connection = await relayConnection(context, current);
  await checkRelay(context, connection);
  const now = Date.now();
  const result = await context.db.prepare("UPDATE marketing_settings SET relay_verified_at=?,revision=revision+1,updated_at=? WHERE owner=? AND revision=?").bind(now, now, context.owner, current!.revision).run();
  if (result.meta.changes !== 1) throw conflict();
  return { settings: settingsDto(await settingsRow(context), context.masterKey) };
}
export const accountRow = async (context: Pick<Context, "db" | "owner">, id: string) => {
  const account = await context.db.prepare("SELECT * FROM smtp_accounts WHERE id=? AND owner=? AND deleted_at IS NULL").bind(id, context.owner).first<Row>();
  if (!account) throw new MarketingError("SMTP account not found in this workspace.", 404);
  return account;
};
export function accountDto(row: Row, key?: string): SmtpAccount {
  return { id: row.id, label: row.label, host: row.host, port: row.port, security: row.security, username: row.username, fromEmail: row.from_email, fromName: row.from_name, replyTo: row.reply_to,
    configured: !!row.password_ciphertext && isEncryptionKeyReady(key), enabled: !!row.enabled, verifiedAt: row.verified_at, revision: row.revision, credentialRevision: row.credential_revision,
    dailyLimit: row.daily_limit, minIntervalSeconds: row.min_interval_seconds, sentToday: row.sent_day === day() ? row.sent_today : 0, nextAvailableAt: row.next_available_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}
export async function smtpCredentials(context: Context, row: Row): Promise<SmtpCredentials> {
  assertKey(context.masterKey);
  let password: string;
  try { password = await decryptSecret(row.password_ciphertext, context.masterKey, accountContext(context.owner, row.id, row.credential_revision)); }
  catch { throw new MarketingError("The saved SMTP password could not be opened. Replace and test this account.", 409); }
  return { host: row.host, port: row.port, security: row.security, username: row.username, password, fromEmail: row.from_email, fromName: row.from_name, replyTo: row.reply_to };
}
export async function listAccounts(context: Context, rawCursor: string | null = null) {
  const cursor = cursorValue(rawCursor), params: unknown[] = [context.owner];
  if (cursor) params.push(cursor.t, cursor.t, cursor.id);
  const rows = (await context.db.prepare(`SELECT * FROM smtp_accounts WHERE owner=? AND deleted_at IS NULL ${cursor ? "AND (created_at<? OR created_at=? AND id<?)" : ""} ORDER BY created_at DESC,id DESC LIMIT 101`).bind(...params).all<Row>()).results;
  const visible = rows.slice(0, 100);
  return { accounts: visible.map(row => accountDto(row, context.masterKey)), nextCursor: rows.length > 100 ? cursorFor(visible[visible.length - 1]) : null };
}
export async function saveAccount(context: Context, body: Row) {
  assertKey(context.masterKey);
  const previous = body.id ? await accountRow(context, String(body.id)) : null;
  if (body.revision !== (previous?.revision ?? 0)) throw conflict();
  const id = previous?.id || crypto.randomUUID();
  const label = text(body.label, "account name", 120, previous?.label);
  if (!label) throw new MarketingError("Give this SMTP account a name.");
  const host = publicHost(body.host ?? previous?.host, "SMTP host");
  const port = integer(body.port ?? previous?.port ?? 587, "SMTP port", 1, 65535);
  const security = body.security ?? previous?.security ?? "starttls";
  if (!["tls", "starttls"].includes(security)) throw new MarketingError("Choose TLS or STARTTLS. Unencrypted SMTP is not supported.");
  const username = text(body.username, "SMTP username", 320, previous?.username);
  if (!username) throw new MarketingError("Enter the SMTP username.");
  const fromEmail = email(body.fromEmail ?? previous?.from_email, "sender email");
  const fromName = text(body.fromName, "sender name", 100, previous?.from_name || "");
  const replyToText = text(body.replyTo, "reply-to email", 254, previous?.reply_to || "");
  const replyTo = replyToText ? email(replyToText, "reply-to email") : "";
  const dailyLimit = integer(body.dailyLimit ?? previous?.daily_limit ?? 500, "daily attempt limit", 1, 1_000_000);
  const minInterval = integer(body.minIntervalSeconds ?? previous?.min_interval_seconds ?? 5, "account interval in seconds", 1, 86_400);
  if (body.password !== undefined && typeof body.password !== "string") throw new MarketingError("Enter a valid SMTP password.");
  const entered = body.password || "";
  if (previous && (host !== previous.host || port !== previous.port || security !== previous.security || username !== previous.username) && !entered) throw new MarketingError("Enter the SMTP password again when changing the host, port, security or username.");
  if (new TextEncoder().encode(entered).length > 4096 || /[\u0000\r\n]/.test(entered)) throw new MarketingError("Use a password of at most 4 KB without line breaks.");
  if (!entered && !previous) throw new MarketingError("Enter the SMTP password or application password.");
  let oldPassword = "";
  if (previous) { try { oldPassword = (await smtpCredentials(context, previous)).password; } catch { if (!entered) throw new MarketingError("Replace the saved SMTP password.", 409); } }
  const changed = !previous || host !== previous.host || port !== previous.port || security !== previous.security || username !== previous.username || fromEmail !== previous.from_email || fromName !== previous.from_name || replyTo !== previous.reply_to || entered && entered !== oldPassword;
  const credentialRevision = (previous?.credential_revision ?? 0) + Number(!!changed);
  const password = changed ? await encryptSecret(entered || oldPassword, context.masterKey, accountContext(context.owner, id, credentialRevision)) : previous!.password_ciphertext;
  const verified = changed ? null : previous!.verified_at;
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new MarketingError("Choose whether this account is enabled.");
  const enabled = body.enabled === undefined ? !!previous?.enabled && !changed : body.enabled === true;
  if (enabled && !verified) throw new MarketingError("Save and successfully test this SMTP account before switching it on.", 409);
  const revision = (previous?.revision ?? 0) + 1, now = Date.now();
  const params = [label, host, port, security, username, password, fromEmail, fromName, replyTo, Number(enabled), verified, revision, credentialRevision, dailyLimit, minInterval, now];
  const result = previous
    ? await context.db.prepare("UPDATE smtp_accounts SET label=?,host=?,port=?,security=?,username=?,password_ciphertext=?,from_email=?,from_name=?,reply_to=?,enabled=?,verified_at=?,revision=?,credential_revision=?,daily_limit=?,min_interval_seconds=?,updated_at=?,last_error=NULL WHERE id=? AND owner=? AND revision=? AND deleted_at IS NULL").bind(...params, id, context.owner, previous.revision).run()
    : await context.db.prepare("INSERT INTO smtp_accounts(label,host,port,security,username,password_ciphertext,from_email,from_name,reply_to,enabled,verified_at,revision,credential_revision,daily_limit,min_interval_seconds,updated_at,id,owner,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...params, id, context.owner, now).run();
  if (result.meta.changes !== 1) throw conflict();
  return { account: accountDto(await accountRow(context, id), context.masterKey) };
}
export async function testAccount(context: Context, id: string) {
  const current = await accountRow(context, id), settings = await settingsRow(context);
  const connection = await relayConnection(context, settings), account = await smtpCredentials(context, current);
  try { await checkAccount(context, connection, account); }
  catch (error) {
    await context.db.prepare("UPDATE smtp_accounts SET last_error='SMTP connection check failed.',enabled=0,verified_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=?").bind(Date.now(), id, context.owner, current.revision).run();
    throw error;
  }
  const now = Date.now();
  const result = await context.db.prepare("UPDATE smtp_accounts SET verified_at=?,last_error=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? AND EXISTS(SELECT 1 FROM marketing_settings WHERE owner=? AND credential_revision=?)").bind(now, now, id, context.owner, current.revision, context.owner, settings!.credential_revision).run();
  if (result.meta.changes !== 1) throw conflict();
  return { account: accountDto(await accountRow(context, id), context.masterKey) };
}
export async function toggleAccount(context: Context, id: string, body: Row) {
  const current = await accountRow(context, id);
  if (body.revision !== current.revision) throw conflict();
  if (typeof body.enabled !== "boolean") throw new MarketingError("Choose whether to enable this account.");
  if (body.enabled && !current.verified_at) throw new MarketingError("Successfully test the saved SMTP account before enabling it.", 409);
  const changed = await context.db.prepare("UPDATE smtp_accounts SET enabled=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? AND deleted_at IS NULL").bind(Number(body.enabled), Date.now(), id, context.owner, current.revision).run();
  if (changed.meta.changes !== 1) throw conflict();
  return { account: accountDto(await accountRow(context, id), context.masterKey) };
}
export async function deleteAccount(context: Context, id: string, body: Row) {
  const current = await accountRow(context, id);
  if (body.revision !== current.revision) throw conflict();
  const changed = await context.db.prepare("UPDATE smtp_accounts SET enabled=0,password_ciphertext='',deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=?").bind(Date.now(), Date.now(), id, context.owner, current.revision).run();
  if (changed.meta.changes !== 1) throw conflict();
  return { deleted: true };
}
export async function releaseAccount(context: Pick<Context, "db" | "owner">, account: Row, token: string, attempted: boolean) {
  await context.db.prepare("UPDATE smtp_accounts SET send_lease_until=NULL,reservation_token=NULL,next_available_at=MAX(COALESCE(next_available_at,0),?) WHERE id=? AND owner=? AND reservation_token=?").bind(attempted ? Date.now() + account.min_interval_seconds * 1000 : 0, account.id, context.owner, token).run();
}
