import { decryptSecret, encryptSecret, isEncryptionKeyReady } from "../secret-store.ts";
import { createReoonBulkTask, getReoonBalance, normalizeEmailIdentity, pollReoonBulkTask, ReoonError, verifyReoonSinglePower, type ReoonEmailResult } from "./reoon.ts";
import type { EmailBalance, EmailBatch, EmailCounts, EmailJob, EmailResultRow, EmailSettings } from "./types.ts";

type Row = Record<string, any>;
type Context = { db: D1Database; owner: string; masterKey?: string; fetch?: typeof globalThis.fetch; appOrigin?: string };
type QueueOptions = { owner?: string; jobId?: string; maxSteps?: number; fetch?: typeof globalThis.fetch };
const MAX_CHUNK_ROWS = 500, MAX_BODY_BYTES = 1_048_576, MAX_BATCH = 2_000;
const LEASE_MS = 180_000, CREDIT_RECHECK_MS = 300_000;
const terminal = ["valid", "invalid", "risky", "unknown"];
const keyContext = (owner: string, revision: number) => JSON.stringify(["trezad-email", "reoon", owner, revision]);
const jobIdPattern = /^[a-f0-9-]{36}$/;
const taskIdPattern = /^[1-9]\d{0,31}$/;

export class EmailServiceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "email_request_failed") { super(message); this.name = "EmailServiceError"; }
}
const conflict = (message = "These email settings changed. Reload the current connection and try again.") => new EmailServiceError(message, 409, "email_revision_conflict");
function assertKey(masterKey?: string): asserts masterKey is string {
  if (!isEncryptionKeyReady(masterKey)) throw new EmailServiceError("Secure credential storage is unavailable. Contact the app administrator.", 503, "email_storage_unavailable");
}
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new EmailServiceError(`Enter a valid ${label}.`);
  return value;
}
function boundedText(value: unknown, label: string, max: number, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new EmailServiceError(`Enter a valid ${label} of at most ${max} characters.`);
  return value.trim() || fallback;
}
async function bodyOf(request: Request, appOrigin?: string): Promise<Row> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || origin && origin !== new URL(request.url).origin && origin !== appOrigin) throw new EmailServiceError("Open this action from your workspace.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new EmailServiceError("Use a JSON request.", 415);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new EmailServiceError("Upload up to 500 rows and 1 MB per chunk.", 413);
  if (!request.body) throw new EmailServiceError("Use a JSON object.");
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new EmailServiceError("Upload up to 500 rows and 1 MB per chunk.", 413); }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) { if (error instanceof EmailServiceError) throw error; throw new EmailServiceError("Use valid UTF-8 JSON."); }
  finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new EmailServiceError("The request contains invalid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new EmailServiceError("Use a JSON object.");
  return body as Row;
}

async function settingsRow(context: Pick<Context, "db" | "owner">) { return context.db.prepare("SELECT * FROM email_settings WHERE owner = ?").bind(context.owner).first<Row>(); }
function publicSettings(row: Row | null, masterKey?: string): EmailSettings {
  const configurationAvailable = isEncryptionKeyReady(masterKey);
  const credentialRevision = row?.credential_revision ?? 0;
  const balance = row?.balance_checked_at && row.daily_credits !== null && row.instant_credits !== null ? {
    dailyCredits: row.daily_credits, instantCredits: row.instant_credits,
    availableCredits: row.daily_credits + row.instant_credits, checkedAt: row.balance_checked_at, credentialRevision,
  } : null;
  return { configured: !!row?.api_key_ciphertext && configurationAvailable, configurationAvailable, verifiedAt: row?.verified_at ?? null, revision: row?.revision ?? 0, credentialRevision, balance };
}
async function savedKey(context: Context, row?: Row | null) {
  assertKey(context.masterKey);
  const current = row === undefined ? await settingsRow(context) : row;
  if (!current?.api_key_ciphertext) throw new EmailServiceError("Save your Reoon API key in Email Verifier settings first.", 409, "email_not_configured");
  try { return await decryptSecret(current.api_key_ciphertext, context.masterKey, keyContext(context.owner, current.credential_revision)); }
  catch { throw new EmailServiceError("The saved Reoon key could not be opened. Replace and test it in Email Verifier settings.", 409, "email_key_unavailable"); }
}
function providerOptions(apiKey: string, fetch?: typeof globalThis.fetch) { return { apiKey, ...(fetch ? { fetch } : {}), timeoutMs: 15_000 }; }
async function saveSettings(context: Context, body: Row, remove = false) {
  assertKey(context.masterKey);
  const previous = await settingsRow(context);
  if (body.revision !== (previous?.revision ?? 0)) throw conflict();
  if (!remove && body.apiKey !== undefined && typeof body.apiKey !== "string") throw new EmailServiceError("Enter a valid API key or leave it blank to keep the saved key.");
  const entered = remove ? "" : (body.apiKey || "").trim();
  if (entered && (entered.length < 8 || entered.length > 4096 || !/^[\x21-\x7e]+$/.test(entered))) throw new EmailServiceError("Paste the complete Reoon API key without spaces or line breaks.");
  if (!remove && !entered && !previous?.api_key_ciphertext) throw new EmailServiceError("Enter your Reoon API key.");
  let unchangedKey = false;
  if (entered && previous?.api_key_ciphertext) { try { unchangedKey = entered === await savedKey(context, previous); } catch { /* Explicit replacement can repair a broken encrypted key. */ } }
  const changed = remove ? !!previous?.api_key_ciphertext : !!entered && !unchangedKey;
  const credentialRevision = (previous?.credential_revision ?? 0) + Number(changed);
  const ciphertext = remove ? null : entered && !unchangedKey ? await encryptSecret(entered, context.masterKey, keyContext(context.owner, credentialRevision)) : previous!.api_key_ciphertext;
  const revision = (previous?.revision ?? 0) + 1, now = Date.now();
  const params = [ciphertext, revision, credentialRevision, changed ? null : previous?.verified_at ?? null, changed ? null : previous?.daily_credits ?? null, changed ? null : previous?.instant_credits ?? null, changed ? null : previous?.balance_checked_at ?? null, now];
  const result = previous
    ? await context.db.prepare("UPDATE email_settings SET api_key_ciphertext=?,revision=?,credential_revision=?,verified_at=?,daily_credits=?,instant_credits=?,balance_checked_at=?,updated_at=? WHERE owner=? AND revision=?").bind(...params, context.owner, previous.revision).run()
    : await context.db.prepare("INSERT INTO email_settings (api_key_ciphertext,revision,credential_revision,verified_at,daily_credits,instant_credits,balance_checked_at,updated_at,owner) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO NOTHING").bind(...params, context.owner).run();
  if (result.meta.changes !== 1) throw conflict();
  return { settings: publicSettings(await settingsRow(context), context.masterKey) };
}
async function fetchBalance(context: Context, verify = false) {
  const previous = await settingsRow(context), key = await savedKey(context, previous);
  let balance;
  try { balance = await getReoonBalance(providerOptions(key, context.fetch)); }
  catch (error) {
    if (verify && error instanceof ReoonError && error.kind === "auth") {
      await context.db.prepare("UPDATE email_settings SET verified_at=NULL,updated_at=? WHERE owner=? AND revision=? AND credential_revision=? AND verified_at IS ?").bind(Date.now(), context.owner, previous!.revision, previous!.credential_revision, previous!.verified_at).run();
    }
    throw error;
  }
  const now = Date.now();
  const verifiedAt = Math.max(now, (previous!.verified_at ?? 0) + 1);
  const changed = await context.db.prepare("UPDATE email_settings SET daily_credits=?,instant_credits=?,balance_checked_at=?,verified_at=CASE WHEN ? THEN ? ELSE verified_at END,updated_at=? WHERE owner=? AND revision=? AND credential_revision=? AND api_key_ciphertext IS NOT NULL").bind(balance.dailyCredits, balance.instantCredits, now, Number(verify), verifiedAt, now, context.owner, previous!.revision, previous!.credential_revision).run();
  if (changed.meta.changes !== 1) throw conflict("The Reoon connection changed during the balance check. Test the current saved key again.");
  const final = await settingsRow(context);
  if (!final?.api_key_ciphertext || final.credential_revision !== previous!.credential_revision) throw conflict();
  const settings = publicSettings(final, context.masterKey);
  return { settings, balance: settings.balance! };
}

