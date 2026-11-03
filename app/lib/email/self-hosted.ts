/** Server-only transport for the Sendzad verification service. Never calls Reoon. */
export type SelfConfig = { url: string; token: string };
export type SelfResult = {
  email: string; engine: "sendzad"; engine_version: string;
  category: "valid" | "invalid" | "risky" | "unknown"; reason: string;
  checked_at: number; retryable: boolean; retry_after_seconds?: number;
  syntax: string; mail_route: string; smtp: string; catch_all: boolean | null;
  role_account: boolean; disposable: string; spam_trap: "not_assessed";
  smtp_code?: number; stage?: string; cached: boolean;
};
export function validateSelfConfig(input: SelfConfig): SelfConfig {
  let url: URL;
  try { url = new URL(input.url); } catch { throw new Error("Configure the Sendzad verifier HTTPS URL."); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || url.search || url.hash || url.pathname !== "/" ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) ||
      /^\d+(\.\d+){3}$/.test(host) || /(?:^|\.)(localhost|local|internal)$/.test(host)) {
    throw new Error("Use a dedicated HTTPS verifier origin in private server configuration.");
  }
  if (!/^[\x21-\x7e]{32,256}$/.test(input.token)) throw new Error("Configure a private Sendzad verifier token.");
  return { url: url.origin, token: input.token };
}
export async function selfConfigHash(config: SelfConfig): Promise<string> {
  const c = validateSelfConfig(config);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.url + "\n" + c.token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
async function request(config: SelfConfig, path: string, body: unknown, fetcher: typeof fetch): Promise<any> {
  const c = validateSelfConfig(config);
  let response: Response;
  try {
    response = await fetcher(c.url + path, {
      method: body === undefined ? "GET" : "POST", redirect: "manual",
      signal: AbortSignal.timeout(22_000),
      headers: { Authorization: `Bearer ${c.token}`, Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Error("Sendzad connection failed. Pending work is retained; no paid fallback was used."); }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    throw new Error("Sendzad request was not accepted. Check the service; no Reoon credits were used.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Sendzad returned an empty response.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) { await reader.cancel(); throw new Error(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { throw new Error("Sendzad returned invalid data. No results were accepted."); }
  finally { reader.releaseLock(); }
}
export async function checkSelfHealth(config: SelfConfig, fetcher: typeof fetch = fetch) {
  const r = await request(config, "/v1/health", undefined, fetcher);
  if (r?.engine !== "sendzad" || r.smtp_enabled !== true || r.max_batch !== 4 ||
      r.paid_fallback !== false || !/^\d+\.\d+\.\d+$/.test(r.engine_version || "")) {
    throw new Error("Sendzad service is not ready for SMTP checks.");
  }
  return { engine: "sendzad", version: r.engine_version, smtpEnabled: true,
    maxBatch: 4, paidFallback: false, acceptanceTested: false };
}
export function validateSelfResults(payload: any, expected: string[], now = Date.now()): SelfResult[] {
  if (payload?.engine !== "sendzad" || !Array.isArray(payload.results) ||
      payload.results.length !== expected.length) throw new Error("Incomplete verifier results.");
  const mapped = new Map<string, SelfResult>();
  for (const r of payload.results) {
    if (!r || typeof r.email !== "string" || !expected.includes(r.email) || mapped.has(r.email) ||
        r.engine !== "sendzad" || !/^\d+\.\d+\.\d+$/.test(r.engine_version || "") ||
        !["valid", "invalid", "risky", "unknown"].includes(r.category) ||
        typeof r.retryable !== "boolean" || typeof r.cached !== "boolean" ||
        typeof r.reason !== "string" || !/^[a-z_]{1,100}$/.test(r.reason) ||
        !Number.isSafeInteger(r.checked_at) || r.checked_at * 1000 > now + 300_000 ||
        r.checked_at * 1000 < now - 86_400_000 || r.spam_trap !== "not_assessed" ||
        (r.retry_after_seconds !== undefined && (!Number.isSafeInteger(r.retry_after_seconds) ||
          r.retry_after_seconds < 0 || r.retry_after_seconds > 3600))) {
      throw new Error("Mismatched or invalid verifier evidence.");
    }
    if (r.category === "valid" && (r.syntax !== "valid" || r.mail_route !== "present" ||
        r.smtp !== "accepted" || r.catch_all !== false || r.role_account !== false ||
        !["not_listed", "not_assessed"].includes(r.disposable) ||
        r.reason !== "recipient_accepted_non_catch_all" || r.retryable)) {
      throw new Error("Positive result lacks mailbox evidence.");
    }
    if (r.category === "invalid") {
      if (!["invalid_syntax", "null_mx", "no_mail_route", "recipient_rejected"].includes(r.reason) ||
          (r.reason === "invalid_syntax" && r.syntax !== "invalid") ||
          (r.reason === "recipient_rejected" && (r.stage !== "rcpt_to" || r.smtp !== "absent" ||
            !Number.isInteger(r.smtp_code) || r.smtp_code < 500 || r.smtp_code >= 600))) {
        throw new Error("Permanent failure was not established.");
      }
    }
    if (r.category !== "unknown" && r.retryable) throw new Error("Contradictory verifier result.");
    mapped.set(r.email, r);
  }
  return expected.map(email => mapped.get(email)!);
}
export async function verifySelf(config: SelfConfig, emails: string[], fetcher: typeof fetch = fetch) {
  if (emails.length < 1 || emails.length > 4 || new Set(emails).size !== emails.length) {
    throw new Error("Use one to four distinct addresses per step.");
  }
  return validateSelfResults(await request(config, "/v1/verify", { emails }, fetcher), emails);
}
