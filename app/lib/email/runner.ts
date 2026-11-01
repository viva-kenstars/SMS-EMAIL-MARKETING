import { advanceEmailQueue } from "./service";
import { isEncryptionKeyReady } from "../secret-store";

type RunnerContext = { db: D1Database; masterKey?: string; tokenHash?: string };
// The linked cloud task runs hourly; allow fifteen minutes of scheduling jitter.
// The SMTP companion may also advance this verifier more frequently.
const HEARTBEAT_WINDOW = 75 * 60 * 1000;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** A fingerprint is stored, never the service credential itself. */
export async function validEmailWorkerToken(token: string | null, expectedHash?: string): Promise<boolean> {
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || !token || token.length > 16_384) return false;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const expected = Uint8Array.from(expectedHash.match(/.{2}/g)!, part => parseInt(part, 16));
  let difference = 0;
  for (let i = 0; i < hash.length; i++) difference |= hash[i] ^ expected[i];
  return difference === 0;
}

export async function emailRunnerStatus(context: RunnerContext) {
  const enabled = !!context.tokenHash && /^[a-f0-9]{64}$/.test(context.tokenHash) && isEncryptionKeyReady(context.masterKey);
  const row = await context.db.prepare("SELECT last_run_at,last_error FROM email_worker_state WHERE key='queue'").first<{ last_run_at: number | null; last_error: string | null }>();
  const lastHeartbeatAt = row?.last_run_at ?? null;
  const healthy = enabled && lastHeartbeatAt !== null && lastHeartbeatAt <= Date.now() && Date.now() - lastHeartbeatAt <= HEARTBEAT_WINDOW && !row?.last_error;
  return {
    enabled, healthy, lastHeartbeatAt,
    message: healthy ? "Background verification is connected. Started jobs continue during automatic checks after you close this page."
      : enabled ? "The background runner has not checked in recently. Keep this page open to continue a started job while the runner reconnects."
        : "Background processing is not configured. Keep this page open while a started job runs.",
  };
}

async function emptyPayload(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); return false; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch { return false; }
}

/**
 * Private service endpoint. Sites first validates OAI-Sites-Authorization.
 * The application independently checks X-Email-Worker-Token against its
 * protected fingerprint. It can only advance jobs explicitly started by owners;
 * this endpoint cannot import lists, edit keys, start jobs or send messages.
 */
export async function handleEmailWorker(request: Request, context: RunnerContext): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405, headers: { ...headers, Allow: "POST" } });
  if (!await validEmailWorkerToken(request.headers.get("x-email-worker-token"), context.tokenHash)) return Response.json({ error: "Background worker access was not accepted." }, { status: 401, headers });
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || origin && origin !== new URL(request.url).origin) return Response.json({ error: "This worker request came from a different website." }, { status: 403, headers });
  if (!await emptyPayload(request)) return Response.json({ error: "Use an empty JSON object." }, { status: 400, headers });
  if (!isEncryptionKeyReady(context.masterKey)) return Response.json({ error: "Secure API settings are unavailable." }, { status: 503, headers });
  try {
    // One step can include a balance read followed by a90-second Power check
    // for a small test list. The scheduler allows120seconds for this request;
    // subsequent persisted work is advanced by a new request.
    const progress = await advanceEmailQueue(context.db, context.masterKey!, { maxSteps: 1 });
    const now = Date.now();
    await context.db.prepare("INSERT INTO email_worker_state(key,last_run_at,last_error) VALUES('queue',?,NULL) ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=NULL").bind(now).run();
    return Response.json({ ok: true, ...progress, checkedAt: now }, { headers });
  } catch {
    try {
      await context.db.prepare("INSERT INTO email_worker_state(key,last_run_at,last_error) VALUES('queue',?,'Background processing needs another attempt.') ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=excluded.last_error").bind(Date.now()).run();
    } catch { /* A database failure cannot be recorded in that same database. */ }
    return Response.json({ error: "Background processing could not finish this step. Saved progress has been retained." }, { status: 503, headers });
  }
}
