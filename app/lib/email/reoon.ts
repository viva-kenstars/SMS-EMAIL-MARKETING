/**
 * Server-only Reoon transport. Never import this module into a client component.
 * Native bulk tasks are used for lists; the single endpoint is only for logical
 * jobs containing fewer than ten addresses. This adapter never retries a request.
 * Provider contract: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/
 */

export type ReoonCategory = "valid" | "invalid" | "risky" | "unknown";
export type ReoonErrorKind = "auth" | "credits" | "rate_limit" | "temporary" | "uncertain" | "invalid_response" | "rejected";
export type ReoonSubmissionOutcome = "not_submitted" | "rejected" | "accepted" | "uncertain";

export interface ReoonOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ReoonBalance {
  dailyCredits: number;
  instantCredits: number;
  apiStatus: "active";
}

export interface ReoonBulkTask {
  taskId: string;
  submittedCount: number | null;
  processingCount: number | null;
  duplicatesRemoved: number | null;
  rejectedCount: number | null;
}

export interface ReoonEmailResult {
  email: string;
  category: ReoonCategory;
  /** A stable, sanitized reason code, never arbitrary provider text. */
  reason: string;
  providerStatus: string | null;
}

export interface ReoonPollResult {
  taskId: string;
  status: "waiting" | "running" | "completed" | "file_not_found" | "file_loading_error" | "unknown";
  totalCount: number | null;
  checkedCount: number | null;
  progressPercent: number | null;
  /** True only when a completed task's raw result identities exactly match the requested set. */
  identityMatched: boolean;
  /** Completed tasks contain exactly one row per expected, unique address. */
  results: ReoonEmailResult[];
}

const ERROR_MESSAGES: Record<ReoonErrorKind, string> = {
  auth: "Reoon authentication failed. Check the saved API key.",
  credits: "Reoon has insufficient verification credits.",
  rate_limit: "Reoon is limiting requests. Try again later.",
  temporary: "Reoon is temporarily unavailable. Try again later.",
  uncertain: "Reoon did not confirm the request. Check its task history before submitting again.",
  invalid_response: "Reoon returned an unexpected response.",
  rejected: "Reoon rejected the request.",
};

export class ReoonError extends Error {
  readonly kind: ReoonErrorKind;
  readonly submissionOutcome: ReoonSubmissionOutcome;
  readonly taskId?: string;
  readonly retryAfterSeconds?: number;

  constructor(kind: ReoonErrorKind, submissionOutcome: ReoonSubmissionOutcome, details?: {
    taskId?: string;
    retryAfterSeconds?: number;
  }) {
    super(ERROR_MESSAGES[kind]);
    this.name = "ReoonError";
    this.kind = kind;
    this.submissionOutcome = submissionOutcome;
    if (details?.taskId && safeTaskId(details.taskId)) this.taskId = details.taskId;
    if (Number.isSafeInteger(details?.retryAfterSeconds) && details!.retryAfterSeconds! >= 0) {
      this.retryAfterSeconds = Math.min(details!.retryAfterSeconds!, 86_400);
    }
  }
}

const ORIGIN = "https://emailverifier.reoon.com";
const MAX_BULK_SIZE = 50_000;
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const SINGLE_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 120_000;
type JsonRecord = Record<string, unknown>;
type RequestKind = "read" | "create" | "single";

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Conventional ASCII addresses only; unsupported formats need local review. */
export function normalizeEmailIdentity(value: string): string | null {
  if (typeof value !== "string" || value.length > 254 || /[^\x21-\x7e]/.test(value)) return null;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return `${local}@${domain}`;
}

function identities(emails: readonly string[], minimum: number): string[] {
  if (!Array.isArray(emails) || emails.length < minimum || emails.length > MAX_BULK_SIZE) {
    throw new ReoonError("rejected", "not_submitted");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const identity = normalizeEmailIdentity(email);
    if (!identity || seen.has(identity)) throw new ReoonError("rejected", "not_submitted");
    seen.add(identity);
    normalized.push(identity);
  }
  return normalized;
}

function safeTaskId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d{0,31}$/.test(value) ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function optionalCount(body: JsonRecord, key: string, outcome: ReoonSubmissionOutcome = "not_submitted", taskId?: string): number | null {
  if (!(key in body)) return null;
  const count = nonnegativeInteger(body[key]);
  if (count === null) throw new ReoonError("invalid_response", outcome, { taskId });
  return count;
}

function progress(value: unknown): number | null {
  if (value === undefined) return null;
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new ReoonError("invalid_response", "not_submitted");
  return number;
}

