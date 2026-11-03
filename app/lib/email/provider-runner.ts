import { advanceEmailQueue } from "./provider-service";
import { isEncryptionKeyReady } from "../secret-store";

type RunnerContext = { db: D1Database; masterKey?: string; tokenHash?: string };
const HEARTBEAT_WINDOW = 75 * 60 * 1000;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
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
  return { enabled, healthy, lastHeartbeatAt, message: healthy ? "Background verification is connected."
    : enabled ? "The verification worker has not checked in recently." : "Background verification is not configured." };
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
    const b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 0;
  } catch { return false; }
  finally { reader.releaseLock(); }
}
/** No imports, job starts, connection edits or campaign actions are accepted here. */
export async function handleEmailWorker(request: Request, context: RunnerContext): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405, headers: { ...headers, Allow: "POST" } });
  if (!await validEmailWorkerToken(request.headers.get("x-email-worker-token"), context.tokenHash)) return Response.json({ error: "Worker access was not accepted." }, { status: 401, headers });
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || origin && origin !== new URL(request.url).origin) return Response.json({ error: "Cross-site worker request rejected." }, { status: 403, headers });
  if (!await emptyPayload(request)) return Response.json({ error: "Use an empty JSON object." }, { status: 400, headers });
  if (!isEncryptionKeyReady(context.masterKey)) return Response.json({ error: "Secure settings are unavailable." }, { status: 503, headers });
  try {
    const progress = await advanceEmailQueue(context.db, context.masterKey!, { maxSteps: 1 });
    const now = Date.now();
    await context.db.prepare("INSERT INTO email_worker_state(key,last_run_at,last_error) VALUES('queue',?,NULL) ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=NULL").bind(now).run();
    return Response.json({ ok: true, ...progress, checkedAt: now }, { headers });
  } catch {
    try { await context.db.prepare("INSERT INTO email_worker_state(key,last_run_at,last_error) VALUES('queue',?,'Verification worker needs attention.') ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=excluded.last_error").bind(Date.now()).run(); } catch { /* Preserve the original failure. */ }
    return Response.json({ error: "Worker step failed. Saved progress is retained." }, { status: 503, headers });
  }
}
