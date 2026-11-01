import { MarketingError, publicHost, relayOrigin, type Context, type Row } from "./common";

const MAX_RESPONSE = 65_536;
function publicIp(value: string) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    const parts = value.split(".").map(Number);
    if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = parts;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  // Accept global unicast IPv6 only; exclude transition/documentation ranges.
  return /^[23][0-9a-f]{0,3}:/i.test(value) && !/^2001:(?:0*:|db8:|0?1[0-9a-f]:|0?2[0-9a-f]:)/i.test(value) && !/^2002:/i.test(value) && /^[0-9a-f:]+$/i.test(value);
}
async function readJson(response: Response): Promise<Row> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) { await response.body?.cancel(); throw new Error("Unexpected response"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty response");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let raw = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_RESPONSE) { await reader.cancel(); throw new Error("Oversized response"); }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { reader.releaseLock(); }
  const result = JSON.parse(raw);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Unexpected response");
  return result;
}
/** Validate DNS before sending a credential-bearing HTTPS request. Redirects are never followed. */
async function verifyPublicDns(origin: string, fetcher: typeof fetch) {
  const hostname = publicHost(new URL(origin).hostname, "SMTP service");
  try {
    const results = await Promise.all(["A", "AAAA"].map(async type => {
      const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { Accept: "application/dns-json" }, redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("DNS unavailable");
      const result = await readJson(response);
      if (result.Status !== 0 && result.Status !== 3) throw new Error("DNS unavailable");
      const answers = Array.isArray(result.Answer) ? result.Answer : [];
      if (answers.length > 100) throw new Error("DNS answer too large");
      return answers.filter((answer: Row) => answer.type === 1 || answer.type === 28).map((answer: Row) => String(answer.data));
    }));
    const addresses = results.flat();
    if (!addresses.length || addresses.some(value => !publicIp(value))) throw new Error("Nonpublic address");
  } catch { throw new MarketingError("The SMTP service must resolve to a reachable public address. Its DNS check did not pass.", 502, "relay_dns_failed"); }
}
export type SmtpCredentials = { host: string; port: number; security: "tls" | "starttls"; username: string; password: string; fromEmail: string; fromName: string; replyTo: string };
export type RelayConnection = { url: string; token: string };
export type RelayDelivery = { status: "accepted" | "failed" | "unknown" | "suppressed" | "not_submitted"; messageId: string | null; error: string | null };
export async function relayRequest(context: Pick<Context, "fetch">, connection: RelayConnection, path: string, body?: Row, timeout = 55_000, beforeSend?: () => Promise<boolean>) {
  const origin = relayOrigin(connection.url), fetcher = context.fetch || fetch;
  await verifyPublicDns(origin, fetcher);
  if (beforeSend && !await beforeSend()) throw new MarketingError("Sending stopped before SMTP submission.", 409, "relay_not_submitted");
  let response: Response;
  try {
    response = await fetcher(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Service rejection"); }
    return await readJson(response);
  } catch { throw new MarketingError("The SMTP service did not confirm this request. Check its connection and saved delivery history.", 502, "relay_unconfirmed"); }
}
export async function checkRelay(context: Pick<Context, "fetch">, connection: RelayConnection) {
  const result = await relayRequest(context, connection, "/v1/health", undefined, 10_000);
  if (result.ok !== true || result.service !== "trezad-smtp-relay") throw new MarketingError("This URL did not identify a compatible SMTP service.", 502);
}
export async function checkAccount(context: Pick<Context, "fetch">, connection: RelayConnection, account: SmtpCredentials) {
  const result = await relayRequest(context, connection, "/v1/check", { account });
  if (result.ok !== true) throw new MarketingError("The SMTP check failed. Review the host, port, TLS mode and credentials.", 502);
}
export async function sendRelay(context: Pick<Context, "fetch">, connection: RelayConnection, payload: Row, beforeSend?: () => Promise<boolean>): Promise<RelayDelivery> {
  try {
    const result = await relayRequest(context, connection, "/v1/send", payload, 55_000, beforeSend);
    if (!["accepted", "failed", "unknown", "suppressed"].includes(result.status)) throw new Error("Unexpected result");
    const messageId = typeof result.messageId === "string" && result.messageId.length <= 512 && !/[\r\n\u0000]/.test(result.messageId) ? result.messageId : null;
    const messages = { accepted: null, failed: "SMTP did not accept this message. Check the account and delivery report before a new campaign.", unknown: "SMTP acceptance was not confirmed. This recipient will not be retried automatically.", suppressed: "This address unsubscribed or is suppressed and was not sent." };
    return { status: result.status, messageId, error: messages[result.status as keyof typeof messages] };
  } catch (error) {
    if (error instanceof MarketingError && ["relay_not_submitted", "relay_dns_failed"].includes(error.code)) return { status: "not_submitted", messageId: null, error: error.code === "relay_dns_failed" ? error.message : "Sending paused or the account changed before submission." };
    return { status: "unknown", messageId: null, error: "The SMTP service did not confirm acceptance. This recipient will not be retried automatically." };
  }
}