function validatedOptions(options: ReoonOptions, kind: RequestKind) {
  if (typeof window !== "undefined") throw new ReoonError("rejected", "not_submitted");
  if (!options || typeof options.apiKey !== "string" || !options.apiKey.length || options.apiKey.length > 4096
    || /[\x00-\x20\x7f]/.test(options.apiKey)) throw new ReoonError("auth", "not_submitted");
  const timeoutMs = options.timeoutMs ?? (kind === "single" ? SINGLE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES
    || (options.fetch !== undefined && typeof options.fetch !== "function")) {
    throw new ReoonError("rejected", "not_submitted");
  }
  return { timeoutMs, maxResponseBytes, fetcher: options.fetch ?? globalThis.fetch };
}

function unconfirmed(kind: RequestKind, malformed = false): ReoonError {
  return new ReoonError(kind === "read" ? (malformed ? "invalid_response" : "temporary") : "uncertain",
    kind === "read" ? "not_submitted" : "uncertain");
}

function cancelBody(response: Response) {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

function hasDuplicateObjectKeys(json: string): boolean {
  // JSON.parse otherwise discards duplicate object keys before identity checks
  // can see them. Scan already-valid JSON without retaining a second object tree.
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
  for (const token of json.matchAll(tokens)) {
    const value = token[0];
    if (value === "{") { stack.push({ keys: new Set(), expectingKey: true }); continue; }
    if (value === "[") { stack.push(null); continue; }
    if (value === "}" || value === "]") { stack.pop(); continue; }
    const current = stack[stack.length - 1];
    if (!current) continue;
    if (value === ",") current.expectingKey = true;
    else if (value === ":") current.expectingKey = false;
    else if (value.startsWith('"') && current.expectingKey) {
      const key = JSON.parse(value) as string;
      if (current.keys.has(key)) return true;
      current.keys.add(key);
      current.expectingKey = false;
    }
  }
  return false;
}

async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<JsonRecord> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    cancelBody(response);
    throw new Error("Response limit");
  }
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("Request timeout");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        cancel();
        throw new Error("Response limit");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    if (signal.aborted) throw new Error("Request timeout");
    parts.push(decoder.decode());
    const json = parts.join("");
    const parsed: unknown = JSON.parse(json);
    if (!record(parsed) || hasDuplicateObjectKeys(json)) throw new Error("Unexpected response");
    return parsed;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function explicitRejection(body: JsonRecord, kind: RequestKind): ReoonError {
  // Read only a short reason to classify the error. Never retain or return it.
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 512).toLowerCase() : "";
  let errorKind: ReoonErrorKind = "rejected";
  if (/(?:insufficient|not enough|no remaining|exhausted|out of).{0,35}credit|credit.{0,35}(?:insufficient|exhausted|required)/.test(reason)) {
    errorKind = "credits";
  } else if (/(?:invalid|inactive|incorrect|missing|disabled).{0,25}(?:api.?key|authentication)|(?:api.?key).{0,25}(?:invalid|inactive|incorrect|missing|disabled)|unauthori[sz]ed/.test(reason)) {
    errorKind = "auth";
  } else if (/rate.?limit|too many requests|throttl/.test(reason)) {
    errorKind = "rate_limit";
  } else if (/temporar(?:y|ily) unavailable|service unavailable/.test(reason)) {
    errorKind = "temporary";
  }
  return new ReoonError(errorKind, kind === "read" ? "not_submitted" : "rejected");
}