async function ownedJob(db: D1Database, owner: string, id: string) {
  if (!jobIdPattern.test(id)) throw new EmailServiceError("Email job not found.", 404);
  const row = await db.prepare("SELECT * FROM email_jobs WHERE id=? AND owner=?").bind(id, owner).first<Row>();
  if (!row) throw new EmailServiceError("Email job not found in this workspace.", 404);
  return row;
}
const effectiveStatus = "COALESCE(t.status,r.local_status,'unknown')";
function jobDto(row: Row): EmailJob {
  const counts = { total: row.total_rows, duplicates: row.duplicate_count, ...Object.fromEntries(["pending", "processing", ...terminal].map(key => [key, Number(row[`${key}_count`] || 0)])) } as EmailCounts;
  const processedRows = counts.valid + counts.invalid + counts.risky + counts.unknown;
  return {
    id: row.id, name: row.name, sourceName: row.source_name, status: row.status,
    counts, importedChunks: row.next_chunk_index, nextChunkIndex: row.next_chunk_index, totalRows: row.total_rows,
    sealed: row.sealed_at !== null, eligibleCount: row.eligible_count, invalidSyntaxCount: row.invalid_syntax_count,
    credentialRevision: row.credential_revision, createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, completedAt: row.completed_at,
    processedRows, progressPercent: counts.total ? Math.round(processedRows / counts.total * 1000) / 10 : 0,
    nextRunAt: row.next_run_at, error: row.error,
  };
}
async function getJob(db: D1Database, owner: string, id: string) { return jobDto(await ownedJob(db, owner, id)); }
function batchDto(row: Row): EmailBatch { return { id: row.id, index: row.batch_index, mode: row.mode, status: row.status, taskId: row.task_id, count: row.count, attempts: row.attempts, nextPollAt: row.next_poll_at, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error }; }
async function jobDetail(context: Context, id: string, url: URL) {
  const row = await ownedJob(context.db, context.owner, id);
  const cursor = queryInteger(url, "batchCursor", -1, -1, Number.MAX_SAFE_INTEGER);
  const batches = await context.db.prepare("SELECT * FROM email_batches WHERE job_id=? AND batch_index>? ORDER BY batch_index LIMIT 101").bind(id, cursor).all<Row>();
  const attention = await context.db.prepare("SELECT * FROM email_batches WHERE job_id=? AND status='unknown' ORDER BY batch_index LIMIT 100").bind(id).all<Row>();
  const shown = batches.results.slice(0, 100);
  return { job: jobDto(row), batches: shown.map(batch => batchDto(row.status === "cancelled" && ["submitting", "submitted"].includes(batch.status) ? { ...batch, status: "cancelled" } : batch)), attentionBatches: row.status === "cancelled" ? [] : attention.results.map(batchDto), nextBatchCursor: batches.results.length > 100 ? String(shown.at(-1)!.batch_index) : null };
}
function queryInteger(url: URL, key: string, fallback: number, min: number, max: number) {
  const value = url.searchParams.get(key);
  if (value === null || value === "") return fallback;
  if (!/^-?\d+$/.test(value)) throw new EmailServiceError(`Invalid ${key}.`);
  return integer(Number(value), key, min, max);
}
async function listJobs(context: Context, url: URL) {
  const limit = queryInteger(url, "limit", 25, 1, 50), cursor = url.searchParams.get("cursor");
  let cutoff: [number, string] | undefined;
  if (cursor) { const [time, id, extra] = cursor.split(":"); if (extra || !jobIdPattern.test(id || "") || !/^\d+$/.test(time)) throw new EmailServiceError("Invalid job cursor."); cutoff = [integer(Number(time), "job cursor"), id]; }
  const rows = await context.db.prepare(`SELECT * FROM email_jobs WHERE owner=? ${cutoff ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(context.owner, ...(cutoff ? [cutoff[0], cutoff[0], cutoff[1]] : []), limit + 1).all<Row>();
  const shown = rows.results.slice(0, limit), last = shown.at(-1);
  return { jobs: shown.map(jobDto), nextCursor: rows.results.length > limit && last ? `${last.created_at}:${last.id}` : null };
}
async function createJob(context: Context, body: Row) {
  const name = boundedText(body.name, "job name", 120, "Email verification"), sourceName = boundedText(body.sourceName, "file name", 200);
  const now = Date.now(), id = crypto.randomUUID();
  await context.db.prepare("INSERT INTO email_jobs (id,owner,name,source_name,status,created_at,updated_at) VALUES (?,?,?,?,'uploading',?,?)").bind(id, context.owner, name, sourceName, now, now).run();
  return { job: await getJob(context.db, context.owner, id) };
}
function classifyInput(email: string) {
  const value = email.trim();
  const normalized = normalizeEmailIdentity(value);
  if (normalized) return { normalized, status: null, reason: null };
  if (/[\u0080-\uffff<>"()]/.test(value) && value.includes("@")) return { normalized: null, status: "unknown", reason: "Unsupported email format; review manually. No provider check was made." };
  return { normalized: null, status: "invalid", reason: value ? "Invalid email syntax. No provider check was made." : "Empty email address. No provider check was made." };
}
async function uploadChunk(context: Context, id: string, body: Row) {
  const job = await ownedJob(context.db, context.owner, id);
  const chunkIndex = integer(body.index, "chunk index", 0, Math.floor((Number.MAX_SAFE_INTEGER - MAX_CHUNK_ROWS) / MAX_CHUNK_ROWS));
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > MAX_CHUNK_ROWS) throw new EmailServiceError("Each upload chunk must contain 1 to 500 rows.");
  const rows = body.rows.map((row: unknown, index: number) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new EmailServiceError("Each row must contain an email string.");
    const value = row as Row;
    if (typeof value.email !== "string" || value.email.length > 1024 || /\u0000/.test(value.email)) throw new EmailServiceError("Each email cell must contain at most 1,024 characters without null bytes.");
    if (value.sourceRow !== undefined && (typeof value.sourceRow !== "string" && typeof value.sourceRow !== "number" || String(value.sourceRow).length > 128 || typeof value.sourceRow === "number" && !Number.isSafeInteger(value.sourceRow))) throw new EmailServiceError("Each source row must be a short string or integer.");
    return { email: value.email, sourceRow: value.sourceRow === undefined ? null : String(value.sourceRow), position: chunkIndex * MAX_CHUNK_ROWS + index + 1, ...classifyInput(value.email) };
  });
  const payload = JSON.stringify(rows);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)))).map(value => value.toString(16).padStart(2, "0")).join("");
  const existing = await context.db.prepare("SELECT digest FROM email_chunks WHERE job_id=? AND chunk_index=?").bind(id, chunkIndex).first<Row>();
  if (existing) { if (existing.digest !== digest) throw new EmailServiceError("This chunk index already contains different rows. Create a new import for the changed file.", 409, "email_chunk_conflict"); return { job: await getJob(context.db, context.owner, id), duplicate: true }; }
  if (job.status !== "uploading" || job.next_chunk_index !== chunkIndex) throw new EmailServiceError(`Upload chunk ${job.next_chunk_index} next, before sealing this job.`, 409, "email_chunk_order");
  const now = Date.now();
  const validRows = rows.filter(row => row.normalized).length, invalidRows = rows.filter(row => row.status === "invalid").length, unknownRows = rows.filter(row => row.status === "unknown").length;
  const firstPosition = rows[0].position, lastPosition = rows.at(-1)!.position;
  const newTargets = "(SELECT COUNT(*) FROM email_targets WHERE job_id=? AND status='pending' AND first_position BETWEEN ? AND ?)";
  const operations = await context.db.batch([
    context.db.prepare("INSERT INTO email_chunks (job_id,chunk_index,digest,row_count,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND owner=? AND status='uploading' AND next_chunk_index=?) ON CONFLICT(job_id,chunk_index) DO NOTHING").bind(id, chunkIndex, digest, rows.length, now, id, context.owner, chunkIndex),
    context.db.prepare("INSERT INTO email_targets (job_id,email,first_position,status,reason,updated_at,occurrence_count) SELECT ?,json_extract(value,'$.normalized'),MIN(json_extract(value,'$.position')),'pending','',?,COUNT(*) FROM json_each(?) WHERE json_extract(value,'$.normalized') IS NOT NULL AND EXISTS (SELECT 1 FROM email_chunks WHERE job_id=? AND chunk_index=? AND digest=?) AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND status='uploading' AND next_chunk_index=?) GROUP BY json_extract(value,'$.normalized') ON CONFLICT(job_id,email) DO UPDATE SET occurrence_count=email_targets.occurrence_count+excluded.occurrence_count").bind(id, now, payload, id, chunkIndex, digest, id, chunkIndex),
    context.db.prepare("INSERT INTO email_rows (job_id,position,source_row,email,normalized_email,local_status,local_reason) SELECT ?,json_extract(value,'$.position'),json_extract(value,'$.sourceRow'),json_extract(value,'$.email'),json_extract(value,'$.normalized'),json_extract(value,'$.status'),json_extract(value,'$.reason') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM email_chunks WHERE job_id=? AND chunk_index=? AND digest=?) ON CONFLICT(job_id,position) DO NOTHING").bind(id, payload, id, chunkIndex, digest),
    context.db.prepare(`UPDATE email_jobs SET total_rows=total_rows+?,pending_count=pending_count+?,invalid_count=invalid_count+?,unknown_count=unknown_count+?,invalid_syntax_count=invalid_syntax_count+?,eligible_count=eligible_count+${newTargets},pending_targets=pending_targets+${newTargets},duplicate_count=duplicate_count+?-${newTargets},next_chunk_index=next_chunk_index+1,updated_at=? WHERE id=? AND owner=? AND status='uploading' AND next_chunk_index=? AND EXISTS (SELECT 1 FROM email_chunks WHERE job_id=? AND chunk_index=? AND digest=?)`).bind(rows.length, validRows, invalidRows, unknownRows, invalidRows, id, firstPosition, lastPosition, id, firstPosition, lastPosition, validRows, id, firstPosition, lastPosition, now, id, context.owner, chunkIndex, id, chunkIndex, digest),
  ]);
  if (operations[3].meta.changes !== 1) {
    const stored = await context.db.prepare("SELECT digest FROM email_chunks WHERE job_id=? AND chunk_index=?").bind(id, chunkIndex).first<Row>();
    if (stored?.digest !== digest) throw new EmailServiceError("Another upload used this chunk index. Reload the job before continuing.", 409, "email_chunk_conflict");
  }
  return { job: await getJob(context.db, context.owner, id), duplicate: operations[0].meta.changes === 0 };
}
async function sealJob(context: Context, id: string, body: Row) {
  const job = await ownedJob(context.db, context.owner, id), chunks = integer(body.expectedChunks, "chunk count", 1), rows = integer(body.expectedRows, "row count", 1);
  if (job.next_chunk_index !== chunks || job.total_rows !== rows) throw new EmailServiceError("The imported row or chunk count does not match. Finish the upload before sealing.", 409, "email_import_incomplete");
  if (job.status !== "uploading" && !job.sealed_at) throw new EmailServiceError("This import cannot be sealed in its current state.", 409);
  if (job.status === "uploading") await context.db.prepare("UPDATE email_jobs SET status='ready',sealed_at=?,updated_at=? WHERE id=? AND owner=? AND status='uploading' AND next_chunk_index=? AND total_rows=?").bind(Date.now(), Date.now(), id, context.owner, chunks, rows).run();
  return { job: await getJob(context.db, context.owner, id) };
}
async function startJob(context: Context, id: string, body: Row) {
  if (body.acknowledgeProvider !== true) throw new EmailServiceError("Confirm sharing the eligible addresses with Reoon and using verification credits before starting.", 409, "email_consent_required");
  const job = await ownedJob(context.db, context.owner, id);
  if (job.started_at) return { job: await getJob(context.db, context.owner, id) };
  if (job.status !== "ready" || !job.sealed_at) throw new EmailServiceError("Finish importing and review the job before starting.", 409);
  const now = Date.now();
  if (!job.eligible_count) {
    await context.db.prepare("UPDATE email_jobs SET status='completed',started_at=?,completed_at=?,updated_at=? WHERE id=? AND owner=? AND status='ready'").bind(now, now, now, id, context.owner).run();
  } else {
    assertKey(context.masterKey);
    const settings = await settingsRow(context);
    if (!settings?.api_key_ciphertext || !settings.verified_at) throw new EmailServiceError("Save and test the Reoon API key before starting paid verification.", 409, "email_not_verified");
    const changed = await context.db.prepare("UPDATE email_jobs SET status='running',started_at=?,credential_revision=?,credential_ciphertext=?,next_run_at=?,updated_at=?,error=NULL WHERE id=? AND owner=? AND status='ready' AND EXISTS (SELECT 1 FROM email_settings WHERE owner=? AND credential_revision=? AND api_key_ciphertext IS NOT NULL AND verified_at IS NOT NULL)").bind(now, settings.credential_revision, settings.api_key_ciphertext, now, now, id, context.owner, context.owner, settings.credential_revision).run();
    if (changed.meta.changes !== 1) throw conflict();
  }
  return { job: await getJob(context.db, context.owner, id) };
}
async function resultsPage(context: Context, id: string, url: URL) {
  const job = await ownedJob(context.db, context.owner, id);
  const cursor = queryInteger(url, "cursor", 0, 0, Number.MAX_SAFE_INTEGER), limit = queryInteger(url, "limit", 500, 1, 1000), filter = url.searchParams.get("filter") || "all";
  if (!["all", "pending", ...terminal].includes(filter)) throw new EmailServiceError("Choose a valid result category.");
  const statusExpression = job.status === "cancelled" ? `CASE WHEN ${effectiveStatus} IN ('pending','processing') THEN 'unknown' ELSE ${effectiveStatus} END` : effectiveStatus;
  const condition = filter === "all" ? "" : filter === "pending" ? `AND ${statusExpression} IN ('pending','processing')` : `AND ${statusExpression}=?`;
  const filterParams = filter === "all" || filter === "pending" ? [] : [filter];
  const select = "FROM email_rows r LEFT JOIN email_targets t ON t.job_id=r.job_id AND t.email=r.normalized_email WHERE r.job_id=?";
  const data = await context.db.prepare(`SELECT r.*,t.status AS target_status,t.reason AS target_reason,t.provider_status,t.first_position,t.updated_at AS checked_at ${select} AND r.position>? ${condition} ORDER BY r.position LIMIT ?`).bind(id, cursor, ...filterParams, limit + 1).all<Row>();
  const rows: EmailResultRow[] = data.results.slice(0, limit).map(row => {
    const stopped = job.status === "cancelled" && ["pending", "processing"].includes(row.target_status);
    const status = stopped ? "unknown" : row.target_status ?? row.local_status ?? "unknown";
    return { position: row.position, sourceRow: row.source_row, email: row.email, normalizedEmail: row.normalized_email, status, category: terminal.includes(status) ? status : null, reason: stopped ? "Cancelled before a verified result was recorded." : row.target_reason ?? row.local_reason ?? "", providerStatus: stopped ? null : row.provider_status ?? null, duplicateOf: row.first_position && row.first_position !== row.position ? row.first_position : null, checkedAt: !stopped && row.target_status && terminal.includes(status) && row.provider_status ? row.checked_at : null };
  });
  return { rows, nextCursor: data.results.length > limit ? String(rows.at(-1)!.position) : null, total: filter === "all" ? job.total_rows : filter === "pending" ? job.pending_count + job.processing_count : job[`${filter}_count`] };
}

async function actOnJob(context: Context, id: string, body: Row) {
  const job = await ownedJob(context.db, context.owner, id), now = Date.now();
  if (body.action === "pause") {
    if (!["running", "waiting_credits"].includes(job.status)) throw new EmailServiceError("Only a running or credit-waiting job can be paused.", 409);
    await context.db.prepare("UPDATE email_jobs SET status='paused',next_run_at=NULL,updated_at=? WHERE id=? AND owner=? AND status IN ('running','waiting_credits')").bind(now, id, context.owner).run();
  } else if (body.action === "resume") {
    if (!job.started_at || !["paused", "needs_attention", "waiting_credits"].includes(job.status)) throw new EmailServiceError("This job cannot be resumed.", 409);
    const settings = await settingsRow(context);
    if (!settings?.verified_at || settings.credential_revision !== job.credential_revision || !settings.api_key_ciphertext) throw new EmailServiceError("This job belongs to an earlier or unverified Reoon connection. Reconcile existing provider tasks or export pending rows into a new job using the current verified account.", 409, "email_job_connection_changed");
    await context.db.prepare("UPDATE email_jobs SET status='running',next_run_at=?,updated_at=?,error=NULL WHERE id=? AND owner=? AND status IN ('paused','needs_attention','waiting_credits')").bind(now, now, id, context.owner).run();
  } else if (body.action === "cancel") {
    if (["completed", "cancelled"].includes(job.status)) return { job: await getJob(context.db, context.owner, id) };
    // The cancellation gate is one bounded write regardless of list size.
    // Result reads overlay unverified rows as unknown; large cleanup cannot
    // roll back the stop flag or leave this job eligible for paid submissions.
    await context.db.prepare("UPDATE email_jobs SET status='cancelled',unknown_count=unknown_count+pending_count+processing_count,pending_count=0,processing_count=0,pending_targets=0,next_run_at=NULL,updated_at=?,completed_at=?,error='Cancelled. Submitted provider work cannot be recalled or refunded automatically.' WHERE id=? AND owner=? AND status NOT IN ('cancelled','completed')").bind(now, now, id, context.owner).run();
  } else throw new EmailServiceError("Choose pause, resume, or cancel.");
  return { job: await getJob(context.db, context.owner, id) };
}

function safeError(error: unknown) {
  if (error instanceof ReoonError || error instanceof EmailServiceError) return error.message;
  return "The verification operation could not be confirmed. Review the job before taking another action.";
}
async function updateJobState(db: D1Database, job: Row, status: string, next: number | null, error: string | null) {
  await db.prepare("UPDATE email_jobs SET status=CASE WHEN status IN ('paused','cancelled') THEN status ELSE ? END,next_run_at=CASE WHEN status IN ('paused','cancelled') THEN NULL ELSE ? END,error=?,updated_at=? WHERE id=? AND lease_token=?").bind(status, next, error, Date.now(), job.id, job.lease_token).run();
}
function moveCount(db: D1Database, job: Row, batchId: string, from: string, to: string, returnPending = false, expectedTaskId?: string) {
  if (!["pending", "processing", ...terminal].includes(from) || !["pending", "processing", ...terminal].includes(to) || from === to) throw new EmailServiceError("Invalid internal result transition.", 500);
  return db.prepare(`UPDATE email_jobs SET ${from}_count=${from}_count-delta.weight,${to}_count=${to}_count+delta.weight${returnPending ? ",pending_targets=pending_targets+delta.n" : ""} FROM (SELECT COALESCE(SUM(occurrence_count),0) AS weight,COUNT(*) AS n FROM email_targets WHERE job_id=? AND batch_id=? AND status=?) AS delta WHERE email_jobs.id=? AND lease_token=? AND status<>'cancelled' AND EXISTS (SELECT 1 FROM email_batches WHERE id=? AND job_id=? AND status IN ('submitting','submitted','unknown')${expectedTaskId ? " AND status='submitted' AND task_id=?" : ""})`).bind(job.id, batchId, from, job.id, job.lease_token, batchId, job.id, ...(expectedTaskId ? [expectedTaskId] : []));
}
async function markUnknown(db: D1Database, job: Row, batch: Row, reason: string) {
  const now = Date.now();
  await db.batch([
    moveCount(db, job, batch.id, "processing", "unknown"),
    db.prepare("UPDATE email_batches SET status='unknown',error=?,next_poll_at=NULL,updated_at=? WHERE id=? AND status IN ('submitting','submitted') AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(reason, now, batch.id, job.id, job.lease_token),
    db.prepare("UPDATE email_targets SET status='unknown',reason=?,provider_status=NULL,updated_at=? WHERE job_id=? AND batch_id=? AND status='processing' AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(reason, now, job.id, batch.id, job.id, job.lease_token),
  ]);
  await updateJobState(db, job, "needs_attention", null, reason);
}
async function persistResults(db: D1Database, job: Row, batch: Row, expected: string[], input: ReoonEmailResult[]) {
  const mapped = new Map<string, ReoonEmailResult>(), duplicated = new Set<string>();
  for (const row of input) {
    if (!row || typeof row.email !== "string") continue;
    const key = normalizeEmailIdentity(row.email);
    if (!key || !expected.includes(key)) continue;
    if (mapped.has(key)) duplicated.add(key);
    mapped.set(key, row);
  }
  const now = Date.now();
  const results = expected.map(email => {
    const value = mapped.get(email), good = value && terminal.includes(value.category) && typeof value.reason === "string" && value.reason.length <= 2000 && (value.providerStatus === null || typeof value.providerStatus === "string" && value.providerStatus.length <= 128) && !duplicated.has(email);
    return { email, status: good ? value.category : "unknown", reason: good ? value.reason.slice(0, 500) : "The provider did not return one unambiguous result for this address. Review manually.", providerStatus: good ? value.providerStatus : null };
  });
  for (let offset = 0; offset < results.length; offset += MAX_CHUNK_ROWS) {
    const chunk = JSON.stringify(results.slice(offset, offset + MAX_CHUNK_ROWS));
    const statuses = ["pending", "processing", ...terminal];
    const deltas = statuses.map(status => `COALESCE(SUM(t.occurrence_count*((CASE WHEN json_extract(result.value,'$.status')='${status}' THEN 1 ELSE 0 END)-(CASE WHEN t.status='${status}' THEN 1 ELSE 0 END))),0) AS ${status}_delta`).join(",");
    await db.batch([
      db.prepare(`UPDATE email_jobs SET ${statuses.map(status => `${status}_count=${status}_count+delta.${status}_delta`).join(",")} FROM (SELECT ${deltas} FROM email_targets t JOIN json_each(?) result ON t.email=json_extract(result.value,'$.email') WHERE t.job_id=? AND t.batch_id=? AND t.status IN ('processing','unknown')) delta WHERE email_jobs.id=? AND lease_token=? AND status<>'cancelled'`).bind(chunk, job.id, batch.id, job.id, job.lease_token),
      db.prepare("UPDATE email_targets SET status=json_extract(result.value,'$.status'),reason=json_extract(result.value,'$.reason'),provider_status=json_extract(result.value,'$.providerStatus'),updated_at=? FROM json_each(?) AS result WHERE email_targets.job_id=? AND email_targets.batch_id=? AND email_targets.status IN ('processing','unknown') AND email_targets.email=json_extract(result.value,'$.email') AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(now, chunk, job.id, batch.id, job.id, job.lease_token),
    ]);
  }
  await db.prepare("UPDATE email_batches SET status='completed',error=NULL,next_poll_at=NULL,updated_at=? WHERE id=? AND status<>'cancelled' AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(now, batch.id, job.id, job.lease_token).run();
  const remaining = await db.prepare("SELECT pending_count+processing_count AS n FROM email_jobs WHERE id=?").bind(job.id).first<Row>();
  if (!remaining!.n) {
    await db.prepare("UPDATE email_jobs SET status=CASE WHEN status='cancelled' THEN status ELSE 'completed' END,completed_at=?,next_run_at=NULL,error=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(now, now, job.id, job.lease_token).run();
  } else await updateJobState(db, job, "running", now, null);
}
async function taskEmails(db: D1Database, job: Row, batch: Row) {
  const rows = await db.prepare("SELECT email FROM email_targets WHERE job_id=? AND batch_id=? ORDER BY first_position LIMIT 2001").bind(job.id, batch.id).all<Row>();
  if (rows.results.length !== batch.count || rows.results.length > MAX_BATCH) throw new EmailServiceError("The persisted provider batch does not match its address count. Review this job.", 409, "email_batch_corrupt");
  return rows.results.map(row => row.email as string);
}
async function pollBatch(db: D1Database, job: Row, batch: Row, key: string, fetch?: typeof globalThis.fetch) {
  const expected = await taskEmails(db, job, batch);
  try {
    const result = await pollReoonBulkTask(providerOptions(key, fetch), batch.task_id, expected);
    if (result.status === "completed") return await persistResults(db, job, batch, expected, result.results);
    if (["file_not_found", "file_loading_error", "unknown"].includes(result.status)) return await markUnknown(db, job, batch, "Reoon could not confirm this task's result. Check the saved task ID; the addresses will not be resubmitted automatically.");
    const next = Date.now() + 30_000;
    await db.prepare("UPDATE email_batches SET attempts=0,next_poll_at=?,updated_at=? WHERE id=? AND status='submitted'").bind(next, Date.now(), batch.id).run();
    await updateJobState(db, job, "running", next, null);
  } catch (error) {
    const attempts = batch.attempts + 1;
    if (error instanceof ReoonError && error.kind === "auth") return updateJobState(db, job, "needs_attention", null, safeError(error));
    if (attempts >= 5) return markUnknown(db, job, batch, "The provider result could not be read after repeated checks. Reconcile the saved task ID; no verification was resubmitted.");
    const delay = Math.min(300_000, Math.max(15_000 * 2 ** Math.min(attempts, 5), error instanceof ReoonError ? (error.retryAfterSeconds || 0) * 1000 : 0));
    const next = Date.now() + delay;
    await db.prepare("UPDATE email_batches SET attempts=?,next_poll_at=?,error=?,updated_at=? WHERE id=? AND status='submitted'").bind(attempts, next, safeError(error), Date.now(), batch.id).run();
    await updateJobState(db, job, "running", next, safeError(error));
  }
}
async function advanceJob(db: D1Database, masterKey: string | undefined, job: Row, fetch?: typeof globalThis.fetch) {
  assertKey(masterKey);
  let key: string;
  try { key = await decryptSecret(job.credential_ciphertext, masterKey, keyContext(job.owner, job.credential_revision)); }
  catch { return updateJobState(db, job, "needs_attention", null, "The job's saved credential could not be opened. Contact the app administrator."); }
  const inFlight = await db.prepare("SELECT * FROM email_batches WHERE job_id=? AND status IN ('submitting','submitted') ORDER BY batch_index LIMIT 1").bind(job.id).first<Row>();
  if (inFlight?.status === "submitting") return markUnknown(db, job, inFlight, "A previous provider submission was interrupted and its outcome is unknown. Reconcile its task ID; no automatic resubmission will occur.");
  if (inFlight) {
    if (inFlight.next_poll_at && inFlight.next_poll_at > Date.now()) return updateJobState(db, job, "running", inFlight.next_poll_at, null);
    return pollBatch(db, job, inFlight, key, fetch);
  }
  const account = await db.prepare("SELECT credential_revision,verified_at,api_key_ciphertext FROM email_settings WHERE owner=?").bind(job.owner).first<Row>();
  if (!account?.api_key_ciphertext || !account.verified_at || account.credential_revision !== job.credential_revision) return updateJobState(db, job, "needs_attention", null, "The Reoon connection changed or is unverified. Reconcile existing tasks or export pending rows into a new job for the current account.");
  const count = Number(job.pending_targets);
  if (!count) {
    await db.prepare("UPDATE email_jobs SET status=CASE WHEN status IN ('paused','cancelled') THEN status ELSE 'completed' END,completed_at=?,next_run_at=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(), Date.now(), job.id, job.lease_token).run();
    return;
  }
  const smallJob = job.eligible_count < 10;
  if (!smallJob && count < 10) return updateJobState(db, job, "needs_attention", null, "The remaining addresses are below Reoon's bulk minimum. Review the batch history before creating another job; no single-address fallback was attempted.");
  let credits;
  try { credits = await getReoonBalance(providerOptions(key, fetch)); }
  catch (error) {
    if (error instanceof ReoonError && error.kind === "auth") return updateJobState(db, job, "needs_attention", null, safeError(error));
    return updateJobState(db, job, "waiting_credits", Date.now() + CREDIT_RECHECK_MS, safeError(error));
  }
  const available = credits.dailyCredits + credits.instantCredits;
  let size = smallJob ? 1 : Math.min(count, MAX_BATCH, available);
  if (!smallJob && count > size && count - size < 10) size = count - 10;
  const minimumCredits = smallJob ? 1 : count < 20 ? count : 10;
  if (available < minimumCredits || !smallJob && size < 10) return updateJobState(db, job, "waiting_credits", Date.now() + CREDIT_RECHECK_MS, `Waiting for at least ${minimumCredits} available Reoon credits for the next batch. Credits are checked again automatically.`);
  const targets = await db.prepare("SELECT email FROM email_targets WHERE job_id=? AND status='pending' AND batch_id IS NULL ORDER BY first_position LIMIT ?").bind(job.id, size).all<Row>();
  const emails = targets.results.map(row => row.email as string), now = Date.now(), id = crypto.randomUUID();
  if (emails.length !== size) throw new EmailServiceError("The queued address count changed unexpectedly. Review the job.", 409);
  // Record the submission intent before any paid provider operation. A crash
  // leaves 'submitting', which is never replayed when its lease expires.
  const operations = await db.batch([
    db.prepare("INSERT INTO email_batches (id,job_id,batch_index,mode,status,count,created_at,updated_at) SELECT ?,?,COALESCE((SELECT MAX(batch_index)+1 FROM email_batches WHERE job_id=?),0),?,'submitting',?,?,? WHERE EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status IN ('running','waiting_credits')) AND EXISTS (SELECT 1 FROM email_settings WHERE owner=? AND credential_revision=? AND verified_at IS NOT NULL AND api_key_ciphertext IS NOT NULL)").bind(id, job.id, job.id, size < 10 ? "single" : "bulk", size, now, now, job.id, job.lease_token, job.owner, job.credential_revision),
    db.prepare("UPDATE email_targets SET status='processing',batch_id=?,updated_at=? WHERE job_id=? AND status='pending' AND batch_id IS NULL AND email IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM email_batches WHERE id=?)").bind(id, now, job.id, JSON.stringify(emails), id),
    db.prepare("UPDATE email_jobs SET pending_count=pending_count-delta.weight,processing_count=processing_count+delta.weight,pending_targets=pending_targets-delta.n FROM (SELECT COALESCE(SUM(occurrence_count),0) AS weight,COUNT(*) AS n FROM email_targets WHERE job_id=? AND batch_id=? AND status='processing') AS delta WHERE email_jobs.id=? AND lease_token=? AND EXISTS (SELECT 1 FROM email_batches WHERE id=?)").bind(job.id, id, job.id, job.lease_token, id),
  ]);
  if (operations[0].meta.changes !== 1) {
    await db.prepare("UPDATE email_jobs SET status='needs_attention',next_run_at=NULL,error='The Reoon connection changed before submission. No verification request was made.',updated_at=? WHERE id=? AND lease_token=? AND status IN ('running','waiting_credits')").bind(Date.now(), job.id, job.lease_token).run();
    return;
  }
  const batch = { id, job_id: job.id, count: size, mode: size < 10 ? "single" : "bulk", status: "submitting", attempts: 0 };
  let acknowledgedTaskId: string | undefined;
  try {
    if (size < 10) return await persistResults(db, job, batch, emails, [await verifyReoonSinglePower({ ...providerOptions(key, fetch), timeoutMs: 90_000 }, emails[0])]);
    const submitted = await createReoonBulkTask(providerOptions(key, fetch), emails, `EV-${id.slice(0, 20)}`);
    acknowledgedTaskId = submitted.taskId;
    const next = Date.now() + 15_000;
    await db.prepare("UPDATE email_batches SET status=CASE WHEN status='submitting' THEN 'submitted' ELSE status END,task_id=?,next_poll_at=CASE WHEN status='submitting' THEN ? ELSE next_poll_at END,updated_at=? WHERE id=?").bind(submitted.taskId, next, Date.now(), id).run();
    await updateJobState(db, job, "running", next, null);
  } catch (error) {
    if (error instanceof ReoonError && error.submissionOutcome === "accepted" && error.taskId && taskIdPattern.test(error.taskId)) {
      const next = Date.now() + 15_000;
      acknowledgedTaskId = error.taskId;
      await db.prepare("UPDATE email_batches SET status=CASE WHEN status='submitting' THEN 'submitted' ELSE status END,task_id=?,next_poll_at=CASE WHEN status='submitting' THEN ? ELSE next_poll_at END,error=?,updated_at=? WHERE id=?").bind(error.taskId, next, safeError(error), Date.now(), id).run();
      return updateJobState(db, job, "running", next, safeError(error));
    }
    if (error instanceof ReoonError && ["not_submitted", "rejected"].includes(error.submissionOutcome)) {
      await db.batch([
        moveCount(db, job, id, "processing", "pending", true),
        db.prepare("UPDATE email_batches SET status='rejected',error=?,updated_at=? WHERE id=? AND status='submitting' AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(safeError(error), Date.now(), id, job.id, job.lease_token),
        db.prepare("UPDATE email_targets SET status='pending',batch_id=NULL,reason='',updated_at=? WHERE job_id=? AND batch_id=? AND status='processing' AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(Date.now(), job.id, id, job.id, job.lease_token),
      ]);
      return updateJobState(db, job, error.kind === "credits" ? "waiting_credits" : "needs_attention", error.kind === "credits" ? Date.now() + CREDIT_RECHECK_MS : null, safeError(error));
    }
    const knownTaskId = acknowledgedTaskId || (error instanceof ReoonError ? error.taskId : undefined);
    if (knownTaskId && taskIdPattern.test(knownTaskId)) await db.prepare("UPDATE email_batches SET task_id=? WHERE id=? AND task_id IS NULL").bind(knownTaskId, id).run();
    await markUnknown(db, job, batch, safeError(error));
  }
}

/** Bounded durable queue drain. It never imports data, starts a draft, or retries an uncertain submission. */
export async function advanceEmailQueue(db: D1Database, masterKey: string | undefined, options: QueueOptions = {}) {
  const maxSteps = Math.max(1, Math.min(3, Number.isSafeInteger(options.maxSteps) ? options.maxSteps! : 1)), jobIds: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const now = Date.now(), token = crypto.randomUUID();
    const where = `${options.owner ? " AND owner=?" : ""}${options.jobId ? " AND id=?" : ""}${jobIds.length ? " AND id NOT IN (SELECT value FROM json_each(?))" : ""}`;
    const params = [...(options.owner ? [options.owner] : []), ...(options.jobId ? [options.jobId] : []), ...(jobIds.length ? [JSON.stringify(jobIds)] : [])];
    const job = await db.prepare(`UPDATE email_jobs SET lease_token=?,lease_until=? WHERE id=(SELECT id FROM email_jobs WHERE started_at IS NOT NULL AND status IN ('running','waiting_credits') AND COALESCE(next_run_at,0)<=? AND (lease_until IS NULL OR lease_until<?) ${where} ORDER BY COALESCE(next_run_at,0),created_at LIMIT 1) AND (lease_until IS NULL OR lease_until<?) RETURNING *`).bind(token, now + LEASE_MS, now, now, ...params, now).first<Row>();
    if (!job) break;
    jobIds.push(job.id);
    try { await advanceJob(db, masterKey, job, options.fetch); }
    catch (error) { await updateJobState(db, job, "needs_attention", null, safeError(error)); }
    finally { await db.prepare("UPDATE email_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(job.id, token).run(); }
  }
  const next = await db.prepare(`SELECT MIN(next_run_at) AS due FROM email_jobs WHERE started_at IS NOT NULL AND status IN ('running','waiting_credits')${options.owner ? " AND owner=?" : ""}`).bind(...(options.owner ? [options.owner] : [])).first<Row>();
  return { advanced: jobIds.length, jobIds, nextDueAt: next?.due ?? null };
}

async function reconcile(context: Context, id: string, body: Row) {
  const job = await ownedJob(context.db, context.owner, id);
  if (job.status === "cancelled" || !job.started_at) throw new EmailServiceError("This job cannot be reconciled.", 409);
  if (typeof body.batchId !== "string" || !jobIdPattern.test(body.batchId) || typeof body.taskId !== "string" || !taskIdPattern.test(body.taskId)) throw new EmailServiceError("Enter the batch and confirmed Reoon task ID.");
  const batch = await context.db.prepare("SELECT * FROM email_batches WHERE id=? AND job_id=?").bind(body.batchId, id).first<Row>();
  if (!batch || batch.mode !== "bulk" || !["unknown", "submitting", "submitted"].includes(batch.status)) throw new EmailServiceError("Only an unresolved bulk batch can be reconciled with its provider task ID.", 409);
  if (batch.task_id && batch.task_id !== body.taskId) throw new EmailServiceError("This batch already has a confirmed provider task ID. Use that saved ID when reconciling.", 409);
  if (job.lease_until && job.lease_until >= Date.now()) throw new EmailServiceError("This batch is currently being processed. Wait for the current operation before reconciling.", 409);
  const reused = await context.db.prepare("SELECT b.id FROM email_batches b JOIN email_jobs j ON j.id=b.job_id WHERE j.owner=? AND j.credential_revision=? AND b.task_id=? AND b.id<>? LIMIT 1").bind(context.owner, job.credential_revision, body.taskId, batch.id).first<Row>();
  if (reused) throw new EmailServiceError("That task ID is already attached to another batch in this account.", 409);
  assertKey(context.masterKey);
  const key = await decryptSecret(job.credential_ciphertext, context.masterKey, keyContext(context.owner, job.credential_revision));
  const expected = await taskEmails(context.db, job, batch);
  const result = await pollReoonBulkTask(providerOptions(key, context.fetch), body.taskId, expected);
  if (!["waiting", "running", "completed"].includes(result.status) || result.totalCount !== null && result.totalCount !== expected.length || result.status === "completed" && !result.identityMatched) throw new EmailServiceError("Reoon did not confirm the exact address list for this batch. Check the task ID and its addresses.", 409);
  const now = Date.now(), token = crypto.randomUUID();
  const claimed = await context.db.prepare("UPDATE email_jobs SET lease_token=?,lease_until=?,status=CASE WHEN status='paused' THEN status ELSE 'running' END,next_run_at=?,completed_at=NULL,updated_at=? WHERE id=? AND owner=? AND status<>'cancelled' AND (lease_until IS NULL OR lease_until<?) RETURNING *").bind(token, now + LEASE_MS, now, now, id, context.owner, now).first<Row>();
  if (!claimed) throw new EmailServiceError("Another operation is handling this job. Refresh before reconciling again.", 409);
  try {
    const changes = await context.db.batch([
      context.db.prepare("UPDATE email_batches SET status='submitted',task_id=?,attempts=0,next_poll_at=?,error=NULL,updated_at=? WHERE id=? AND status IN ('unknown','submitting','submitted') AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled') AND NOT EXISTS (SELECT 1 FROM email_batches other JOIN email_jobs owner_job ON owner_job.id=other.job_id WHERE owner_job.owner=? AND owner_job.credential_revision=? AND other.task_id=? AND other.id<>?)").bind(body.taskId, now, now, batch.id, id, token, context.owner, job.credential_revision, body.taskId, batch.id),
      moveCount(context.db, claimed, batch.id, "unknown", "processing", false, body.taskId),
      context.db.prepare("UPDATE email_targets SET status='processing',reason='',provider_status=NULL,updated_at=? WHERE job_id=? AND batch_id=? AND status='unknown' AND EXISTS (SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled') AND EXISTS (SELECT 1 FROM email_batches WHERE id=? AND status='submitted' AND task_id=?)").bind(now, id, batch.id, id, token, batch.id, body.taskId),
    ]);
    if (changes[0].meta.changes !== 1) throw new EmailServiceError("This batch or task ID changed while it was being checked. Reload the saved job.", 409);
    if (result.status === "completed") await persistResults(context.db, claimed, batch, expected, result.results);
    else await updateJobState(context.db, claimed, "running", now + 30_000, null);
  } catch (error) { await updateJobState(context.db, claimed, "needs_attention", null, safeError(error)); throw error; }
  finally { await context.db.prepare("UPDATE email_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(id, token).run(); }
  return { job: await getJob(context.db, context.owner, id) };
}

export async function handleEmailApi(request: Request, context: Context): Promise<Response | null> {
  const url = new URL(request.url), parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "api" || parts[1] !== "email") return null;
  try {
    if (!context.owner || typeof context.owner !== "string") throw new EmailServiceError("Sign in to your workspace.", 401);
    const route = parts.slice(2), method = request.method;
    const body = method === "GET" ? {} : await bodyOf(request, context.appOrigin);
    if (route[0] === "settings" && route.length === 1) {
      if (method === "GET") return json({ settings: publicSettings(await settingsRow(context), context.masterKey) });
      if (method === "POST" || method === "DELETE") return json(await saveSettings(context, body, method === "DELETE"));
    }
    if (route.join("/") === "settings/check" && method === "POST") return json(await fetchBalance(context, true));
    if (route.join("/") === "balance" && method === "GET") return json(await fetchBalance(context));
    if (route[0] === "jobs" && route.length === 1) {
      if (method === "GET") return json(await listJobs(context, url));
      if (method === "POST") return json(await createJob(context, body), 201);
    }
    if (route[0] === "jobs" && route[1]) {
      const id = route[1];
      if (route.length === 2 && method === "GET") return json(await jobDetail(context, id, url));
      if (route.length === 3 && route[2] === "results" && method === "GET") return json(await resultsPage(context, id, url));
      if (route.length === 3 && method === "POST") {
        if (route[2] === "chunks") return json(await uploadChunk(context, id, body));
        if (route[2] === "seal") return json(await sealJob(context, id, body));
        if (route[2] === "start") return json(await startJob(context, id, body));
        if (route[2] === "action") return json(await actOnJob(context, id, body));
        if (route[2] === "reconcile") return json(await reconcile(context, id, body));
        if (route[2] === "advance") { await ownedJob(context.db, context.owner, id); await advanceEmailQueue(context.db, context.masterKey, { owner: context.owner, jobId: id, maxSteps: 1, fetch: context.fetch }); return json({ job: await getJob(context.db, context.owner, id) }); }
      }
    }
    return json({ error: "This email-verification action is not available." }, 404);
  } catch (error) {
    if (error instanceof EmailServiceError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ReoonError) return json({ error: error.message, code: `email_provider_${error.kind}`, outcome: error.submissionOutcome }, 502);
    return json({ error: "The email-verification operation could not be completed. Reload the saved job before retrying; no automatic paid resubmission was attempted." }, 500);
  }
}
