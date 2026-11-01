import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as MockResponse } from "miniflare";

// These smoke tests use actual workerd fetch, Web Crypto and D1 SQL execution.
// Every outbound request is intercepted by the local service, including any
// accidental redirect. No live provider, account, email or credential is used.
const root = fileURLToPath(new URL("../", import.meta.url));
const viteConfig = await readFile(join(root, "vite.config.ts"), "utf8");
const compatibilityDate = viteConfig.match(/compatibility_date:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
assert.ok(compatibilityDate, "match the application's Workers compatibility date");
const fakeKey = "fake-reoon-worker-key-no-live-api";
const masterKey = Buffer.from(new Uint8Array(32).fill(83)).toString("base64");
const emails = Array.from({ length: 10 }, (_, index) => `Member${index}+test@example.test`);
const bundled = await build({
  stdin: {
    resolveDir: root,
    sourcefile: "email-runtime-smoke.ts",
    loader: "ts",
    contents: `
      import { getReoonBalance, createReoonBulkTask, verifyReoonSinglePower, ReoonError } from "./app/lib/email/reoon.ts";
      import { handleEmailApi } from "./app/lib/email/service.ts";
      const options = { apiKey: ${JSON.stringify(fakeKey)} };
      const emails = ${JSON.stringify(emails)};
      export default {
        async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path.startsWith("/api/email/")) {
            return await handleEmailApi(request, { db: env.DB, owner: "email-runtime-owner", masterKey: env.TEST_MASTER_KEY })
              ?? new Response("Not found", { status: 404 });
          }
          try {
            const result = path === "/adapter/balance" ? await getReoonBalance(options)
              : path === "/adapter/create" ? await createReoonBulkTask(options, emails, "EV-runtime-test")
              : path === "/adapter/single" ? await verifyReoonSinglePower(options, emails[0])
              : null;
            return Response.json(result);
          } catch (error) {
            if (!(error instanceof ReoonError)) throw error;
            return Response.json({ error: error.message, kind: error.kind, submissionOutcome: error.submissionOutcome }, { status: 502 });
          }
        }
      }`,
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
});

let runtime;
let database;
let calls = [];
let respond = () => { throw new Error("Unexpected outbound request blocked by the smoke test"); };

before(async () => {
  runtime = new Miniflare({
    modules: true,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    script: bundled.outputFiles[0].text,
    bindings: { TEST_MASTER_KEY: masterKey },
    d1Databases: ["DB"],
    outboundService: async request => {
      const call = { url: new URL(request.url), method: request.method, headers: request.headers,
        body: request.method === "POST" ? await request.json() : undefined };
      calls.push(call);
      if (call.url.origin !== "https://emailverifier.reoon.com" || call.url.pathname === "/unexpected-redirect") {
        return MockResponse.json({ unsafe: "An unexpected redirect or origin was contacted" });
      }
      return respond(call);
    },
  });
  await runtime.ready;
  database = await runtime.getD1Database("DB");
  const migrations = (await readdir(join(root, "drizzle"))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) {
    const sql = await readFile(join(root, "drizzle", name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
});

beforeEach(async () => {
  calls = [];
  respond = () => { throw new Error("Unexpected outbound request blocked by the smoke test"); };
  await database.batch([
    database.prepare("DELETE FROM email_jobs"),
    database.prepare("DELETE FROM email_settings"),
  ]);
});
after(async () => { await runtime?.dispose(); });

function safeResult(email) {
  return { email, status: "safe", verification_mode: "power", is_safe_to_send: true, is_deliverable: true,
    is_disposable: false, is_role_account: false, has_inbox_full: false,
    is_catch_all: false, is_disabled: false, is_spamtrap: false };
}

function balance() {
  return MockResponse.json({ status: "success", api_status: "active", remaining_daily_credits: 100,
    remaining_instant_credits: 1000 });
}

function installProvider({ rejectCreate = false } = {}) {
  const tasks = new Map();
  respond = call => {
    if (call.url.pathname === "/api/v1/check-account-balance/") return balance();
    if (call.url.pathname === "/api/v1/create-bulk-verification-task/") {
      assert.equal(call.body.key, fakeKey);
      assert.ok(call.body.name.length <= 25);
      if (rejectCreate) return MockResponse.json({ error: "Unconfirmed mock response" }, { status: 503 });
      const taskId = String(tasks.size + 12000);
      tasks.set(taskId, call.body.emails);
      return MockResponse.json({ status: "success", task_id: taskId, count_submitted: call.body.emails.length,
        count_processing: call.body.emails.length, count_duplicates_removed: 0, count_rejected_emails: 0 }, { status: 201 });
    }
    if (call.url.pathname === "/api/v1/get-result-bulk-verification-task/") {
      const taskId = call.url.searchParams.get("task_id");
      const expected = tasks.get(taskId);
      assert.ok(expected, "the Worker must poll the acknowledged and persisted task ID");
      return MockResponse.json({ status: "completed", task_id: taskId, count_total: expected.length,
        count_checked: expected.length, progress_percentage: 100,
        results: Object.fromEntries(expected.map(email => [email, safeResult(email)])) });
    }
    throw new Error("Unexpected provider operation blocked by the smoke test");
  };
  return tasks;
}

async function api(path, body, expectedStatus = 200) {
  const response = await runtime.dispatchFetch(`http://localhost/api/email/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: "http://localhost", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(value));
  assert.ok(!JSON.stringify(value).includes(fakeKey), "public API responses must not expose the saved key");
  assert.ok(!JSON.stringify(value).includes(masterKey), "public API responses must not expose the encryption key");
  return value;
}

async function readyJob() {
  const settings = await api("settings");
  await api("settings", { revision: settings.settings.revision, apiKey: fakeKey });
  await api("settings/check", {});
  const stored = await database.prepare("SELECT api_key_ciphertext FROM email_settings").first();
  assert.match(stored.api_key_ciphertext, /^v1:/);
  assert.ok(!stored.api_key_ciphertext.includes(fakeKey));
  const { job } = await api("jobs", { name: "Workers smoke test", sourceName: "synthetic.csv" }, 201);
  const upload = { index: 0, rows: emails.map((email, index) => ({ email, sourceRow: index + 2 })) };
  await api(`jobs/${job.id}/chunks`, upload);
  const replay = await api(`jobs/${job.id}/chunks`, upload);
  assert.equal(replay.job.totalRows, emails.length, "D1 import replay must be idempotent");
  await api(`jobs/${job.id}/seal`, { expectedChunks: 1, expectedRows: emails.length });
  await api(`jobs/${job.id}/start`, { acknowledgeProvider: true });
  return job;
}

async function makeDue(jobId) {
  await database.batch([
    database.prepare("UPDATE email_jobs SET next_run_at=0,lease_until=NULL WHERE id=?").bind(jobId),
    database.prepare("UPDATE email_batches SET next_poll_at=0 WHERE job_id=?").bind(jobId),
  ]);
}

test("Reoon balance and Power requests work through actual Workers fetch and Web APIs", async () => {
  respond = call => call.url.pathname.endsWith("check-account-balance/") ? balance()
    : MockResponse.json(safeResult(call.url.searchParams.get("email")));
  const balanceResponse = await runtime.dispatchFetch("http://localhost/adapter/balance");
  assert.equal(balanceResponse.status, 200, await balanceResponse.clone().text());
  assert.deepEqual(await balanceResponse.json(), { dailyCredits: 100, instantCredits: 1000, apiStatus: "active" });
  const singleResponse = await runtime.dispatchFetch("http://localhost/adapter/single");
  assert.equal(singleResponse.status, 200, await singleResponse.clone().text());
  assert.equal((await singleResponse.json()).category, "valid");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("mode"), "power");
  assert.equal(calls[1].url.searchParams.get("email"), emails[0]);
  assert.ok(calls.every(call => call.method === "GET" && call.url.searchParams.get("key") === fakeKey));
});

test("bulk creation submits one documented JSON request in workerd", async () => {
  installProvider();
  const response = await runtime.dispatchFetch("http://localhost/adapter/create");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).taskId, "12000");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].headers.get("Content-Type"), "application/json");
  assert.deepEqual(calls[0].body, { emails, name: "EV-runtime-test", key: fakeKey });
});

test("Workers never follows a Reoon redirect or replays a paid creation", async () => {
  for (const [operation, status, expectedOutcome] of [["balance", 302, "not_submitted"], ["create", 307, "uncertain"]]) {
    calls = [];
    respond = () => new MockResponse(null, { status, headers: { Location: "https://different.example/unexpected-redirect" } });
    const response = await runtime.dispatchFetch(`http://localhost/adapter/${operation}`);
    assert.equal(response.status, 502);
    const value = await response.json();
    assert.equal(value.submissionOutcome, expectedOutcome);
    assert.equal(calls.length, 1, "a redirect must not replay the request or forward the key");
    assert.ok(!JSON.stringify(value).includes(fakeKey));
  }
});

test("real D1 migrations support encrypted settings, idempotent import, one concurrent bulk submit and final results", async () => {
  const tasks = installProvider();
  const job = await readyJob();
  const advanced = await Promise.all([api(`jobs/${job.id}/advance`, {}), api(`jobs/${job.id}/advance`, {})]);
  assert.ok(advanced.every(value => value.job.status === "running"));
  assert.equal(tasks.size, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("create-bulk-verification-task/")).length, 1);
  await makeDue(job.id);
  const finished = await api(`jobs/${job.id}/advance`, {});
  assert.equal(finished.job.status, "completed");
  assert.equal(finished.job.counts.valid, emails.length);
  assert.equal(finished.job.counts.pending, 0);
  assert.equal(finished.job.counts.processing, 0);
  const results = await api(`jobs/${job.id}/results?filter=valid`);
  assert.deepEqual(results.rows.map(row => row.email), emails);
  assert.ok(results.rows.every(row => row.category === "valid" && row.providerStatus === "safe"));
  const persisted = await database.prepare("SELECT status,task_id FROM email_batches WHERE job_id=?").bind(job.id).first();
  assert.deepEqual(persisted, { status: "completed", task_id: "12000" });
  assert.equal(calls.filter(call => call.url.pathname.endsWith("create-bulk-verification-task/")).length, 1);
});

test("uncertain creation stays recorded in real D1 and subsequent advances never submit it again", async () => {
  installProvider({ rejectCreate: true });
  const job = await readyJob();
  const uncertain = await api(`jobs/${job.id}/advance`, {});
  assert.equal(uncertain.job.status, "needs_attention");
  assert.equal(uncertain.job.counts.unknown, emails.length);
  await makeDue(job.id);
  await api(`jobs/${job.id}/advance`, {});
  await api(`jobs/${job.id}/action`, { action: "resume" });
  const finished = await api(`jobs/${job.id}/advance`, {});
  assert.equal(finished.job.status, "completed");
  assert.equal(finished.job.counts.unknown, emails.length);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("create-bulk-verification-task/")).length, 1);
  const batch = await database.prepare("SELECT status FROM email_batches WHERE job_id=?").bind(job.id).first();
  assert.equal(batch.status, "unknown");
});