async function requestJson(options: ReoonOptions, path: string, kind: RequestKind,
  params?: Record<string, string>, payload?: Record<string, unknown>): Promise<{ body: JsonRecord; status: number }> {
  const { timeoutMs, maxResponseBytes, fetcher } = validatedOptions(options, kind);
  const url = new URL(path, ORIGIN);
  // All paths are constants supplied by this module; there is no configurable URL.
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (kind !== "create") url.searchParams.set("key", options.apiKey);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(unconfirmed(kind));
    }, timeoutMs);
  });
  const run = async () => {
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: kind === "create" ? "POST" : "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
        headers: kind === "create" ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
        ...(kind === "create" ? { body: JSON.stringify({ ...payload, key: options.apiKey }) } : {}),
      });
    } catch {
      throw unconfirmed(kind);
    }
    if (controller.signal.aborted) { cancelBody(response); throw unconfirmed(kind); }
    if (response.status >= 300 && response.status < 400) { cancelBody(response); throw unconfirmed(kind, true); }
    if (response.status === 401 || response.status === 403 || response.status === 402 || response.status === 429) {
      const seconds = nonnegativeInteger(response.headers.get("retry-after"));
      cancelBody(response);
      throw new ReoonError(response.status === 402 ? "credits" : response.status === 429 ? "rate_limit" : "auth",
        kind === "read" ? "not_submitted" : "rejected", { retryAfterSeconds: seconds ?? undefined });
    }
    if (response.status >= 500 || response.status === 408) { cancelBody(response); throw unconfirmed(kind); }
    let body: JsonRecord;
    try {
      body = await boundedJson(response, maxResponseBytes, controller.signal);
    } catch {
      if (response.status >= 400 && response.status < 500) {
        throw new ReoonError("rejected", kind === "read" ? "not_submitted" : "rejected");
      }
      throw unconfirmed(kind, !controller.signal.aborted);
    }
    if (body.status === "error") throw explicitRejection(body, kind);
    if (!response.ok) throw new ReoonError("rejected", kind === "read" ? "not_submitted" : "rejected");
    return { body, status: response.status };
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function getReoonBalance(options: ReoonOptions): Promise<ReoonBalance> {
  const { body } = await requestJson(options, "/api/v1/check-account-balance/", "read");
  if (body.api_status === "inactive" || body.api_status === "disabled") throw new ReoonError("auth", "not_submitted");
  const dailyCredits = nonnegativeInteger(body.remaining_daily_credits);
  const instantCredits = nonnegativeInteger(body.remaining_instant_credits);
  if (body.status !== "success" || body.api_status !== "active" || dailyCredits === null || instantCredits === null
    || !Number.isSafeInteger(dailyCredits + instantCredits)) throw new ReoonError("invalid_response", "not_submitted");
  return { dailyCredits, instantCredits, apiStatus: "active" };
}

export async function createReoonBulkTask(options: ReoonOptions, emails: readonly string[], name?: string): Promise<ReoonBulkTask> {
  const normalized = identities(emails, 10);
  if (name !== undefined && (typeof name !== "string" || name.length > 25 || /[\x00-\x1f\x7f]/.test(name))) {
    throw new ReoonError("rejected", "not_submitted");
  }
  const { body, status } = await requestJson(options, "/api/v1/create-bulk-verification-task/", "create", undefined,
    { emails: normalized, ...(name === undefined ? {} : { name }) });
  const taskId = safeTaskId(body.task_id);
  if (status !== 201 || body.status !== "success" || !taskId) {
    throw new ReoonError("uncertain", "uncertain", { taskId: taskId ?? undefined });
  }
  // The official live example omits some counts. A positive task acknowledgement
  // remains accepted; absent counts are unknown, never invented as zero.
  const submittedCount = optionalCount(body, "count_submitted", "accepted", taskId);
  const processingCount = optionalCount(body, "count_processing", "accepted", taskId);
  const duplicatesRemoved = optionalCount(body, "count_duplicates_removed", "accepted", taskId);
  const rejectedCount = optionalCount(body, "count_rejected_emails", "accepted", taskId);
  if ((submittedCount !== null && submittedCount !== normalized.length)
    || [processingCount, duplicatesRemoved, rejectedCount].some(count => count !== null && count > normalized.length)
    || (processingCount !== null && duplicatesRemoved !== null && rejectedCount !== null
      && processingCount + duplicatesRemoved + rejectedCount !== normalized.length)) {
    throw new ReoonError("invalid_response", "accepted", { taskId });
  }
  return { taskId, submittedCount, processingCount, duplicatesRemoved, rejectedCount };
}

const PROVIDER_STATUSES = new Set(["safe", "invalid", "disabled", "disposable", "inbox_full", "catch_all", "role_account", "spamtrap", "unknown"]);
const RISK_FLAGS = [
  ["is_disposable", "disposable"],
  ["is_role_account", "role_account"],
  ["has_inbox_full", "inbox_full"],
  ["is_catch_all", "catch_all"],
  ["is_spamtrap", "spamtrap"],
] as const;

function unknownResult(email: string, reason: string, providerStatus: string | null = null): ReoonEmailResult {
  return { email, category: "unknown", reason, providerStatus };
}

