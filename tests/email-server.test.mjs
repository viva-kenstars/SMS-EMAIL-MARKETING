import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "outputs", "email-test");
await mkdir(out, { recursive: true });
const bundle = join(out, "service.mjs");
await build({ entryPoints: [join(root, "app/lib/email/service.ts")], bundle: true, format: "esm", platform: "node", target: "node22", outfile: bundle });
const { handleEmailApi, advanceEmailQueue } = await import(pathToFileURL(bundle).href);
const migrations = await Promise.all((await readdir(join(root, "drizzle"))).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => readFile(join(root, "drizzle", name), "utf8")));
const masterKey = Buffer.from(new Uint8Array(32).fill(91)).toString("base64");
const fakeKey = "mock-reoon-credential-never-sent-on-network";
let db, calls, handler;

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first(column) { this.db.queryCount++; const result = this.db.sqlite.prepare(this.sql).get(...this.args); if (this.db.afterFirst) await this.db.afterFirst(this.sql, result); return result === undefined ? null : column === undefined ? result : result[column]; }
  async all() { this.db.queryCount++; const results = this.db.sqlite.prepare(this.sql).all(...this.args); this.db.maxRowsReturned = Math.max(this.db.maxRowsReturned, results.length); return { success: true, results, meta: {} }; }
  execute() { this.db.queryCount++; const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.execute(); }
}
class Database {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec("PRAGMA foreign_keys=ON"); this.queryCount = 0; this.maxRowsReturned = 0; for (const migration of migrations) this.sqlite.exec(migration); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { this.sqlite.exec("BEGIN"); try { const results = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
}
const fetchMock = async (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://emailverifier.reoon.com"); const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ url, init, body }); return handler(url, init, body); };
const balanceResponse = (available = 100000) => Response.json({ status: "success", api_status: "active", remaining_daily_credits: available, remaining_instant_credits: 0 });
const safeResult = email => ({ email, status: "safe", verification_mode: "power", is_safe_to_send: true, is_deliverable: true, is_disabled: false, is_disposable: false, is_role_account: false, has_inbox_full: false, is_catch_all: false, is_spamtrap: false });
beforeEach(() => { db = new Database(); calls = []; handler = () => { throw new Error("Unmocked provider request blocked"); }; });
afterEach(() => {
  try {
    // Independent persisted-row oracle checks every cached count, including
    // duplicate weighting, retries, unknowns, and cancellation overlays.
    for (const job of db.sqlite.prepare("SELECT * FROM email_jobs").all()) {
      const rows = db.sqlite.prepare("SELECT r.local_status,r.normalized_email,r.position,t.status,t.first_position FROM email_rows r LEFT JOIN email_targets t ON t.job_id=r.job_id AND t.email=r.normalized_email WHERE r.job_id=?").all(job.id);
      const counts = { pending: 0, processing: 0, valid: 0, invalid: 0, risky: 0, unknown: 0 };
      for (const row of rows) { let status = row.status ?? row.local_status ?? "unknown"; if (job.status === "cancelled" && ["pending", "processing"].includes(status)) status = "unknown"; counts[status]++; }
      assert.equal(job.total_rows, rows.length);
      for (const [status, count] of Object.entries(counts)) assert.equal(job[`${status}_count`], count, `cached ${status} rows must match persisted outcomes`);
      assert.equal(job.duplicate_count, rows.filter(row => row.first_position && row.first_position !== row.position).length);
      assert.equal(job.eligible_count, new Set(rows.filter(row => row.normalized_email).map(row => row.normalized_email)).size);
    }
  } finally { db.sqlite.close(); }
});
async function api(path, body, { owner = "alice", method = body === undefined ? "GET" : "POST", headers = {} } = {}) {
  const request = new Request(`https://email.test/api/email/${path}`, { method, headers: { Origin: "https://email.test", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handleEmailApi(request, { db, owner, masterKey, fetch: fetchMock });
  return { status: response.status, body: await response.json() };
}
async function configured(owner = "alice", key = fakeKey) {
  const current = await api("settings", undefined, { owner });
  const saved = await api("settings", { revision: current.body.settings.revision, apiKey: key }, { owner });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  handler = () => balanceResponse();
  const checked = await api("settings/check", {}, { owner });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  return checked.body.settings;
}
async function imported(emails, owner = "alice") {
  const created = await api("jobs", { name: "Email test", sourceName: "fixture.csv" }, { owner });
  assert.equal(created.status, 201);
  let job = created.body.job;
  for (let offset = 0, index = 0; offset < emails.length; offset += 500, index++) {
    const uploaded = await api(`jobs/${job.id}/chunks`, { index, rows: emails.slice(offset, offset + 500).map((email, n) => ({ email, sourceRow: offset + n + 2 })) }, { owner });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); job = uploaded.body.job;
  }
  const sealed = await api(`jobs/${job.id}/seal`, { expectedChunks: Math.ceil(emails.length / 500), expectedRows: emails.length }, { owner });
  assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
  return sealed.body.job;
}
const addresses = n => Array.from({ length: n }, (_, index) => `person${index}@example.test`);
async function start(job, owner = "alice") { const result = await api(`jobs/${job.id}/start`, { acknowledgeProvider: true }, { owner }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.job; }
function due(id) { db.sqlite.prepare("UPDATE email_jobs SET next_run_at=0,lease_until=NULL WHERE id=?").run(id); db.sqlite.prepare("UPDATE email_batches SET next_poll_at=0 WHERE job_id=?").run(id); }
async function advance(job, owner = "alice") { const result = await api(`jobs/${job.id}/advance`, {}, { owner }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.job; }
function noSecrets(value) { const text = JSON.stringify(value); assert.ok(!text.includes(fakeKey)); assert.ok(!text.includes(masterKey)); }
function installTasks({ credits = 100000, results, createError } = {}) {
  const tasks = new Map();
  handler = async (url, init, body) => {
    if (url.pathname.endsWith("check-account-balance/")) return balanceResponse(credits);
    if (url.pathname.endsWith("create-bulk-verification-task/")) {
      if (createError) return createError(url, init, body);
      const id = String(tasks.size + 100); tasks.set(id, body.emails);
      return Response.json({ status: "success", task_id: id, count_submitted: body.emails.length }, { status: 201 });
    }
    if (url.pathname.endsWith("get-result-bulk-verification-task/")) {
      const id = url.searchParams.get("task_id"), emails = tasks.get(id);
      assert.ok(emails, "poll only a persisted task ID");
      return Response.json({ status: "completed", task_id: id, count_total: emails.length, count_checked: emails.length, results: results ? results(emails) : emails.map(safeResult) });
    }
    if (url.pathname.endsWith("/verify")) { assert.equal(url.searchParams.get("mode"), "power"); return Response.json(safeResult(url.searchParams.get("email"))); }
    throw new Error("Unexpected mocked path");
  };
  return tasks;
}

test("settings encrypt the key and all balance/configuration operations stay read-only", async () => {
  const settings = await configured();
  assert.equal(settings.balance.availableCredits, 100000);
  assert.equal(settings.balance.credentialRevision, settings.credentialRevision);
  assert.ok(settings.verifiedAt);
  const stored = db.sqlite.prepare("SELECT * FROM email_settings").get();
  assert.ok(stored.api_key_ciphertext.startsWith("v1:")); noSecrets(stored); noSecrets(settings);
  assert.equal(calls.length, 1); assert.ok(calls.every(call => call.url.pathname.endsWith("check-account-balance/")));
  const kept = await api("settings", { revision: settings.revision, apiKey: "" });
  assert.equal(kept.body.settings.credentialRevision, settings.credentialRevision);
  const rejected = await api("settings", { revision: settings.revision, apiKey: "replacement-key" });
  assert.equal(rejected.status, 409);
});

test("owner authentication, job IDs and credentials remain isolated", async () => {
  assert.equal((await api("settings", undefined, { owner: "" })).status, 401);
  await configured("alice"); await configured("bob", "other-owner-secret-key");
  const job = await imported(addresses(10));
  for (const [path, body] of [[`jobs/${job.id}`, undefined], [`jobs/${job.id}/results`, undefined], [`jobs/${job.id}/start`, { acknowledgeProvider: true }], [`jobs/${job.id}/advance`, {}], [`jobs/${job.id}/action`, { action: "cancel" }]]) assert.equal((await api(path, body, { owner: "bob" })).status, 404);
  assert.equal((await api("jobs", undefined, { owner: "bob" })).body.jobs.length, 0);
  assert.equal((await api("settings", { revision: 1, apiKey: "changed-secret-key" }, { owner: "alice", headers: { Origin: "https://bad.test" } })).status, 403);
});

test("imports preserve duplicates, syntax errors and unsupported formats without paid checks", async () => {
  const job = await imported(["Ada@EXAMPLE.test", "Ada@example.test", "bad address", "Name <name@example.test>", "ü@example.test", '"quoted"@example.test', "lower@example.test"]);
  assert.equal(job.totalRows, 7); assert.equal(job.eligibleCount, 2); assert.equal(job.counts.duplicates, 1); assert.equal(job.counts.invalid, 1); assert.equal(job.counts.unknown, 3); assert.equal(job.counts.pending, 3);
  assert.equal(job.counts.valid, 0); assert.equal(calls.length, 0);
  const rows = (await api(`jobs/${job.id}/results`)).body.rows;
  assert.equal(rows[1].duplicateOf, 1); assert.equal(rows[1].normalizedEmail, "Ada@example.test"); assert.equal(rows[0].category, null); assert.equal(rows[0].checkedAt, null);
});

test("chunk replays are idempotent and changed rows cannot overwrite a chunk", async () => {
  const job = (await api("jobs", { name: "Idempotent import" })).body.job;
  const body = { index: 0, rows: [{ email: "one@example.test" }] };
  const pair = await Promise.all([api(`jobs/${job.id}/chunks`, body), api(`jobs/${job.id}/chunks`, body)]);
  assert.ok(pair.every(result => result.status === 200));
  assert.equal((await api(`jobs/${job.id}`)).body.job.totalRows, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM email_rows").get().n, 1);
  assert.equal((await api(`jobs/${job.id}/chunks`, { index: 0, rows: [{ email: "different@example.test" }] })).status, 409);
  assert.equal((await api(`jobs/${job.id}/chunks`, { index: 2, rows: [{ email: "next@example.test" }] })).status, 409);
  assert.equal((await api(`jobs/${job.id}/seal`, { expectedChunks: 1, expectedRows: 2 })).status, 409);
  assert.equal(calls.length, 0);
});

test("more than twenty thousand rows import without a total cap and exports page every row", async () => {
  const job = await imported(addresses(20001));
  assert.equal(job.totalRows, 20001); assert.equal(job.eligibleCount, 20001); assert.equal(job.importedChunks, 41);
  assert.equal(job.counts.pending, 20001); assert.equal(calls.length, 0);
  let cursor = "", count = 0, previous = 0;
  do {
    const response = await api(`jobs/${job.id}/results?limit=1000&cursor=${cursor}`);
    assert.equal(response.status, 200); assert.equal(response.body.total, 20001);
    for (const row of response.body.rows) { assert.ok(row.position > previous); previous = row.position; count++; }
    cursor = response.body.nextCursor;
  } while (cursor);
  assert.equal(count, 20001); assert.ok(db.maxRowsReturned <= 1001);
});

test("20001 unique addresses complete all eleven native bulk tasks and export exactly once", async () => {
  await configured();
  const emails = Array.from({ length: 20001 }, (_, index) => `person${index}@example.net`);
  const job = await imported(emails);
  await start(job);
  calls.length = 0;
  const tasks = installTasks();
  let updated;
  for (let step = 0; step < 22; step++) {
    due(job.id);
    updated = await advance(job);
    if (updated.status === "completed") break;
    assert.equal(updated.status, "running", JSON.stringify(updated));
  }
  assert.equal(updated.status, "completed", "eleven create/poll pairs must complete the entire job");
  assert.equal(tasks.size, 11);
  assert.deepEqual(calls.filter(call => call.body?.emails).map(call => call.body.emails.length), [...Array(9).fill(2000), 1991, 10]);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/verify")).length, 0);
  assert.deepEqual(updated.counts, { total: 20001, duplicates: 0, pending: 0, processing: 0, valid: 20001, invalid: 0, risky: 0, unknown: 0 });
  assert.equal(updated.eligibleCount, 20001);
  assert.equal(updated.processedRows, 20001);
  assert.equal(updated.progressPercent, 100);
  const detail = (await api(`jobs/${job.id}`)).body;
  assert.equal(detail.batches.length, 11);
  assert.ok(detail.batches.every(batch => batch.status === "completed" && batch.taskId));
  assert.equal(new Set(detail.batches.map(batch => batch.taskId)).size, 11);
  let cursor = "", exported = 0;
  do {
    const page = await api(`jobs/${job.id}/results?limit=1000&cursor=${cursor}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.total, 20001);
    for (const row of page.body.rows) {
      assert.equal(row.position, exported + 1, "stable export positions must have no duplicates or omissions");
      assert.equal(row.email, `person${exported}@example.net`);
      assert.equal(row.status, "valid");
      assert.equal(row.category, "valid");
      assert.equal(row.providerStatus, "safe");
      assert.ok(row.checkedAt);
      exported++;
    }
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(exported, 20001);
});

test("unsealed/unapproved imports never enter the background queue", async () => {
  await configured(); const job = await imported(addresses(10)); calls.length = 0;
  assert.equal((await api(`jobs/${job.id}/start`, { acknowledgeProvider: false })).status, 409);
  const queue = await advanceEmailQueue(db, masterKey, { fetch: fetchMock, maxSteps: 3 });
  assert.equal(queue.advanced, 0); assert.equal(calls.length, 0);
});

test("single logical jobs use Power and duplicates inherit one paid result", async () => {
  await configured(); const job = await imported(["one@example.test", "one@example.test", "bad", '"quoted"@example.test']); await start(job); calls.length = 0; installTasks();
  const updated = await advance(job);
  assert.equal(updated.status, "completed"); assert.equal(updated.counts.valid, 2); assert.equal(updated.counts.invalid, 1); assert.equal(updated.counts.unknown, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/verify")).length, 1);
  const rows = (await api(`jobs/${job.id}/results?filter=valid`)).body.rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.checkedAt && row.providerStatus === "safe"));
});

test("two concurrent workers claim a bulk task once and persist before creating it", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); calls.length = 0;
  const tasks = installTasks(); const base = handler;
  handler = async (url, init, body) => {
    if (url.pathname.endsWith("create-bulk-verification-task/")) {
      const intent = db.sqlite.prepare("SELECT * FROM email_batches WHERE job_id=?").get(job.id);
      assert.equal(intent.status, "submitting"); assert.equal(intent.count, 10);
    }
    return base(url, init, body);
  };
  const results = await Promise.all([advance(job), advance(job)]);
  assert.ok(results.every(result => result.status === "running")); assert.equal(tasks.size, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("create-bulk-verification-task/")).length, 1);
  due(job.id); const finished = await advance(job);
  assert.equal(finished.status, "completed"); assert.equal(finished.counts.valid, 10);
  assert.equal((await api(`jobs/${job.id}`)).body.batches[0].taskId, "100");
});

test("2001 addresses use 1991 plus 10 bulk tasks and never create an undersized tail", async () => {
  await configured(); const job = await imported(addresses(2001)); await start(job); calls.length = 0; installTasks();
  let updated = await advance(job);
  for (let n = 0; n < 4 && updated.status !== "completed"; n++) { due(job.id); updated = await advance(job); }
  assert.equal(updated.status, "completed"); assert.equal(updated.counts.valid, 2001);
  const creates = calls.filter(call => call.body?.emails);
  assert.deepEqual(creates.map(call => call.body.emails.length), [1991, 10]);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/verify")).length, 0);
});

test("insufficient credits pauses without paid submission and automatically rechecks", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); calls.length = 0; installTasks({ credits: 0 });
  let updated = await advance(job);
  assert.equal(updated.status, "waiting_credits"); assert.equal(updated.counts.pending, 10); assert.ok(updated.nextRunAt > Date.now());
  assert.equal(calls.filter(call => call.body?.emails).length, 0);
  installTasks({ credits: 100 }); due(job.id); updated = await advance(job);
  assert.equal(updated.status, "running"); assert.equal(calls.filter(call => call.body?.emails).length, 1);
});

test("unknown submission is terminal for that batch and is never automatically resubmitted", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); calls.length = 0;
  installTasks({ createError: () => { throw new Error(`private exception ${fakeKey}`); } });
  const updated = await advance(job); assert.equal(updated.status, "needs_attention"); assert.equal(updated.counts.unknown, 10); noSecrets(updated);
  assert.equal((await api(`jobs/${job.id}`)).body.batches[0].status, "unknown");
  due(job.id); await advance(job); assert.equal(calls.filter(call => call.body?.emails).length, 1);
  const resumed = await api(`jobs/${job.id}/action`, { action: "resume" }); assert.equal(resumed.status, 200);
  await advance(job); assert.equal(calls.filter(call => call.body?.emails).length, 1);
});

test("a crashed submitting batch is marked unknown when its lease expires", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks(); await advance(job);
  db.sqlite.prepare("UPDATE email_batches SET status='submitting',task_id=NULL WHERE job_id=?").run(job.id);
  due(job.id); calls.length = 0;
  const updated = await advance(job);
  assert.equal(updated.status, "needs_attention"); assert.equal(updated.counts.unknown, 10); assert.equal(calls.length, 0);
});

test("missing/conflicting provider results become unknown and risky addresses stay separate", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks({ results: emails => [safeResult(emails[0]), { ...safeResult(emails[1]), status: "catch_all" }, { ...safeResult(emails[2]), is_disposable: true }, { email: emails[3], status: "safe" }, { email: emails[4], status: "invalid" }] });
  await advance(job); due(job.id); const updated = await advance(job);
  assert.equal(updated.status, "completed"); assert.equal(updated.counts.valid, 1); assert.equal(updated.counts.risky, 2); assert.equal(updated.counts.invalid, 1); assert.equal(updated.counts.unknown, 6);
  const valid = (await api(`jobs/${job.id}/results?filter=valid`)).body.rows; assert.deepEqual(valid.map(row => row.email), ["person0@example.test"]);
});

test("malformed polling backs off and never resubmits a task", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks(); const base = handler;
  handler = (url, init, body) => url.pathname.endsWith("get-result-bulk-verification-task/") ? Response.json({ status: "completed", task_id: "100", results: "bad" }) : base(url, init, body);
  await advance(job); due(job.id); let updated = await advance(job);
  assert.equal(updated.status, "running"); assert.equal(updated.counts.valid, 0); assert.ok(updated.nextRunAt > Date.now());
  for (let n = 0; n < 4; n++) { due(job.id); updated = await advance(job); }
  assert.equal(updated.status, "needs_attention"); assert.equal(updated.counts.unknown, 10); assert.equal(calls.filter(call => call.body?.emails).length, 1);
});

test("changing credentials cannot redirect a started job to the replacement account", async () => {
  const settings = await configured(); const job = await imported(addresses(10)); await start(job); calls.length = 0;
  await api("settings", { revision: settings.revision, apiKey: "replacement-reoon-key" });
  const updated = await advance(job); assert.equal(updated.status, "needs_attention"); assert.equal(updated.counts.pending, 10); assert.equal(calls.length, 0);
  assert.equal((await api(`jobs/${job.id}/action`, { action: "resume" })).status, 409);
});

test("pause/cancel while creating cannot restore automatic running or lose cancellation", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks(); const base = handler;
  handler = async (url, init, body) => { if (url.pathname.endsWith("create-bulk-verification-task/")) assert.equal((await api(`jobs/${job.id}/action`, { action: "cancel" })).status, 200); return base(url, init, body); };
  const updated = await advance(job); assert.equal(updated.status, "cancelled"); assert.equal(updated.counts.unknown, 10); assert.equal(updated.nextRunAt, null);
});

test("a confirmed existing task reconciles unknown results without paid replay", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks({ createError: () => { throw new Error("connection closed"); } }); await advance(job);
  const detail = (await api(`jobs/${job.id}`)).body, batch = detail.batches[0]; calls.length = 0;
  handler = url => { assert.ok(url.pathname.endsWith("get-result-bulk-verification-task/")); return Response.json({ status: "completed", task_id: "777", count_total: 10, count_checked: 10, results: addresses(10).map(safeResult) }); };
  const result = await api(`jobs/${job.id}/reconcile`, { batchId: batch.id, taskId: "777" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.job.counts.valid, 10); assert.equal(result.body.job.status, "completed"); assert.equal(calls.length, 1);
});

test("chunk bounds and result limit are enforced without imposing a total-job limit", async () => {
  const job = (await api("jobs", { name: "Bounds" })).body.job;
  assert.equal((await api(`jobs/${job.id}/chunks`, { index: 0, rows: addresses(501).map(email => ({ email })) })).status, 400);
  assert.equal((await api(`jobs/${job.id}/chunks`, { index: 0, rows: [{ email: "x".repeat(1025) }] })).status, 400);
  assert.equal((await api(`jobs/${job.id}/results?limit=1001`)).status, 400);
  assert.equal(calls.length, 0);
});

test("re-saving an identical key preserves verification and running-job generation", async () => {
  const settings = await configured();
  const saved = await api("settings", { revision: settings.revision, apiKey: fakeKey });
  assert.equal(saved.status, 200); assert.equal(saved.body.settings.credentialRevision, settings.credentialRevision); assert.equal(saved.body.settings.verifiedAt, settings.verifiedAt);
  assert.equal(calls.length, 1);
});

test("available credits fund a smaller native bulk batch without blocking a large job", async () => {
  await configured(); const job = await imported(addresses(10000)); await start(job); calls.length = 0; installTasks({ credits: 1000 });
  const result = await advance(job);
  assert.equal(result.status, "running"); assert.equal(result.counts.processing, 1000); assert.equal(result.counts.pending, 9000);
  assert.equal(calls.find(call => call.body?.emails).body.emails.length, 1000);
});

test("credit-sized batches preserve the native minimum without switching a bulk job to Power", async () => {
  await configured(); const job = await imported(addresses(25)); await start(job); installTasks({ credits: 20 });
  await advance(job); assert.equal(calls.find(call => call.body?.emails).body.emails.length, 15);
  const smaller = await imported(addresses(15)); await start(smaller); calls.length = 0; installTasks({ credits: 10 });
  const waiting = await advance(smaller); assert.equal(waiting.status, "waiting_credits"); assert.equal(calls.filter(call => call.body?.emails || call.url.pathname.endsWith("/verify")).length, 0);
});

test("rotation during the balance lookup prevents a new paid submission atomically", async () => {
  const settings = await configured(); const job = await imported(addresses(10)); await start(job); calls.length = 0;
  handler = async url => { assert.ok(url.pathname.endsWith("check-account-balance/")); const changed = await api("settings", { revision: settings.revision, apiKey: "rotated-provider-api-key" }); assert.equal(changed.status, 200); return balanceResponse(); };
  const result = await advance(job); assert.equal(result.status, "needs_attention"); assert.equal(result.counts.pending, 10);
  assert.equal(calls.length, 1); assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM email_batches").get().n, 0);
});

test("already accepted provider tasks still poll with the frozen key after account rotation", async () => {
  const settings = await configured(); const job = await imported(addresses(10)); await start(job); installTasks(); await advance(job);
  await api("settings", { revision: settings.revision, apiKey: "replacement-provider-key" });
  const base = handler; handler = (url, init, body) => { assert.equal(url.searchParams.get("key"), fakeKey); return base(url, init, body); };
  due(job.id); const result = await advance(job); assert.equal(result.status, "completed"); assert.equal(result.counts.valid, 10);
});

test("cancellation retains acknowledged task IDs and exports unverified rows as unknown", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks(); const base = handler;
  handler = async (url, init, body) => { if (url.pathname.endsWith("create-bulk-verification-task/")) await api(`jobs/${job.id}/action`, { action: "cancel" }); return base(url, init, body); };
  await advance(job);
  const detail = (await api(`jobs/${job.id}`)).body; assert.equal(detail.job.status, "cancelled"); assert.equal(detail.batches[0].taskId, "100"); assert.equal(detail.batches[0].status, "cancelled");
  const rows = (await api(`jobs/${job.id}/results?filter=unknown`)).body; assert.equal(rows.total, 10); assert.ok(rows.rows.every(row => row.category === "unknown" && row.checkedAt === null));
  assert.equal((await api(`jobs/${job.id}/results?filter=pending`)).body.total, 0);
});

test("a completed foreign task with the same row count cannot reconcile an unknown batch", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks({ createError: () => { throw new Error("lost response"); } }); await advance(job);
  const batch = (await api(`jobs/${job.id}`)).body.batches[0];
  handler = () => Response.json({ status: "completed", task_id: "777", count_total: 10, count_checked: 10, results: addresses(10).map(email => safeResult(`other-${email}`)) });
  const result = await api(`jobs/${job.id}/reconcile`, { batchId: batch.id, taskId: "777" });
  assert.equal(result.status, 409); assert.equal((await api(`jobs/${job.id}`)).body.batches[0].taskId, null); assert.equal((await api(`jobs/${job.id}`)).body.job.counts.unknown, 10);
});

test("two reconciliations cannot attach the same task ID to different jobs", async () => {
  await configured(); const first = await imported(addresses(10)), second = await imported(addresses(10)); await start(first); await start(second);
  installTasks({ createError: () => { throw new Error("lost response"); } }); await advance(first); await advance(second);
  const a = (await api(`jobs/${first.id}`)).body.batches[0], b = (await api(`jobs/${second.id}`)).body.batches[0];
  let entered = 0, release; const gate = new Promise(resolve => { release = resolve; });
  handler = async () => { entered++; if (entered === 2) release(); await gate; return Response.json({ status: "completed", task_id: "777", count_total: 10, count_checked: 10, results: addresses(10).map(safeResult) }); };
  const results = await Promise.all([api(`jobs/${first.id}/reconcile`, { batchId: a.id, taskId: "777" }), api(`jobs/${second.id}/reconcile`, { batchId: b.id, taskId: "777" })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM email_batches WHERE task_id='777'").get().n, 1);
});

test("cancel racing with reconciliation cannot resurrect processing rows", async () => {
  await configured(); const job = await imported(addresses(10)); await start(job); installTasks({ createError: () => { throw new Error("lost response"); } }); await advance(job);
  const batch = (await api(`jobs/${job.id}`)).body.batches[0];
  handler = () => Response.json({ status: "completed", task_id: "777", count_total: 10, count_checked: 10, results: addresses(10).map(safeResult) });
  db.afterFirst = async sql => { if (sql.startsWith("UPDATE email_jobs SET lease_token") && sql.includes("status=CASE WHEN")) { db.afterFirst = undefined; await api(`jobs/${job.id}/action`, { action: "cancel" }); } };
  const result = await api(`jobs/${job.id}/reconcile`, { batchId: batch.id, taskId: "777" }); assert.equal(result.status, 409);
  const detail = (await api(`jobs/${job.id}`)).body.job; assert.equal(detail.status, "cancelled"); assert.equal(detail.counts.processing, 0); assert.equal(detail.counts.unknown, 10);
});

test("streaming request limit stops reading at one MiB even without content-length", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; if (pulls > 100) controller.close(); else controller.enqueue(new Uint8Array(16_384).fill(32)); }, cancel() { cancelled = true; } });
  const response = await handleEmailApi(new Request("https://email.test/api/email/settings", { method: "POST", duplex: "half", headers: { "Content-Type": "application/json", Origin: "https://email.test" }, body }), { db, owner: "alice", masterKey, fetch: fetchMock });
  assert.equal(response.status, 413); assert.equal(cancelled, true); assert.ok(pulls < 100); assert.equal(calls.length, 0);
});

test("explicit authentication rejection clears verification but stale failure cannot clear a newer success", async () => {
  await configured(); handler = () => Response.json({ error: "Unauthorized" }, { status: 401 });
  assert.equal((await api("balance")).status, 502); assert.ok((await api("settings")).body.settings.verifiedAt, "read-only balance errors do not reset verification");
  assert.equal((await api("settings/check", {})).status, 502); assert.equal((await api("settings")).body.settings.verifiedAt, null);
  handler = () => balanceResponse(); await api("settings/check", {});
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  handler = async () => { entered(); await gate; return Response.json({ error: "Unauthorized" }, { status: 401 }); };
  const oldCheck = api("settings/check", {}); await started;
  handler = () => balanceResponse(); const newCheck = await api("settings/check", {}); assert.equal(newCheck.status, 200);
  release(); assert.equal((await oldCheck).status, 502); assert.equal((await api("settings")).body.settings.verifiedAt, newCheck.body.settings.verifiedAt);
});
