/** Provider pinning and durable self-hosted checks. Old unbound jobs remain Reoon. */
import { validateSelfConfig, selfConfigHash, checkSelfHealth, verifySelf, type SelfConfig } from "./self-hosted.ts";
type Row = Record<string, any>;
type Context = { db: D1Database; owner: string; masterKey?: string; fetch?: typeof fetch; appOrigin?: string };
type Options = { owner?: string; jobId?: string; maxSteps?: number; fetch?: typeof fetch };
type Dependencies = {
  legacyApi: (r: Request, c: Context) => Promise<Response | null>;
  legacyQueue: (db: D1Database, key: string | undefined, o: Options) => Promise<any>;
  connection: () => SelfConfig;
};
class RouteError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const output = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
async function readBody(request: Request, c: Context): Promise<Row> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== new URL(request.url).origin && origin !== c.appOrigin)) throw new RouteError("Open this action from your workspace.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new RouteError("Use JSON.", 415);
  if (Number(request.headers.get("content-length")) > 4096) throw new RouteError("Request too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RouteError("Use a JSON object.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new RouteError("Request too large.", 413); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const b = JSON.parse(text);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b;
  } catch (e) { if (e instanceof RouteError) throw e; throw new RouteError("Use valid JSON."); }
  finally { reader.releaseLock(); }
}
export function createVerificationRouter(deps: Dependencies) {
  const connection = () => validateSelfConfig(deps.connection());
  async function owned(c: Context, id: string) {
    const r = await c.db.prepare("SELECT j.*,COALESCE(e.engine,'reoon') engine,e.config_hash FROM email_jobs j LEFT JOIN email_verification_engines e ON e.job_id=j.id WHERE j.id=? AND j.owner=?").bind(id, c.owner).first<Row>();
    if (!r) throw new RouteError("Job not found.", 404);
    return r;
  }
  async function decorate(response: Response | null, c: Context): Promise<Response | null> {
    if (!response?.ok) return response;
    const d = await response.json() as Row;
    if (d.job) d.job.engine = (await owned(c, d.job.id)).engine;
    if (Array.isArray(d.jobs) && d.jobs.length) {
      const r = await c.db.prepare("SELECT e.job_id,e.engine FROM email_verification_engines e JOIN email_jobs j ON j.id=e.job_id WHERE j.owner=? AND e.job_id IN (SELECT value FROM json_each(?))").bind(c.owner, JSON.stringify(d.jobs.map((j: Row) => j.id))).all<Row>();
      const engines = new Map(r.results.map(x => [x.job_id, x.engine]));
      for (const j of d.jobs) j.engine = engines.get(j.id) || "reoon";
    }
    return output(d, response.status);
  }
  async function jobDetail(c: Context, id: string) {
    return decorate(await deps.legacyApi(new Request(`https://workspace.invalid/api/email/jobs/${id}`), c), c);
  }
  async function handleEmailApi(request: Request, c: Context): Promise<Response | null> {
    const u = new URL(request.url);
    if (!u.pathname.startsWith("/api/email/")) return null;
    if (!c.owner) return output({ error: "Sign in." }, 401);
    const route = u.pathname.slice(11).replace(/\/+$/, ""), method = request.method;
    try {
      if (route === "self/settings" && method === "GET") {
        let configured = false, serviceUrl = "";
        try { serviceUrl = connection().url; configured = true; } catch { /* No secret is returned. */ }
        return output({ engine: "sendzad", defaultEngine: "sendzad", configured, serviceUrl, paidFallback: false });
      }
      if (route === "self/check" && method === "POST") {
        await readBody(request, c);
        return output(await checkSelfHealth(connection(), c.fetch));
      }
      if (route === "jobs" && method === "POST") {
        const b = await readBody(request, c), provider = b.provider ?? "sendzad";
        if (!["sendzad", "reoon"].includes(provider)) throw new RouteError("Choose Sendzad or Reoon.");
        const name = typeof b.name === "string" ? b.name.trim() : "Email verification";
        const source = typeof b.sourceName === "string" ? b.sourceName : "";
        if (!name || name.length > 120 || source.length > 200 || /[\x00-\x1f\x7f]/.test(name + source)) throw new RouteError("Enter a valid list name.");
        const id = crypto.randomUUID(), now = Date.now();
        await c.db.batch([
          c.db.prepare("INSERT INTO email_jobs(id,owner,name,source_name,status,created_at,updated_at) VALUES(?,?,?,?,'uploading',?,?)").bind(id, c.owner, name, source, now, now),
          c.db.prepare("INSERT INTO email_verification_engines(job_id,engine,created_at) VALUES(?,?,?)").bind(id, provider, now),
        ]);
        const result = await jobDetail(c, id);
        return result ? output(await result.json(), 201) : null;
      }
      const match = route.match(/^jobs\/([a-f0-9-]{36})\/(start|action|advance|reconcile)$/);
      if (match && method === "POST") {
        const [, id, action] = match, j = await owned(c, id);
        if (j.engine === "sendzad") {
          const b = await readBody(request, c);
          if (action === "start" || (action === "action" && b.action === "resume")) {
            if (action === "start" && (j.status !== "ready" || j.sealed_at === null || b.confirmed !== true)) throw new RouteError("Seal the list and confirm permission first.", 409);
            if (action !== "start" && (!j.started_at || !["paused", "needs_attention"].includes(j.status))) throw new RouteError("This job cannot be resumed.", 409);
            if (j.lease_until && j.lease_until >= Date.now()) throw new RouteError("A worker is handling this job. Refresh before resuming.", 409);
            const config = connection(), hash = await selfConfigHash(config);
            if (action !== "start" && hash !== j.config_hash) throw new RouteError("Verifier connection changed. Restore it or create a new job.", 409);
            await checkSelfHealth(config, c.fetch);
            const now = Date.now();
            const changes = await c.db.batch([
              c.db.prepare("UPDATE email_verification_engines SET config_hash=? WHERE job_id=? AND EXISTS(SELECT 1 FROM email_jobs WHERE id=? AND owner=? AND status=?)").bind(hash, id, id, c.owner, j.status),
              c.db.prepare("UPDATE email_jobs SET status='running',started_at=COALESCE(started_at,?),next_run_at=?,error=NULL,updated_at=? WHERE id=? AND owner=? AND status=?").bind(now, now, now, id, c.owner, j.status),
            ]);
            if (changes[1].meta.changes !== 1) throw new RouteError("The job changed. Refresh before retrying.", 409);
            return jobDetail(c, id);
          }
          if (action === "advance") {
            await advanceEmailQueue(c.db, c.masterKey, { owner: c.owner, jobId: id, maxSteps: 1, fetch: c.fetch });
            return jobDetail(c, id);
          }
          if (action === "reconcile") throw new RouteError("Self-hosted checks have no paid task ID.", 409);
          // Pause/cancel remain the existing proven transitions. Resume is handled above.
          return decorate(await deps.legacyApi(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(b) }), c), c);
        }
      }
      return decorate(await deps.legacyApi(request, c), c);
    } catch (e) {
      return output({ error: e instanceof RouteError ? e.message : "Sendzad connection or database setup needs attention. Pending work is retained; no paid fallback was used." }, e instanceof RouteError ? e.status : 503);
    }
  }
  async function advanceSelf(db: D1Database, j: Row, fetcher?: typeof fetch) {
    const now = Date.now(), lease = crypto.randomUUID();
    const claimed = await db.prepare("UPDATE email_jobs SET lease_token=?,lease_until=? WHERE id=? AND status='running' AND (lease_until IS NULL OR lease_until<?) RETURNING *").bind(lease, now + 120_000, j.id, now).first<Row>();
    if (!claimed) return false;
    try {
      const config = connection();
      if (await selfConfigHash(config) !== j.config_hash) throw new Error("Connection changed");
      const selection = await db.prepare("SELECT t.*,COALESCE(s.attempts,0) attempts,COALESCE(s.deferrals,0) deferrals FROM email_targets t LEFT JOIN email_self_results s ON s.job_id=t.job_id AND s.email=t.email WHERE t.job_id=? AND t.status='pending' AND COALESCE(s.next_at,0)<=? ORDER BY t.first_position LIMIT 4").bind(j.id, now).all<Row>();
      if (selection.results.length) {
        const results = await verifySelf(config, selection.results.map(r => r.email), fetcher);
        const writes: D1PreparedStatement[] = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i], t = selection.results[i], cooldown = r.reason === "provider_cooldown";
          const attempts = t.attempts + (cooldown ? 0 : 1), deferrals = t.deferrals + (cooldown ? 1 : 0);
          const retry = r.retryable && attempts < 3 && deferrals < 30;
          const next = retry ? Date.now() + Math.max(60, r.retry_after_seconds || 60) * 1000 : 0;
          writes.push(db.prepare("INSERT INTO email_self_results(job_id,email,attempts,deferrals,next_at,evidence) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled') ON CONFLICT(job_id,email) DO UPDATE SET attempts=excluded.attempts,deferrals=excluded.deferrals,next_at=excluded.next_at,evidence=excluded.evidence").bind(j.id, t.email, attempts, deferrals, next, JSON.stringify(r), j.id, lease));
          if (!retry) {
            // category has been validated against a fixed allowlist before use in SQL.
            writes.push(db.prepare(`UPDATE email_jobs SET pending_count=pending_count-?,${r.category}_count=${r.category}_count+?,pending_targets=pending_targets-1 WHERE id=? AND lease_token=? AND status<>'cancelled' AND EXISTS(SELECT 1 FROM email_targets WHERE job_id=? AND email=? AND status='pending')`).bind(t.occurrence_count, t.occurrence_count, j.id, lease, j.id, t.email));
            writes.push(db.prepare("UPDATE email_targets SET status=?,reason=?,provider_status=?,updated_at=? WHERE job_id=? AND email=? AND status='pending' AND EXISTS(SELECT 1 FROM email_jobs WHERE id=? AND lease_token=? AND status<>'cancelled')").bind(r.category, r.reason, `sendzad:${r.engine_version}`, r.checked_at * 1000, j.id, t.email, j.id, lease));
          }
        }
        await db.batch(writes);
      }
      const left = await db.prepare("SELECT COUNT(*) n,MIN(COALESCE(s.next_at,0)) due FROM email_targets t LEFT JOIN email_self_results s ON s.job_id=t.job_id AND s.email=t.email WHERE t.job_id=? AND t.status='pending'").bind(j.id).first<Row>();
      await db.prepare("UPDATE email_jobs SET status=CASE WHEN ?=0 THEN 'completed' ELSE status END,completed_at=CASE WHEN ?=0 THEN ? ELSE completed_at END,next_run_at=CASE WHEN ?=0 OR status='paused' THEN NULL ELSE ? END,updated_at=?,error=NULL WHERE id=? AND lease_token=? AND status IN ('running','paused')").bind(left!.n, left!.n, Date.now(), left!.n, Math.max(Date.now() + 2000, left!.due || 0), Date.now(), j.id, lease).run();
      return true;
    } catch {
      await db.prepare("UPDATE email_jobs SET status=CASE WHEN status='running' THEN 'needs_attention' ELSE status END,error='Sendzad unavailable or invalid response. Pending work retained. No Reoon credits used.',next_run_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND status<>'cancelled'").bind(Date.now(), j.id, lease).run();
      return true;
    } finally { await db.prepare("UPDATE email_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(j.id, lease).run(); }
  }
  async function advanceEmailQueue(db: D1Database, key: string | undefined, options: Options = {}) {
    const ids: string[] = [], steps = Math.max(1, Math.min(3, Number.isSafeInteger(options.maxSteps) ? options.maxSteps! : 1));
    for (let i = 0; i < steps; i++) {
      const now = Date.now();
      const where = `${options.owner ? " AND j.owner=?" : ""}${options.jobId ? " AND j.id=?" : ""}${ids.length ? " AND j.id NOT IN (SELECT value FROM json_each(?))" : ""}`;
      const j = await db.prepare(`SELECT j.*,COALESCE(e.engine,'reoon') engine,e.config_hash FROM email_jobs j LEFT JOIN email_verification_engines e ON e.job_id=j.id WHERE j.started_at IS NOT NULL AND j.status IN ('running','waiting_credits') AND COALESCE(j.next_run_at,0)<=? AND (j.lease_until IS NULL OR j.lease_until<?) ${where} ORDER BY COALESCE(j.next_run_at,0),j.created_at LIMIT 1`).bind(now, now, ...(options.owner ? [options.owner] : []), ...(options.jobId ? [options.jobId] : []), ...(ids.length ? [JSON.stringify(ids)] : [])).first<Row>();
      if (!j) break;
      if (j.engine === "sendzad") { if (await advanceSelf(db, j, options.fetch)) ids.push(j.id); }
      else { await deps.legacyQueue(db, key, { owner: j.owner, jobId: j.id, maxSteps: 1, fetch: options.fetch }); ids.push(j.id); }
    }
    const next = await db.prepare(`SELECT MIN(next_run_at) due FROM email_jobs WHERE started_at IS NOT NULL AND status IN ('running','waiting_credits')${options.owner ? " AND owner=?" : ""}`).bind(...(options.owner ? [options.owner] : [])).first<Row>();
    return { advanced: ids.length, jobIds: ids, nextDueAt: next?.due ?? null };
  }
  return { handleEmailApi, advanceEmailQueue };
}