function classifyResult(row: JsonRecord, email: string, requirePowerMode = false): ReoonEmailResult {
  const status = typeof row.status === "string" && PROVIDER_STATUSES.has(row.status) ? row.status : null;
  if (!status) return unknownResult(email, "unrecognized_status");
  if ((requirePowerMode && row.verification_mode !== "power")
    || (row.verification_mode !== undefined && row.verification_mode !== "power")) {
    return unknownResult(email, "verification_mode_unconfirmed", status);
  }
  if (status === "unknown") return unknownResult(email, "provider_unknown", status);
  if (status === "invalid" || status === "disabled") {
    return row.is_safe_to_send === true ? unknownResult(email, "conflicting_result", status)
      : { email, category: "invalid", reason: status, providerStatus: status };
  }
  if (status !== "safe") return { email, category: "risky", reason: status, providerStatus: status };
  for (const [flag, reason] of RISK_FLAGS) {
    if (row[flag] === true) return { email, category: "risky", reason, providerStatus: status };
  }
  if (row.is_disabled === true) return unknownResult(email, "conflicting_result", status);
  if (row.is_safe_to_send !== true || row.is_deliverable !== true || row.is_disabled !== false
    || RISK_FLAGS.some(([flag]) => row[flag] !== false)
    || ["is_valid_syntax", "mx_accepts_mail", "can_connect_smtp"].some(flag => flag in row && row[flag] !== true)) {
    return unknownResult(email, "unconfirmed_safety", status);
  }
  return { email, category: "valid", reason: "safe", providerStatus: status };
}

function normalizeResults(value: unknown, expected: string[]): Pick<ReoonPollResult, "results" | "identityMatched"> {
  if (!Array.isArray(value) && !record(value)) throw new ReoonError("invalid_response", "not_submitted");
  const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
    ? value.map(row => [undefined, row]) : Object.entries(value);
  const requested = new Set(expected);
  const rows = new Map<string, ReoonEmailResult>();
  const seen = new Set<string>();
  const mismatched = new Set<string>();
  let identityMatched = entries.length === expected.length;
  for (const [key, row] of entries) {
    const keyIdentity = key === undefined ? null : normalizeEmailIdentity(key);
    const rowIdentity = record(row) && typeof row.email === "string" ? normalizeEmailIdentity(row.email) : null;
    if (!record(row) || !rowIdentity || (key !== undefined && keyIdentity !== rowIdentity)) {
      identityMatched = false;
      for (const identity of [keyIdentity, rowIdentity]) if (identity && requested.has(identity)) mismatched.add(identity);
      continue;
    }
    if (!requested.has(rowIdentity)) { identityMatched = false; continue; }
    if (seen.has(rowIdentity)) {
      identityMatched = false;
      rows.set(rowIdentity, unknownResult(rowIdentity, "duplicate_result"));
    }
    else rows.set(rowIdentity, classifyResult(row, rowIdentity));
    seen.add(rowIdentity);
  }
  return {
    identityMatched: identityMatched && seen.size === expected.length && mismatched.size === 0,
    results: expected.map(email => mismatched.has(email) ? unknownResult(email, "result_identity_mismatch")
      : rows.get(email) ?? unknownResult(email, "missing_result")),
  };
}

export async function pollReoonBulkTask(options: ReoonOptions, taskId: string, expectedEmails: readonly string[]): Promise<ReoonPollResult> {
  const requestedId = safeTaskId(taskId);
  const expected = identities(expectedEmails, 1);
  if (!requestedId) throw new ReoonError("rejected", "not_submitted");
  const { body } = await requestJson(options, "/api/v1/get-result-bulk-verification-task/", "read", { task_id: requestedId });
  if (safeTaskId(body.task_id) !== requestedId) throw new ReoonError("invalid_response", "not_submitted");
  const totalCount = optionalCount(body, "count_total");
  const checkedCount = optionalCount(body, "count_checked");
  const progressPercent = progress(body.progress_percentage);
  if (totalCount !== null && checkedCount !== null && checkedCount > totalCount) throw new ReoonError("invalid_response", "not_submitted");
  const status = body.status === "waiting" || body.status === "running" || body.status === "completed"
    || body.status === "file_not_found" || body.status === "file_loading_error" ? body.status : "unknown";
  return { taskId: requestedId, status, totalCount, checkedCount, progressPercent,
    ...(status === "completed" ? normalizeResults(body.results, expected) : { results: [], identityMatched: false }) };
}

/** Only use for a logical job of 1–9 addresses; never loop over a bulk list. */
export async function verifyReoonSinglePower(options: ReoonOptions, email: string): Promise<ReoonEmailResult> {
  const [normalized] = identities([email], 1);
  const { body } = await requestJson(options, "/api/v1/verify", "single", { email: normalized, mode: "power" });
  if (typeof body.email !== "string" || normalizeEmailIdentity(body.email) !== normalized) {
    return unknownResult(normalized, "result_identity_mismatch");
  }
  return classifyResult(body, normalized, true);
}
