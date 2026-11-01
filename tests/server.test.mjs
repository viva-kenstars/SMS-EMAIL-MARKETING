import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

// Exercise the real server module, replacing only the runtime environment binding.
// No real provider request is permitted by this test file.
const root = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(root, "outputs", "server-test");
const bundlePath = join(outputDirectory, "server.bundle.mjs");
await mkdir(outputDirectory, { recursive: true });
globalThis.__smsTestEnv = {};
await build({
  entryPoints: [join(root, "app/lib/server.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Load the real CommonJS sanitizer through Node's package loader. Bundling its
  // PostCSS dependency into ESM would leave unsupported dynamic require calls.
  external: ["sanitize-html"],
  plugins: [{
    name: "sms-test-environment",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "sms-test-env" }));
      build.onLoad({ filter: /.*/, namespace: "sms-test-env" }, () => ({ contents: "export const env = globalThis.__smsTestEnv;", loader: "js" }));
    },
  }],
});
const { handleApi } = await import(pathToFileURL(bundlePath).href);
const migrationDirectory = join(root, "drizzle");
const migrationNames = (await readdir(migrationDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const migrations = await Promise.all(migrationNames.map(name => readFile(join(migrationDirectory, name), "utf8")));
const testMasterKey = Buffer.from(new Uint8Array(32).fill(73)).toString("base64");
const originalFetch = globalThis.fetch;
let database;
let providerCalls;

class MemoryD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new MemoryD1Statement(this.database, this.sql, bindings); }
  async first(column) {
    this.database.queryCount += 1;
    const result = this.database.sqlite.prepare(this.sql).get(...this.bindings);
    this.database.resultRowCount += result === undefined ? 0 : 1;
    return result === undefined ? null : column === undefined ? result : result[column];
  }
  async all() {
    this.database.queryCount += 1;
    const results = this.database.sqlite.prepare(this.sql).all(...this.bindings);
    this.database.resultRowCount += results.length;
    return { success: true, results, meta: {} };
  }
  execute() {
    this.database.queryCount += 1;
    const result = this.database.sqlite.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

class MemoryD1 {
  constructor() {
    this.queryCount = 0;
    this.resultRowCount = 0;
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for (const migration of migrations) this.sqlite.exec(migration);
  }
  prepare(sql) { return new MemoryD1Statement(this, sql); }
  async batch(statements) {
    // D1 batches are transactions. Keep execution synchronous inside this transaction.
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

beforeEach(() => {
  database = new MemoryD1();
  providerCalls = [];
  for (const key of Object.keys(globalThis.__smsTestEnv)) delete globalThis.__smsTestEnv[key];
  Object.assign(globalThis.__smsTestEnv, { DB: database, SMS_SETTINGS_ENCRYPTION_KEY: testMasterKey });
  globalThis.fetch = async (...args) => {
    providerCalls.push(args);
    throw new Error("Unexpected provider request blocked by the test harness");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  database.close();
});

function allowLive() {
  Object.assign(globalThis.__smsTestEnv, {
    TERMII_API_KEY: "fake-test-key-never-used-on-a-network",
    TERMII_BASE_URL: "https://api.termii.com",
    SMS_LIVE_ENABLED: "true",
  });
}

function mockProvider(handler, expectedOrigin = "https://api.termii.com") {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, expectedOrigin, "provider origin must be the configured Termii origin");
    providerCalls.push({ url, init });
    return handler(url, init);
  };
}

async function api(path, body, { owner = "owner-alice", method = body === undefined ? "GET" : "POST", authenticated = true } = {}) {
  const headers = new Headers({ Origin: "https://sms.test" });
  if (authenticated) {
    headers.set("oai-authenticated-user-id", owner);
    headers.set("oai-authenticated-user-email", `${owner}@example.test`);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await handleApi(new Request(`https://sms.test/api/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: response.status, body: await response.json() };
}

const phone = index => `+23480${String(index).padStart(8, "0")}`;

async function contacts(count, owner = "owner-alice") {
  const created = await api("contacts", { contacts: Array.from({ length: count }, (_, index) => ({ name: `Test contact ${index}`, phone: phone(index), consent: true, group: "Test audience" })) }, { owner });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.inserted, count);
  const state = await api("state", undefined, { owner });
  return state.body.contacts;
}

async function settings({ transactionalEnabled = true, senderApproved = true, owner = "owner-alice" } = {}) {
  const result = await api("settings", { senderId: "Trezad", senderApproved, transactionalEnabled, ratePerSegment: 6.5 }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function campaign(audience, { mode = "draft", owner = "owner-alice" } = {}) {
  const result = await api("campaigns", { name: "Integration test", message: "A test service notification.", senderId: "Trezad", channel: "dnd", contactIds: audience.map(contact => contact.id), mode }, { owner });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.campaign;
}

function directCampaignBody(directNumbers, overrides = {}) {
  return {
    name: "Direct integration test",
    message: "A test service notification.",
    senderId: "Trezad",
    channel: "dnd",
    mode: "draft",
    audienceSource: "direct",
    directNumbers,
    directConsent: true,
    ...overrides,
  };
}

async function directCampaign(directNumbers, { mode = "draft", owner = "owner-alice" } = {}) {
  const result = await api("campaigns", directCampaignBody(directNumbers, { mode }), { owner });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.campaign.audienceSource, "direct");
  return result.body.campaign;
}

function campaignTableCounts() {
  return Object.fromEntries(["campaigns", "batches", "recipients"].map(table => [table, database.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

const ownedApiKey = "owned-termii-key-alice-for-mocked-tests-only";
const replacementApiKey = "replacement-termii-key-alice-for-mocked-tests-only";

const emailWorkerTestToken = "synthetic-email-worker-token-not-a-real-service-credential";
function configureEmailWorker() {
  globalThis.__smsTestEnv.EMAIL_WORKER_TOKEN_SHA256 = createHash("sha256").update(emailWorkerTestToken).digest("hex");
}
async function workerCall({ token = emailWorkerTestToken, body = {}, method = "POST", origin } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("X-Email-Worker-Token", token);
  if (origin) headers.set("Origin", origin);
  const response = await handleApi(new Request("https://sms.test/api/email/worker", {
    method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() };
}

test("email routes enforce the existing authenticated owner boundary", async () => {
  for (const path of ["email/settings", "email/jobs", "email/runner"]) {
    assert.equal((await api(path, undefined, { authenticated: false })).status, 401);
  }
  const created = await api("email/jobs", { name: "Integration test", sourceName: "synthetic.csv" });
  assert.equal(created.status, 201);
  assert.equal((await api(`email/jobs/${created.body.job.id}`, undefined, { owner: "owner-bob" })).status, 404);
  assert.equal(providerCalls.length, 0);
});

test("background callback rejects missing, wrong or unconfigured application credentials", async () => {
  assert.equal((await workerCall()).status, 401);
  configureEmailWorker();
  const before = database.queryCount;
  for (const token of [null, "wrong-token", emailWorkerTestToken + "suffix"]) assert.equal((await workerCall({ token })).status, 401);
  assert.equal(database.queryCount, before, "unauthorized callbacks must not access queue data");
  assert.equal(providerCalls.length, 0);
});

test("a protected callback records a heartbeat without starting uploaded or ready jobs", async () => {
  configureEmailWorker();
  const created = await api("email/jobs", { name: "Not started" });
  const id = created.body.job.id;
  assert.equal((await api(`email/jobs/${id}/chunks`, { index: 0, rows: [{ email: "test@example.net", sourceRow: 1 }] })).status, 200);
  assert.equal((await api(`email/jobs/${id}/seal`, { expectedChunks: 1, expectedRows: 1 })).status, 200);
  const before = await api("email/runner");
  assert.equal(before.body.enabled, true); assert.equal(before.body.healthy, false);
  const callback = await workerCall();
  assert.equal(callback.status, 200, JSON.stringify(callback.body));
  assert.equal(callback.body.ok, true); assert.equal(callback.body.advanced, 0);
  const after = await api("email/runner");
  assert.equal(after.body.healthy, true); assert.ok(after.body.lastHeartbeatAt > 0);
  assert.equal((await api(`email/jobs/${id}`)).body.job.status, "ready");
  assert.equal(providerCalls.length, 0);
});

test("background callback cannot be used to import data, select owners or edit provider keys", async () => {
  configureEmailWorker();
  for (const body of [{ owner: "owner-bob" }, { apiKey: "another-secret" }, { action: "start" }, [], { rows: [{ email: "test@example.net" }] }]) {
    assert.equal((await workerCall({ body })).status, 400);
  }
  assert.equal((await workerCall({ method: "GET" })).status, 405);
  assert.equal((await workerCall({ origin: "https://untrusted.example" })).status, 403);
  assert.equal(providerCalls.length, 0);
});

test("oversized callback payloads stop before queue access", async () => {
  configureEmailWorker();
  const before = database.queryCount;
  assert.equal((await workerCall({ body: { padding: "x".repeat(4096) } })).status, 400);
  assert.equal(database.queryCount, before);
});

test("runner health becomes stale and never returns service credentials or fingerprints", async () => {
  configureEmailWorker();
  database.sqlite.prepare("INSERT INTO email_worker_state(key,last_run_at,last_error) VALUES('queue',?,NULL)").run(Date.now() - 76 * 60 * 1000);
  const stale = await api("email/runner");
  assert.equal(stale.body.enabled, true); assert.equal(stale.body.healthy, false);
  assert.doesNotMatch(JSON.stringify(stale.body), new RegExp(emailWorkerTestToken));
  assert.ok(!JSON.stringify(stale.body).includes(globalThis.__smsTestEnv.EMAIL_WORKER_TOKEN_SHA256));
});

async function providerState(owner = "owner-alice") {
  const result = await api("state", undefined, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.provider;
}

async function saveProvider(overrides = {}, owner = "owner-alice") {
  const current = await providerState(owner);
  const result = await api("provider/settings", { baseUrl: "https://api.termii.com", apiKey: ownedApiKey, revision: current.revision, ...overrides }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.provider);
  return result.body.provider;
}

function mockBalance(expectedKey = ownedApiKey) {
  mockProvider(url => {
    assert.equal(url.pathname, "/api/get-balance", "configuration operations must never call the send API");
    assert.equal(url.searchParams.get("api_key"), expectedKey);
    return Response.json({ balance: 1234.5, currency: "NGN" });
  });
}

async function verifyProvider(owner = "owner-alice") {
  const result = await api("provider/check", {}, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.connected, true);
  assert.equal(result.body.balance, 1234.5);
  assert.equal(result.body.currency, "NGN");
  assert.ok(result.body.provider.verifiedAt);
  return result.body.provider;
}

function assertNoCredentials(value, ...keys) {
  const serialized = JSON.stringify(value);
  for (const key of [testMasterKey, ownedApiKey, replacementApiKey, ...keys]) {
    assert.ok(!serialized.includes(key), "API responses must never contain credentials or the master key");
  }
}

const whatsappDefaults = {
  deviceId: "test_whatsapp_device_alice",
  businessName: "Trezad Test Community",
  templateId: "test_approved_invitation",
  templateBody: "{{community}} invites you to our WhatsApp updates: {{invite_link}}",
  category: "marketing",
  accountApproved: true,
  templateApproved: true,
  ratePerMessage: 12.5,
};
const whatsappData = {
  community: "Trezad Community",
  invite_link: "https://example.test/community-invitation",
};

async function whatsappState(owner = "owner-alice") {
  const result = await api("state", undefined, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.whatsapp, "state must expose the current owner's WhatsApp configuration");
  return result.body.whatsapp;
}

async function saveWhatsApp(overrides = {}, owner = "owner-alice") {
  const current = await whatsappState(owner);
  const result = await api("whatsapp/settings", { ...whatsappDefaults, revision: current.revision, ...overrides }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.whatsapp);
  assertNoCredentials(result.body);
  return result.body.whatsapp;
}

async function enableWhatsApp(owner = "owner-alice") {
  const current = await whatsappState(owner);
  const result = await api("whatsapp/settings", { liveEnabled: true, revision: current.revision }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.whatsapp.liveEnabled, true);
  assertNoCredentials(result.body);
  return result.body.whatsapp;
}

async function setupWhatsApp(overrides = {}, owner = "owner-alice") {
  await saveProvider({}, owner);
  mockBalance();
  await verifyProvider(owner);
  const saved = await saveWhatsApp(overrides, owner);
  assert.equal(saved.liveEnabled, false, "configuration and activation require separate review steps");
  return enableWhatsApp(owner);
}

function whatsappCampaignBody(audience, overrides = {}) {
  return {
    name: "WhatsApp invitation integration test",
    channel: "whatsapp",
    mode: "draft",
    contactIds: audience.map(contact => contact.id),
    whatsappData: { ...whatsappData },
    whatsappPermission: true,
    ...overrides,
  };
}

async function whatsappCampaign(audience, overrides = {}, owner = "owner-alice") {
  const result = await api("campaigns", whatsappCampaignBody(audience, overrides), { owner });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.campaign.channel, "whatsapp");
  assert.ok(result.body.campaign.whatsapp);
  return result.body.campaign;
}

function mockWhatsAppSends(handler = (_payload, index) => Response.json({ code: "ok", message_id_str: `whatsapp_message_${index}` })) {
  const payloads = [];
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/send/template", "WhatsApp dispatch must never use SMS, free-form, or an implicit fallback");
    assert.equal(init.method, "POST");
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    return handler(payload, payloads.length);
  });
  return payloads;
}

test("identity is required before contacts or campaigns can be read", async () => {
  const result = await api("state", undefined, { authenticated: false });
  assert.equal(result.status, 401);
  assert.equal(providerCalls.length, 0);
});

test("contacts, campaign details, mutations, and audience selection remain owner scoped", async () => {
  const alice = await contacts(1);
  const draft = await campaign(alice);
  assert.equal(draft.audienceSource, "contacts", "old clients default to saved-contact campaigns");
  const bobState = await api("state", undefined, { owner: "owner-bob" });
  assert.deepEqual(bobState.body.contacts, []);
  assert.deepEqual(bobState.body.campaigns, []);
  assert.equal((await api(`campaigns/${draft.id}`, undefined, { owner: "owner-bob" })).status, 404);
  assert.equal((await api("contacts", { id: alice[0].id, suppressed: true }, { owner: "owner-bob", method: "PATCH" })).status, 404);
  const foreignAudience = await api("campaigns", { name: "Other owner's contacts", message: "Hello", senderId: "Trezad", channel: "generic", contactIds: [alice[0].id], mode: "draft" }, { owner: "owner-bob" });
  assert.equal(foreignAudience.status, 400);
  assert.equal((await api("state")).body.contacts[0].suppressed, false);
  assert.equal(providerCalls.length, 0);
});

test("imports normalize and deduplicate numbers without clearing an existing suppression", async () => {
  const result = await api("contacts", { contacts: [
    { name: "One", phone: "08031234567", consent: true },
    { name: "Duplicate", phone: "+234 (803) 123-4567", consent: true },
    { name: "Invalid", phone: "not a number", consent: true },
  ] });
  assert.equal(result.status, 200);
  assert.equal(result.body.inserted, 1);
  assert.equal(result.body.duplicates, 1);
  assert.equal(result.body.invalid, 1);
  const contact = (await api("state")).body.contacts[0];
  assert.equal(contact.phone, "+2348031234567");
  await api("contacts", { id: contact.id, suppressed: true }, { method: "PATCH" });
  const repeated = await api("contacts", { contacts: [{ name: "Reimport", phone: "2348031234567", consent: true }] });
  assert.equal(repeated.body.inserted, 0);
  assert.equal(repeated.body.duplicates, 1);
  assert.equal((await api("state")).body.contacts[0].suppressed, true);
  assert.equal(providerCalls.length, 0);
});

test("preview campaigns persist validation results and cannot send even when live credentials exist", async () => {
  allowLive();
  await settings();
  const preview = await campaign(await contacts(2), { mode: "preview" });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.status, "preview");
  assert.equal(preview.summary.validated, 2);
  const detail = await api(`campaigns/${preview.id}`);
  assert.equal(detail.body.recipients.length, 2);
  assert.ok(detail.body.recipients.every(recipient => recipient.status === "validated"));
  assert.equal((await api(`campaigns/${preview.id}/send`, { confirmed: true })).status, 409);
  assert.equal(providerCalls.length, 0);
});

test("live sends stay disabled until the server configuration explicitly enables them", async () => {
  await settings();
  const draft = await campaign(await contacts(1));
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).status, 409);
  assert.equal((await api(`campaigns/${draft.id}`)).body.campaign.summary.pending, 1);
  assert.equal(providerCalls.length, 0);
});

test("a transactional campaign requires explicit route approval", async () => {
  allowLive();
  await settings({ transactionalEnabled: false });
  const draft = await campaign(await contacts(1));
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).status, 409);
  assert.equal(providerCalls.length, 0);
});

test("101 recipients are persisted and submitted as 100 plus 1, without repeating completed batches", async t => {
  allowLive();
  await settings();
  const draft = await campaign(await contacts(101));
  const payloads = [];
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/sms/send/bulk");
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    assert.equal(payload.channel, "dnd");
    assert.ok(payload.to.length <= 100);
    return Response.json({ code: "ok", message_id: `provider_${payloads.length}` });
  });
  const before = database.queryCount;
  const first = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  const queries = database.queryCount - before;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  t.diagnostic(`100-recipient Termii dispatch: ${queries} database statements`);
  assert.ok(queries <= 35, `Termii dispatch must retain query headroom; used ${queries} statements`);
  assert.equal(first.body.remaining, 1);
  assert.equal(first.body.campaign.summary.accepted, 100);
  assert.equal(first.body.campaign.summary.delivered, 0);
  const second = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(second.body.remaining, 0);
  assert.equal(second.body.campaign.summary.accepted, 101);
  assert.equal(second.body.campaign.status, "submitted");
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.deepEqual(payloads.map(payload => payload.to.length), [100, 1]);
  assert.equal(new Set(payloads.flatMap(payload => payload.to)).size, 101);
  assert.ok(payloads.every(payload => payload.to.every(number => /^234[789]\d{9}$/.test(number))));
  const tooMany = await api("campaigns", { name: "Too many", message: "Hello", senderId: "Trezad", channel: "dnd", contactIds: Array(5001).fill(draft.id), mode: "draft" });
  assert.equal(tooMany.status, 400);
});

test("two concurrent send requests cannot claim or bill the same batch twice", async () => {
  allowLive();
  await settings();
  const draft = await campaign(await contacts(101));
  let releaseProvider;
  let signalProviderEntered;
  const providerEntered = new Promise(resolve => { signalProviderEntered = resolve; });
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const payloads = [];
  mockProvider(async (url, init) => {
    assert.equal(url.pathname, "/api/sms/send/bulk");
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    signalProviderEntered();
    await providerGate;
    return Response.json({ code: "ok", message_id: `concurrent_${payloads.length}` });
  });
  const first = api(`campaigns/${draft.id}/send`, { confirmed: true });
  const second = api(`campaigns/${draft.id}/send`, { confirmed: true });
  await providerEntered;
  const paused = await Promise.race([first, second]);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.halted, true);
  assert.ok(paused.body.remaining > 0);
  assert.equal(payloads.length, 1);
  releaseProvider();
  await Promise.all([first, second]);
  const detail = await api(`campaigns/${draft.id}`);
  assert.equal(detail.body.campaign.summary.accepted, 100);
  assert.equal(detail.body.campaign.summary.pending, 1);
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.deepEqual(payloads.map(payload => payload.to.length), [100, 1]);
  assert.equal(new Set(payloads.flatMap(payload => payload.to)).size, 101);
});

test("suppression and withdrawn permission are rechecked immediately before dispatch", async () => {
  allowLive();
  await settings();
  const audience = await contacts(2);
  const draft = await campaign(audience);
  await api("contacts", { id: audience[0].id, suppressed: true }, { method: "PATCH" });
  await api("contacts", { id: audience[1].id, consent: false }, { method: "PATCH" });
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.campaign.summary.skipped, 2);
  assert.equal(result.body.remaining, 0);
  assert.equal(providerCalls.length, 0);
});

test("an ambiguous provider outcome halts further batches and can never be retried automatically", async () => {
  allowLive();
  await settings();
  const draft = await campaign(await contacts(101));
  mockProvider(() => { throw new Error(`Uncertain socket error with ${globalThis.__smsTestEnv.TERMII_API_KEY}`); });
  const first = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.halted, true);
  assert.equal(first.body.campaign.status, "attention");
  assert.equal(first.body.campaign.summary.unknown, 100);
  assert.equal(first.body.remaining, 1);
  assert.doesNotMatch(JSON.stringify(first.body), /fake-test-key/);
  const second = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(second.body.halted, true);
  assert.equal(second.body.remaining, 1);
  assert.equal(providerCalls.length, 1);
});

test("an explicit provider rejection preserves the unsent remainder and reports attention", async () => {
  allowLive();
  await settings();
  const draft = await campaign(await contacts(101));
  mockProvider(() => Response.json({ secret: "provider error body" }, { status: 403 }));
  const first = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(first.body.halted, true);
  assert.equal(first.body.campaign.status, "attention");
  assert.equal(first.body.campaign.summary.failed, 100);
  assert.equal(first.body.remaining, 1);
  const second = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(second.body.halted, true);
  assert.equal(second.body.remaining, 1);
  assert.equal(providerCalls.length, 1);
});

test("delivery refresh matches provider ID and phone, keeps Message Sent pending delivery, and never regresses delivery", async () => {
  allowLive();
  await settings();
  const audience = await contacts(2);
  const draft = await campaign(audience);
  let submitted;
  let refreshCount = 0;
  mockProvider((url, init) => {
    if (url.pathname === "/api/sms/send/bulk") {
      submitted = JSON.parse(init.body).to;
      return Response.json({ code: "ok", message_id_str: "3017544054459083819856413" });
    }
    assert.equal(url.pathname, "/api/sms/inbox");
    assert.equal(url.searchParams.get("message_id"), "3017544054459083819856413");
    refreshCount += 1;
    return Response.json([
      { receiver: submitted[0], message_id: "3017544054459083819856413", status: refreshCount === 1 ? "Delivered" : "Message Failed" },
      { receiver: submitted[1], message_id: "3017544054459083819856413", status: refreshCount === 1 ? "Message Sent" : "DND Active on Phone Number" },
      { receiver: submitted[1], message_id: "unrelated_id", status: "Delivered" },
      { receiver: "2348999999999", message_id: "3017544054459083819856413", status: "Delivered" },
    ]);
  });
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.body.campaign.summary.accepted, 2);
  assert.equal(sent.body.campaign.summary.delivered, 0);
  const first = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.campaign.summary.delivered, 1);
  assert.equal(first.body.campaign.summary.accepted, 1);
  assert.equal(first.body.campaign.summary.unknown, 0);
  const second = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(second.body.campaign.summary.delivered, 1);
  assert.equal(second.body.campaign.summary.failed, 1);
  assert.equal(second.body.campaign.summary.accepted, 0);
});

test("provider settings, checks, and disconnect require an authenticated owner", async () => {
  const operations = [
    ["provider/settings", { baseUrl: "https://api.termii.com", apiKey: ownedApiKey, revision: 0 }, "POST"],
    ["provider/settings", { revision: 0 }, "DELETE"],
    ["provider/check", {}, "POST"],
  ];
  for (const [path, body, method] of operations) {
    const result = await api(path, body, { authenticated: false, method });
    assert.equal(result.status, 401);
    assertNoCredentials(result.body);
  }
  assert.equal(providerCalls.length, 0);
});

test("saving an in-app key encrypts it at rest and never returns it through API state", async () => {
  const initial = await providerState();
  assert.equal(initial.configurationAvailable, true);
  const saved = await saveProvider();
  assert.equal(saved.configured, true);
  assert.equal(saved.apiKeyConfigured, true);
  assert.equal(saved.baseUrl, "https://api.termii.com");
  assert.equal(saved.liveEnabled, false);
  assert.ok(!saved.verifiedAt);
  assert.notEqual(saved.revision, initial.revision);
  assertNoCredentials(saved);
  const state = await api("state");
  assertNoCredentials(state.body);
  const row = database.sqlite.prepare("SELECT * FROM provider_settings WHERE owner = ?").get("owner-alice");
  assert.ok(row, "provider settings must persist for this owner");
  assertNoCredentials(row);
  assert.equal(providerCalls.length, 0, "saving configuration must not contact the provider");
  // A later balance request must decrypt the stored key to the original value.
  mockBalance();
  const verified = await verifyProvider();
  assertNoCredentials(verified);
});

test("a blank key keeps the existing encrypted credential without erasing or exposing it", async () => {
  const saved = await saveProvider();
  const kept = await api("provider/settings", { apiKey: "", baseUrl: "https://api.termii.com", revision: saved.revision });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.provider.apiKeyConfigured, true);
  assertNoCredentials(kept.body);
  mockBalance();
  await verifyProvider();
  assert.equal(providerCalls.length, 1);
});

for (const failure of [
  { name: "authentication rejection", reason: "authentication", status: 401, contentType: "application/json", outcome: "rejected", response: () => Response.json({ error: `upstream-private-body-${ownedApiKey}` }, { status: 401 }) },
  { name: "provider outage", reason: "http_error", status: 503, contentType: "text/html", outcome: "unknown", response: () => new Response(`upstream-private-body-${ownedApiKey}`, { status: 503, headers: { "Content-Type": "text/html" } }) },
  { name: "redirect", reason: "redirect", status: 307, contentType: "text/plain", outcome: "unknown", response: () => new Response(`upstream-private-body-${ownedApiKey}`, { status: 307, headers: { Location: `https://example.test/secret?api_key=${ownedApiKey}` } }) },
  { name: "invalid JSON", reason: "invalid_json", status: 200, contentType: "text/html", outcome: "unknown", response: () => new Response(`upstream-private-body-${ownedApiKey}`, { headers: { "Content-Type": "text/html" } }) },
  { name: "connection failure", reason: "network_error", outcome: "unknown", response: () => { throw new TypeError(`Failed to fetch https://api.termii.com/api/get-balance?api_key=${ownedApiKey}`); } },
  { name: "timeout", reason: "timeout", outcome: "unknown", response: () => { throw new DOMException(`upstream-private-body-${ownedApiKey}`, "TimeoutError"); } },
]) {
  test(`a balance-check ${failure.name} is read-only and returns safe, operation-specific diagnostics`, async () => {
    const saved = await saveProvider();
    const beforeCounts = campaignTableCounts();
    mockProvider((url, init) => {
      assert.equal(url.pathname, "/api/get-balance");
      assert.equal(url.searchParams.get("api_key"), ownedApiKey);
      assert.equal(init.body, undefined);
      return failure.response();
    });
    const checked = await api("provider/check", {});
    assert.equal(checked.status, 502);
    assert.match(checked.body.error, /balance check/);
    assert.match(checked.body.error, /does not send messages/);
    assert.doesNotMatch(checked.body.error, /history|sending again|resending/i);
    assert.equal(checked.body.outcome, failure.outcome);
    assert.equal(checked.body.code, `provider_balance_${failure.reason}`);
    assert.deepEqual(checked.body.diagnostic, {
      operation: "balance",
      reason: failure.reason,
      ...(failure.status === undefined ? {} : { upstreamStatus: failure.status }),
      ...(failure.contentType === undefined ? {} : { contentType: failure.contentType }),
    });
    assertNoCredentials(checked.body);
    assert.doesNotMatch(JSON.stringify(checked.body), /upstream-private-body|example\.test\/secret|https:\/\/api\.termii\.com/);
    assert.equal(providerCalls.length, 1, "a failed check must not make another provider request");
    assert.deepEqual(campaignTableCounts(), beforeCounts, "a connection check must not create or send a campaign");
    const after = await providerState();
    assert.equal(after.apiKeyConfigured, true);
    assert.equal(after.revision, saved.revision);
    assert.ok(!after.verifiedAt);
    assert.equal(after.liveEnabled, false);
    // A transient failure must not erase the encrypted key or block a later read-only check.
    mockBalance();
    await verifyProvider();
    assert.equal(providerCalls.length, 2);
  });
}

test("live sending cannot be enabled until the stored credentials pass a balance check", async () => {
  await settings();
  const saved = await saveProvider();
  const tooSoon = await api("provider/settings", { liveEnabled: true, revision: saved.revision });
  assert.equal(tooSoon.status, 409, JSON.stringify(tooSoon.body));
  assert.equal((await providerState()).liveEnabled, false);
  assert.equal(providerCalls.length, 0);
  mockBalance();
  const verified = await verifyProvider();
  assert.equal(verified.liveEnabled, false);
  const enabled = await api("provider/settings", { liveEnabled: true, revision: verified.revision });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.provider.liveEnabled, true);
  assert.ok(enabled.body.provider.verifiedAt);
  assertNoCredentials(enabled.body);
  assert.equal(providerCalls.length, 1, "the only provider call must be the read-only balance check");
});

test("changing the base URL clears verification and disables live sending", async () => {
  await settings();
  await saveProvider();
  mockBalance();
  const verified = await verifyProvider();
  const enabled = await api("provider/settings", { liveEnabled: true, revision: verified.revision });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const changed = await api("provider/settings", { baseUrl: "https://api.ng.termii.com", apiKey: "", revision: enabled.body.provider.revision });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.provider.baseUrl, "https://api.ng.termii.com");
  assert.equal(changed.body.provider.liveEnabled, false);
  assert.ok(!changed.body.provider.verifiedAt);
  assert.equal(changed.body.provider.apiKeyConfigured, true);
  assert.equal(providerCalls.length, 1);
  // Retaining the credential while changing its context must still allow decryption.
  mockProvider(url => {
    assert.equal(url.pathname, "/api/get-balance");
    assert.equal(url.searchParams.get("api_key"), ownedApiKey);
    return Response.json({ balance: 1234.5, currency: "NGN" });
  }, "https://api.ng.termii.com");
  await verifyProvider();
});

test("replacing an API key clears verification and live mode and uses the replacement on the next check", async () => {
  await settings();
  await saveProvider();
  mockBalance();
  const verified = await verifyProvider();
  const enabled = await api("provider/settings", { liveEnabled: true, revision: verified.revision });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const replaced = await api("provider/settings", { apiKey: replacementApiKey, revision: enabled.body.provider.revision });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.provider.liveEnabled, false);
  assert.ok(!replaced.body.provider.verifiedAt);
  assertNoCredentials(replaced.body);
  mockBalance(replacementApiKey);
  await verifyProvider();
});

test("stale revisions cannot overwrite or delete newer provider settings", async () => {
  const initial = await providerState();
  const saved = await saveProvider();
  const staleSave = await api("provider/settings", { apiKey: replacementApiKey, baseUrl: "https://api.ng.termii.com", revision: initial.revision });
  assert.equal(staleSave.status, 409, JSON.stringify(staleSave.body));
  const staleDelete = await api("provider/settings", { revision: initial.revision }, { method: "DELETE" });
  assert.equal(staleDelete.status, 409, JSON.stringify(staleDelete.body));
  const current = await providerState();
  assert.equal(current.revision, saved.revision);
  assert.equal(current.baseUrl, "https://api.termii.com");
  assert.equal(current.apiKeyConfigured, true);
  mockBalance();
  await verifyProvider();
});

test("a connection check cannot verify credentials replaced while the balance call is in flight", async () => {
  const saved = await saveProvider();
  let releaseBalance;
  let enteredBalance;
  const entered = new Promise(resolve => { enteredBalance = resolve; });
  const gate = new Promise(resolve => { releaseBalance = resolve; });
  mockProvider(async url => {
    assert.equal(url.pathname, "/api/get-balance");
    assert.equal(url.searchParams.get("api_key"), ownedApiKey);
    enteredBalance();
    await gate;
    return Response.json({ balance: 1234.5, currency: "NGN" });
  });
  const checking = api("provider/check", {});
  await entered;
  const changed = await api("provider/settings", { apiKey: replacementApiKey, revision: saved.revision });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  releaseBalance();
  const checked = await checking;
  assert.equal(checked.status, 409, JSON.stringify(checked.body));
  const current = await providerState();
  assert.equal(current.revision, changed.body.provider.revision);
  assert.ok(!current.verifiedAt);
  assert.equal(current.liveEnabled, false);
  assertNoCredentials(checked.body);
});

test("disconnect removes the usable credential and live state", async () => {
  await settings();
  await saveProvider();
  mockBalance();
  const verified = await verifyProvider();
  const enabled = await api("provider/settings", { liveEnabled: true, revision: verified.revision });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const removed = await api("provider/settings", { revision: enabled.body.provider.revision }, { method: "DELETE" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.provider.configured, false);
  assert.equal(removed.body.provider.apiKeyConfigured, false);
  assert.equal(removed.body.provider.liveEnabled, false);
  assert.ok(!removed.body.provider.verifiedAt);
  assertNoCredentials(removed.body);
  const callsBefore = providerCalls.length;
  assert.equal((await api("provider/check", {})).status, 409);
  assert.equal(providerCalls.length, callsBefore);
});

test("disconnect keeps legacy environment credentials from silently reconnecting the workspace", async () => {
  allowLive();
  const before = await providerState();
  assert.equal(before.source, "environment");
  assert.equal(before.configured, true);
  assert.equal(before.liveEnabled, true);
  const removed = await api("provider/settings", { revision: before.revision }, { method: "DELETE" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.provider.configured, false);
  assert.equal(removed.body.provider.liveEnabled, false);
  const reloaded = await providerState();
  assert.equal(reloaded.configured, false);
  assert.equal(reloaded.apiKeyConfigured, false);
  assert.equal(reloaded.liveEnabled, false);
  assert.equal((await api("provider/check", {})).status, 409);
  assert.equal(providerCalls.length, 0);
});

test("in-app provider keys and revisions are isolated between authenticated owners", async () => {
  const alice = await saveProvider();
  const bobBefore = await providerState("owner-bob");
  assert.equal(bobBefore.configured, false);
  assert.equal(bobBefore.apiKeyConfigured, false);
  assertNoCredentials(bobBefore);
  const bobKey = "owned-termii-key-bob-for-mocked-tests-only";
  // A body-supplied owner must never change the authenticated ownership boundary.
  const bob = await saveProvider({ owner: "owner-alice", apiKey: bobKey }, "owner-bob");
  assert.equal(bob.configured, true);
  assert.equal((await providerState()).revision, alice.revision);
  mockBalance(bobKey);
  await verifyProvider("owner-bob");
  mockBalance();
  await verifyProvider();
  const rows = database.sqlite.prepare("SELECT * FROM provider_settings ORDER BY owner").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.owner), ["owner-alice", "owner-bob"]);
  assertNoCredentials(rows, bobKey);
});

test("missing master encryption key fails closed without saving plaintext or contacting Termii", async () => {
  delete globalThis.__smsTestEnv.SMS_SETTINGS_ENCRYPTION_KEY;
  const initial = await providerState();
  assert.equal(initial.configurationAvailable, false);
  const result = await api("provider/settings", { baseUrl: "https://api.termii.com", apiKey: ownedApiKey, revision: initial.revision });
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assertNoCredentials(result.body);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_settings").get().n, 0);
  assert.equal(providerCalls.length, 0);
});

test("a direct draft normalizes four phone formats, deduplicates, and creates no address-book contacts", async () => {
  allowLive();
  await settings();
  assert.deepEqual((await api("state")).body.contacts, []);
  const draft = await directCampaign("0800 000 0000\n+234 800 000 0000\n2348000000000\n002348000000000\n08000000001");
  assert.equal(draft.recipientCount, 2);
  assert.equal(draft.summary.pending, 2);
  assert.equal(draft.mode, "draft");
  const detail = await api(`campaigns/${draft.id}`);
  assert.equal(detail.body.campaign.audienceSource, "direct");
  assert.deepEqual(new Set(detail.body.recipients.map(recipient => recipient.phone)), new Set([phone(0), phone(1)]));
  assert.ok(detail.body.recipients.every(recipient => recipient.name === "Direct number"));
  const saved = database.sqlite.prepare("SELECT audience_source,direct_consent_at FROM campaigns WHERE id = ?").get(draft.id);
  assert.equal(saved.audience_source, "direct");
  assert.ok(Number.isSafeInteger(saved.direct_consent_at) && saved.direct_consent_at > 0);
  assert.ok(database.sqlite.prepare("SELECT contact_id FROM recipients WHERE campaign_id = ?").all(draft.id).every(row => row.contact_id === ""));
  assert.deepEqual((await api("state")).body.contacts, []);
  assert.equal(providerCalls.length, 0, "saving direct numbers must not submit an SMS");
});

test("direct-number campaigns require strict boolean consent before any campaign row is created", async () => {
  for (const consent of [undefined, false, "true", 1, null]) {
    const body = directCampaignBody("08000000000", { directConsent: consent });
    const before = campaignTableCounts();
    const result = await api("campaigns", body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(campaignTableCounts(), before);
  }
  assert.equal(providerCalls.length, 0);
});

test("mixed, empty, malformed, and oversized direct audiences reject atomically without partial campaigns", async () => {
  const [contact] = await contacts(1);
  const bodies = [
    directCampaignBody("08000000001", { contactIds: [contact.id] }),
    directCampaignBody("08000000001", { audienceSource: "contacts", contactIds: [contact.id] }),
    directCampaignBody("08000000001", { audienceSource: undefined, contactIds: [contact.id] }),
    directCampaignBody(""),
    directCampaignBody(" \n\t "),
    directCampaignBody("08000000001\nnot-a-number"),
    directCampaignBody("08000000001\n+447700900123"),
    directCampaignBody(["08000000001"]),
    directCampaignBody(Array.from({ length: 5001 }, (_, index) => phone(index)).join("\n")),
  ];
  for (const body of bodies) {
    const before = campaignTableCounts();
    const result = await api("campaigns", body);
    assert.ok(result.status === 400 || result.status === 413, JSON.stringify(result.body));
    assert.deepEqual(campaignTableCounts(), before, "an invalid direct audience must leave no partial campaign, batch, or recipient rows");
  }
  assert.equal((await api("state")).body.contacts.length, 1);
  assert.equal(providerCalls.length, 0);
});

test("a direct-number preview validates recipients but cannot submit messages", async () => {
  allowLive();
  await settings();
  const preview = await directCampaign(`${phone(0)}\n${phone(1)}`, { mode: "preview" });
  assert.equal(preview.summary.validated, 2);
  assert.equal(preview.summary.pending, 0);
  assert.equal(preview.status, "preview");
  const result = await api(`campaigns/${preview.id}/send`, { confirmed: true });
  assert.equal(result.status, 409);
  assert.equal(providerCalls.length, 0);
  assert.deepEqual((await api("state")).body.contacts, []);
});

test("a confirmed direct campaign submits only typed numbers and receives recipient delivery reports", async () => {
  allowLive();
  await settings();
  // This unrelated saved contact must never be added to the direct audience.
  await api("contacts", { contacts: [{ name: "Not selected", phone: phone(99), consent: true }] });
  const draft = await directCampaign(`${phone(1)}\n${phone(2)}\n${phone(1)}`);
  assert.equal(providerCalls.length, 0);
  for (const confirmed of [undefined, false]) {
    const rejected = await api(`campaigns/${draft.id}/send`, { confirmed });
    assert.equal(rejected.status, 409);
  }
  assert.equal(providerCalls.length, 0);
  const sentPayloads = [];
  mockProvider((url, init) => {
    if (url.pathname === "/api/sms/send/bulk") {
      sentPayloads.push(JSON.parse(init.body));
      return Response.json({ code: "ok", message_id_str: "direct_message_1" });
    }
    assert.equal(url.pathname, "/api/sms/inbox");
    assert.equal(url.searchParams.get("message_id"), "direct_message_1");
    return Response.json([
      { receiver: phone(1).slice(1), message_id: "direct_message_1", status: "Delivered" },
      { receiver: phone(2).slice(1), message_id: "direct_message_1", status: "Message Sent" },
    ]);
  });
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.audienceSource, "direct");
  assert.equal(sent.body.campaign.summary.accepted, 2);
  assert.equal(sent.body.campaign.summary.skipped, 0);
  assert.equal(sent.body.campaign.summary.delivered, 0);
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(new Set(sentPayloads[0].to), new Set([phone(1).slice(1), phone(2).slice(1)]));
  const refreshed = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.campaign.summary.delivered, 1);
  assert.equal(refreshed.body.campaign.summary.accepted, 1);
  assert.equal((await api(`campaigns/${draft.id}`)).body.recipients.length, 2);
  assert.equal((await api("state")).body.contacts.length, 1);
});

test("typing a suppressed or unconsented saved number rejects the whole direct campaign", async () => {
  const audience = await contacts(2);
  await api("contacts", { id: audience[0].id, suppressed: true }, { method: "PATCH" });
  await api("contacts", { id: audience[1].id, consent: false }, { method: "PATCH" });
  for (const blocked of audience) {
    const before = campaignTableCounts();
    const result = await api("campaigns", directCampaignBody(`${blocked.phone}\n${phone(99)}`));
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(campaignTableCounts(), before);
  }
  assert.equal(providerCalls.length, 0);
});

test("direct dispatch rechecks saved contacts matched when the draft was created", async () => {
  allowLive();
  await settings();
  const audience = await contacts(2);
  const unsaved = phone(99);
  const draft = await directCampaign([...audience.map(contact => contact.phone), unsaved].join("\n"));
  const rows = database.sqlite.prepare("SELECT phone,contact_id FROM recipients WHERE campaign_id = ?").all(draft.id);
  for (const contact of audience) assert.equal(rows.find(row => row.phone === contact.phone).contact_id, contact.id);
  assert.equal(rows.find(row => row.phone === unsaved).contact_id, "");
  await api("contacts", { id: audience[0].id, suppressed: true }, { method: "PATCH" });
  await api("contacts", { id: audience[1].id, consent: false }, { method: "PATCH" });
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/sms/send/bulk");
    assert.deepEqual(JSON.parse(init.body).to, [unsaved.slice(1)]);
    return Response.json({ code: "ok", message_id: "direct_filtered" });
  });
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.skipped, 2);
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.equal(providerCalls.length, 1);
});

test("direct dispatch also blocks matching contacts imported after the direct draft", async () => {
  allowLive();
  await settings();
  const numbers = [phone(0), phone(1), phone(2)];
  const draft = await directCampaign(numbers.join("\n"));
  assert.ok(database.sqlite.prepare("SELECT contact_id FROM recipients WHERE campaign_id = ?").all(draft.id).every(row => row.contact_id === ""));
  const imported = await api("contacts", { contacts: [
    { name: "Later suppressed", phone: numbers[0], consent: true },
    { name: "No permission", phone: numbers[1], consent: false },
    { name: "Still eligible", phone: numbers[2], consent: true },
  ] });
  assert.equal(imported.status, 200);
  const current = (await api("state")).body.contacts;
  await api("contacts", { id: current.find(contact => contact.phone === numbers[0]).id, suppressed: true }, { method: "PATCH" });
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/sms/send/bulk");
    assert.deepEqual(JSON.parse(init.body).to, [numbers[2].slice(1)]);
    return Response.json({ code: "ok", message_id: "direct_late_import" });
  });
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.skipped, 2);
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.equal(providerCalls.length, 1);
});

test("another owner's blocked contact cannot change a direct audience or expose its campaign", async () => {
  allowLive();
  await settings();
  const [bob] = await contacts(1, "owner-bob");
  await api("contacts", { id: bob.id, suppressed: true, consent: false }, { method: "PATCH", owner: "owner-bob" });
  const draft = await directCampaign(bob.phone);
  assert.deepEqual((await api("state")).body.contacts, []);
  assert.equal((await api(`campaigns/${draft.id}`, undefined, { owner: "owner-bob" })).status, 404);
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/sms/send/bulk");
    assert.deepEqual(JSON.parse(init.body).to, [bob.phone.slice(1)]);
    return Response.json({ code: "ok", message_id: "direct_owner_scope" });
  });
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.equal(sent.body.campaign.summary.skipped, 0);
  assert.equal((await api("state", undefined, { owner: "owner-bob" })).body.contacts[0].suppressed, true);
  assert.equal(providerCalls.length, 1);
});

test("WhatsApp settings require identity, start at revision zero, and remain owner scoped", async () => {
  const unauthorized = await api("whatsapp/settings", { ...whatsappDefaults, revision: 0 }, { authenticated: false });
  assert.equal(unauthorized.status, 401);
  const initial = await whatsappState();
  assert.equal(initial.revision, 0);
  assert.equal(initial.configured, false);
  assert.equal(initial.liveEnabled, false);
  assert.ok(Array.isArray(initial.readiness) && initial.readiness.length > 0);
  const alice = await saveWhatsApp({ liveEnabled: true });
  assert.equal(alice.revision, 1);
  assert.equal(alice.configured, true);
  assert.equal(alice.liveEnabled, false, "first-time configuration must not also activate sending");
  assert.deepEqual(alice.templateKeys, ["community", "invite_link"]);
  const bobBefore = await whatsappState("owner-bob");
  assert.equal(bobBefore.configured, false);
  assert.equal(bobBefore.revision, 0);
  assert.ok(!JSON.stringify(bobBefore).includes(whatsappDefaults.deviceId));
  const bob = await saveWhatsApp({ owner: "owner-alice", deviceId: "test_whatsapp_device_bob", businessName: "Bob Test Community" }, "owner-bob");
  assert.equal(bob.revision, 1);
  assert.equal(bob.deviceId, "test_whatsapp_device_bob");
  assert.equal((await whatsappState()).deviceId, alice.deviceId);
  assert.equal(providerCalls.length, 0, "saving or reading WhatsApp configuration never sends or verifies remotely");
});

test("stale WhatsApp revisions cannot overwrite configuration or activate live sending", async () => {
  const saved = await saveWhatsApp();
  for (const changes of [{ templateId: "stale_template" }, { liveEnabled: true }]) {
    const result = await api("whatsapp/settings", { ...changes, revision: 0 });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "whatsapp_revision_conflict");
  }
  const current = await whatsappState();
  assert.equal(current.revision, saved.revision);
  assert.equal(current.templateId, saved.templateId);
  assert.equal(current.liveEnabled, false);
  assert.equal(providerCalls.length, 0);
});

test("WhatsApp activation needs a verified shared key and both approvals, independently of SMS activation", async () => {
  let current = await saveWhatsApp({ accountApproved: false, templateApproved: false });
  const beforeConnection = await api("whatsapp/settings", { liveEnabled: true, revision: current.revision });
  assert.equal(beforeConnection.status, 409);
  await saveProvider();
  const beforeCheck = await api("whatsapp/settings", { liveEnabled: true, revision: current.revision });
  assert.equal(beforeCheck.status, 409);
  assert.equal(providerCalls.length, 0);
  mockBalance();
  const verified = await verifyProvider();
  const beforeApproval = await api("whatsapp/settings", { liveEnabled: true, revision: current.revision });
  assert.equal(beforeApproval.status, 409);
  current = await saveWhatsApp({ accountApproved: true, templateApproved: false });
  assert.equal((await api("whatsapp/settings", { liveEnabled: true, revision: current.revision })).status, 409);
  current = await saveWhatsApp({ accountApproved: true, templateApproved: true });
  assert.equal(current.liveEnabled, false);
  const enabled = await enableWhatsApp();
  assert.equal(enabled.providerRevision, verified.credentialRevision);
  const state = await api("state");
  assert.equal(state.body.provider.liveEnabled, false, "SMS live sending remains disabled");
  assert.equal(state.body.settings.senderApproved, false);
  assert.equal(state.body.settings.transactionalEnabled, false);
  assert.equal(state.body.whatsapp.liveEnabled, true);
  assert.equal(providerCalls.length, 1, "activation only requires the earlier read-only balance request");
});

test("changing any WhatsApp account or template identity disables live mode even in a combined enable request", async () => {
  await setupWhatsApp();
  const changes = [
    { deviceId: "replacement_whatsapp_device" },
    { templateId: "replacement_approved_template" },
    { templateBody: "Welcome to {{community}}. Join our updates here: {{invite_link}}" },
    { category: "utility" },
    { businessName: "Replacement Test Community" },
  ];
  for (const change of changes) {
    const previous = await whatsappState();
    assert.equal(previous.liveEnabled, true);
    const result = await api("whatsapp/settings", { ...change, accountApproved: true, templateApproved: true, liveEnabled: true, revision: previous.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.whatsapp.liveEnabled, false, `${Object.keys(change)[0]} changes require a separate activation`);
    assert.equal(result.body.whatsapp.revision, previous.revision + 1);
    await enableWhatsApp();
  }
  assert.equal(providerCalls.length, 1, "reviewing configuration must not dispatch any messages");
});

test("WhatsApp campaign creation requires strict messaging permission and the exact template variables", async () => {
  await saveWhatsApp({ accountApproved: false, templateApproved: false });
  const audience = await contacts(1);
  const invalidBodies = [
    ...[undefined, false, "true", 1, null].map(permission => whatsappCampaignBody(audience, { whatsappPermission: permission })),
    ...[undefined, null, [], {}, { community: "Missing link" }, { ...whatsappData, extra: "Unexpected" }, { ...whatsappData, community: 42 }, { ...whatsappData, community: " " }, { ...whatsappData, community: "{{unresolved}}" }].map(data => whatsappCampaignBody(audience, { whatsappData: data })),
  ];
  for (const body of invalidBodies) {
    const before = campaignTableCounts();
    const result = await api("campaigns", body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(campaignTableCounts(), before, "invalid WhatsApp drafts must leave no partial recipient or batch rows");
  }
  const valid = await whatsappCampaign(audience);
  assert.equal(valid.status, "draft");
  assert.equal(valid.summary.pending, 1);
  assert.equal((await api(`campaigns/${valid.id}/send`, { confirmed: true })).status, 409);
  assert.equal(providerCalls.length, 0, "drafts can be prepared before provider connection but cannot send");
});

test("WhatsApp previews derive text and sender from the saved template, estimate per message, and never send", async () => {
  const referenceBody = `${"Community update. ".repeat(18)}{{community}}: {{invite_link}}`;
  const configured = await setupWhatsApp({ templateBody: referenceBody, ratePerMessage: 12.5 });
  const callsBefore = providerCalls.length;
  const preview = await whatsappCampaign(await contacts(2), { mode: "preview", message: "Untrusted caller text", senderId: "Wrong" });
  assert.equal(preview.message, referenceBody.replace("{{community}}", whatsappData.community).replace("{{invite_link}}", whatsappData.invite_link));
  assert.equal(preview.senderId, configured.businessName);
  assert.equal(preview.segments, 1, "WhatsApp pricing must not use GSM SMS segment counts");
  assert.equal(preview.estimatedCost, 25);
  assert.equal(preview.summary.validated, 2);
  assert.equal(preview.status, "preview");
  assert.equal(preview.whatsapp.deviceId, configured.deviceId);
  assert.equal(preview.whatsapp.templateId, configured.templateId);
  assert.equal(preview.whatsapp.templateBody, referenceBody);
  assert.equal(preview.whatsapp.category, "marketing");
  assert.equal(preview.whatsapp.businessName, configured.businessName);
  assert.deepEqual(preview.whatsapp.data, whatsappData);
  const blocked = await api(`campaigns/${preview.id}/send`, { confirmed: true });
  assert.equal(blocked.status, 409);
  assert.equal(providerCalls.length, callsBefore);
  assertNoCredentials((await api(`campaigns/${preview.id}`)).body);
});

test("unknown and zero WhatsApp rates remain distinct from SMS segment pricing", async () => {
  await settings();
  const audience = await contacts(2);
  await saveWhatsApp({ ratePerMessage: null });
  const unknown = await whatsappCampaign(audience);
  assert.equal(unknown.estimatedCost, null);
  assert.equal(unknown.segments, 1);
  await saveWhatsApp({ ratePerMessage: 0 });
  const zero = await whatsappCampaign(audience);
  assert.equal(zero.estimatedCost, 0);
  assert.equal(zero.segments, 1);
  const current = await whatsappState();
  const invalid = await api("whatsapp/settings", { ratePerMessage: -1, revision: current.revision });
  assert.equal(invalid.status, 400);
  assert.equal(providerCalls.length, 0);
});

test("six WhatsApp recipients send as five plus one with individual IDs and without requiring SMS sender approval", async () => {
  const configured = await setupWhatsApp();
  const audience = await contacts(6);
  const draft = await whatsappCampaign(audience);
  const callsBefore = providerCalls.length;
  for (const confirmed of [undefined, false, "true"]) {
    assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed })).status, 409);
  }
  assert.equal(providerCalls.length, callsBefore);
  const payloads = mockWhatsAppSends();
  const first = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.remaining, 1);
  assert.equal(first.body.campaign.summary.accepted, 5);
  assert.equal(first.body.campaign.summary.delivered, 0);
  assert.equal(payloads.length, 5);
  const second = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.remaining, 0);
  assert.equal(second.body.campaign.summary.accepted, 6);
  assert.equal(second.body.campaign.status, "submitted");
  assert.equal(payloads.length, 6);
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(payloads.length, 6, "completed WhatsApp recipients must never be billed again on replay");
  assert.deepEqual(new Set(payloads.map(payload => payload.phone_number)), new Set(audience.map(contact => contact.phone.slice(1))));
  for (const payload of payloads) {
    assert.deepEqual(Object.keys(payload).sort(), ["api_key", "data", "device_id", "phone_number", "template_id"]);
    assert.equal(payload.api_key, ownedApiKey);
    assert.equal(payload.device_id, configured.deviceId);
    assert.equal(payload.template_id, configured.templateId);
    assert.deepEqual(payload.data, whatsappData);
  }
  const persisted = database.sqlite.prepare("SELECT phone,provider_id,status FROM recipients WHERE campaign_id = ?").all(draft.id);
  assert.equal(new Set(persisted.map(row => row.provider_id)).size, 6);
  payloads.forEach((payload, index) => {
    const row = persisted.find(recipient => recipient.phone === `+${payload.phone_number}`);
    assert.equal(row.provider_id, `whatsapp_message_${index + 1}`);
    assert.equal(row.status, "accepted");
  });
  const state = await api("state");
  assert.equal(state.body.provider.liveEnabled, false);
  assert.equal(state.body.settings.senderApproved, false);
});

test("concurrent WhatsApp send requests cannot submit the same five recipients twice", async () => {
  await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(6));
  let enterProvider;
  let releaseProvider;
  const entered = new Promise(resolve => { enterProvider = resolve; });
  const gate = new Promise(resolve => { releaseProvider = resolve; });
  const payloads = mockWhatsAppSends(async (_payload, index) => {
    enterProvider();
    await gate;
    return Response.json({ code: "ok", message_id_str: `concurrent_whatsapp_${index}` });
  });
  const first = api(`campaigns/${draft.id}/send`, { confirmed: true });
  const second = api(`campaigns/${draft.id}/send`, { confirmed: true });
  await entered;
  const paused = await Promise.race([first, second]);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.halted, true);
  assert.ok(payloads.length >= 1 && payloads.length <= 5);
  releaseProvider();
  await Promise.all([first, second]);
  assert.equal(payloads.length, 5);
  assert.equal((await api(`campaigns/${draft.id}`)).body.campaign.summary.accepted, 5);
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(payloads.length, 6);
  assert.equal(new Set(payloads.map(payload => payload.phone_number)).size, 6);
});

test("mixed WhatsApp outcomes preserve recipient IDs and halt later batches without retries or SMS fallback", async () => {
  await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(6));
  const payloads = mockWhatsAppSends((_payload, index) => {
    if (index === 2) throw new Error(`Uncertain network error containing ${ownedApiKey}`);
    if (index === 3) return Response.json({ secret: "provider error body", api_key: ownedApiKey }, { status: 403 });
    return Response.json({ code: "ok", message_id_str: `partial_whatsapp_${index}` });
  });
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.halted, true);
  assert.equal(result.body.campaign.status, "attention");
  assert.equal(result.body.remaining, 1);
  assert.equal(result.body.campaign.summary.accepted, 3);
  assert.equal(result.body.campaign.summary.unknown, 1);
  assert.equal(result.body.campaign.summary.failed, 1);
  assert.equal(result.body.campaign.summary.pending, 1);
  assert.equal(payloads.length, 5, "only the current five-recipient batch may be in flight");
  assertNoCredentials(result.body);
  const detail = await api(`campaigns/${draft.id}`);
  assertNoCredentials(detail.body);
  assert.ok(!JSON.stringify(detail.body).includes("provider error body"));
  const rows = database.sqlite.prepare("SELECT phone,status,provider_id FROM recipients WHERE campaign_id = ?").all(draft.id);
  payloads.forEach((payload, index) => {
    const row = rows.find(recipient => recipient.phone === `+${payload.phone_number}`);
    assert.equal(row.status, index === 1 ? "unknown" : index === 2 ? "failed" : "accepted");
    if (row.status === "accepted") assert.equal(row.provider_id, `partial_whatsapp_${index + 1}`);
  });
  const replay = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(replay.body.halted, true);
  assert.equal(replay.body.remaining, 1);
  assert.equal(payloads.length, 5);
});

test("WhatsApp dispatch rechecks saved-contact suppression and withdrawn permission", async () => {
  await setupWhatsApp();
  const audience = await contacts(3);
  const draft = await whatsappCampaign(audience);
  await api("contacts", { id: audience[0].id, suppressed: true }, { method: "PATCH" });
  await api("contacts", { id: audience[1].id, consent: false }, { method: "PATCH" });
  const payloads = mockWhatsAppSends();
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.skipped, 2);
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.deepEqual(payloads.map(payload => payload.phone_number), [audience[2].phone.slice(1)]);
});

test("WhatsApp direct audiences need both permissions, keep the address book unchanged, and honor late suppression", async () => {
  await setupWhatsApp();
  const directBody = whatsappCampaignBody([], {
    audienceSource: "direct",
    contactIds: undefined,
    directNumbers: `${phone(0)}\n${phone(1)}\n${phone(0)}`,
    directConsent: true,
  });
  for (const missingPermission of [{ directConsent: false }, { whatsappPermission: false }]) {
    const before = campaignTableCounts();
    assert.equal((await api("campaigns", { ...directBody, ...missingPermission })).status, 400);
    assert.deepEqual(campaignTableCounts(), before);
  }
  const created = await api("campaigns", directBody);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const draft = created.body.campaign;
  assert.equal(draft.audienceSource, "direct");
  assert.equal(draft.recipientCount, 2);
  assert.deepEqual((await api("state")).body.contacts, []);
  await api("contacts", { contacts: [{ name: "Opted out after drafting", phone: phone(0), consent: false }] });
  const payloads = mockWhatsAppSends();
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.skipped, 1);
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.deepEqual(payloads.map(payload => payload.phone_number), [phone(1).slice(1)]);
});

test("changing shared provider credentials gates WhatsApp until the replacement is checked and separately reenabled", async () => {
  await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(1));
  const provider = await providerState();
  const changed = await api("provider/settings", { apiKey: replacementApiKey, revision: provider.revision });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await whatsappState()).liveEnabled, false);
  const callsBefore = providerCalls.length;
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).status, 409);
  const current = await whatsappState();
  assert.equal((await api("whatsapp/settings", { liveEnabled: true, revision: current.revision })).status, 409);
  assert.equal(providerCalls.length, callsBefore);
  mockBalance(replacementApiKey);
  const verified = await verifyProvider();
  assert.equal((await whatsappState()).liveEnabled, false, "checking a different credential does not silently reactivate WhatsApp");
  const enabled = await enableWhatsApp();
  assert.equal(enabled.providerRevision, verified.credentialRevision);
  const payloads = mockWhatsAppSends();
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].api_key, replacementApiKey);
  assertNoCredentials(sent.body);
});

test("a changed WhatsApp template cannot send a stale campaign and does not rewrite its snapshot", async () => {
  await setupWhatsApp();
  const audience = await contacts(1);
  const draft = await whatsappCampaign(audience);
  const originalSnapshot = structuredClone(draft.whatsapp);
  const originalMessage = draft.message;
  const previous = await whatsappState();
  const updatedBody = "An updated invitation from {{community}}: {{invite_link}}";
  const changed = await api("whatsapp/settings", { templateId: "new_template", templateBody: updatedBody, templateApproved: true, revision: previous.revision });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await enableWhatsApp();
  const callsBefore = providerCalls.length;
  const blocked = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(blocked.status, 409);
  assert.equal(providerCalls.length, callsBefore);
  const detail = await api(`campaigns/${draft.id}`);
  assert.equal(detail.body.campaign.message, originalMessage);
  assert.deepEqual(detail.body.campaign.whatsapp, originalSnapshot);
  assert.equal(detail.body.campaign.summary.pending, 1);
  const newDraft = await whatsappCampaign(audience);
  const payloads = mockWhatsAppSends();
  assert.equal((await api(`campaigns/${newDraft.id}/send`, { confirmed: true })).status, 200);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].template_id, "new_template");
});

test("WhatsApp delivery refresh uses individual provider IDs and exact recipient matching without treating sent as delivered", async () => {
  await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(2));
  const payloads = mockWhatsAppSends();
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(payloads.length, 2);
  const queriedIds = [];
  let secondPass = false;
  mockProvider(url => {
    assert.equal(url.pathname, "/api/sms/inbox", "refresh must use only the documented read-only report endpoint");
    assert.equal(url.searchParams.get("api_key"), ownedApiKey);
    const providerId = url.searchParams.get("message_id");
    queriedIds.push(providerId);
    const index = providerId === "whatsapp_message_1" ? 0 : providerId === "whatsapp_message_2" ? 1 : -1;
    assert.notEqual(index, -1, "reports must be scoped to an actual recipient's returned provider ID");
    return Response.json([
      { receiver: payloads[index].phone_number, message_id: providerId, status: index === 0 ? secondPass ? "Message Failed" : "Delivered" : "Message Sent" },
      { receiver: payloads[1 - index].phone_number, message_id: providerId, status: "Delivered" },
      { receiver: payloads[index].phone_number, message_id: "unrelated_provider_id", status: "Delivered" },
    ]);
  });
  const refreshed = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(new Set(queriedIds), new Set(["whatsapp_message_1", "whatsapp_message_2"]));
  assert.equal(refreshed.body.campaign.summary.delivered, 1);
  assert.equal(refreshed.body.campaign.summary.accepted, 1);
  secondPass = true;
  const again = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(again.body.campaign.summary.delivered, 1, "a late failed report must not regress confirmed delivery");
  assert.equal(again.body.campaign.summary.accepted, 1);
  assert.equal(again.body.campaign.summary.failed, 0);
});

test("another owner cannot dispatch, refresh, or inspect a WhatsApp campaign or its saved template", async () => {
  await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(1));
  const callsBefore = providerCalls.length;
  assert.equal((await api(`campaigns/${draft.id}`, undefined, { owner: "owner-bob" })).status, 404);
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true }, { owner: "owner-bob" })).status, 404);
  assert.equal((await api(`campaigns/${draft.id}/refresh`, { cursor: 0 }, { owner: "owner-bob" })).status, 404);
  const bob = await api("state", undefined, { owner: "owner-bob" });
  assert.deepEqual(bob.body.campaigns, []);
  assert.equal(bob.body.whatsapp.configured, false);
  assert.ok(!JSON.stringify(bob.body).includes(whatsappDefaults.templateId));
  assert.equal(providerCalls.length, callsBefore);
});

test("SMS-only live toggles preserve an activated WhatsApp connection and its credential binding", async () => {
  const activated = await setupWhatsApp();
  const draft = await whatsappCampaign(await contacts(1));
  const originalProvider = await providerState();
  assert.ok(Number.isSafeInteger(originalProvider.credentialRevision));
  assert.equal(activated.providerRevision, originalProvider.credentialRevision);
  await settings({ senderApproved: true });
  assert.equal((await whatsappState()).liveEnabled, true);
  const enabled = await api("provider/settings", { liveEnabled: true, revision: originalProvider.revision });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.provider.liveEnabled, true);
  assert.ok(enabled.body.provider.revision > originalProvider.revision);
  assert.equal(enabled.body.provider.credentialRevision, originalProvider.credentialRevision);
  assert.equal((await whatsappState()).liveEnabled, true, "enabling SMS must not deactivate approved WhatsApp sending");
  const disabled = await api("provider/settings", { liveEnabled: false, revision: enabled.body.provider.revision });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.provider.liveEnabled, false);
  assert.ok(disabled.body.provider.revision > enabled.body.provider.revision);
  assert.equal(disabled.body.provider.credentialRevision, originalProvider.credentialRevision);
  const current = await whatsappState();
  assert.equal(current.liveEnabled, true, "disabling SMS must leave WhatsApp active under the same verified credentials");
  assert.equal(current.providerRevision, activated.providerRevision);
  assert.equal(providerCalls.length, 1, "SMS live toggles must not make provider requests");
  const payloads = mockWhatsAppSends();
  const sent = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.campaign.summary.accepted, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].api_key, ownedApiKey);
  assert.equal((await providerState()).liveEnabled, false);
});

test("a 5,000-number WhatsApp preview persists the complete deduplicated audience without provider calls", async () => {
  await saveWhatsApp({ accountApproved: false, templateApproved: false });
  const numbers = Array.from({ length: 5000 }, (_, index) => phone(index));
  const queriesBeforeCreation = database.queryCount;
  const preview = await whatsappCampaign([], {
    mode: "preview",
    audienceSource: "direct",
    contactIds: undefined,
    directNumbers: numbers.join("\n"),
    directConsent: true,
  });
  const creationQueries = database.queryCount - queriesBeforeCreation;
  assert.ok(creationQueries <= 50, `large campaign creation must fit the D1 Free per-request limit; used ${creationQueries} statements`);
  assert.equal(preview.status, "preview");
  assert.equal(preview.recipientCount, 5000);
  assert.equal(preview.summary.validated, 5000);
  assert.equal(preview.summary.pending, 0);
  const detail = await api(`campaigns/${preview.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.recipients.length, 5000);
  assert.deepEqual(new Set(detail.body.recipients.map(recipient => recipient.phone)), new Set(numbers));
  assert.ok(detail.body.recipients.every(recipient => recipient.status === "validated"));
  assert.equal(detail.body.batches.length, 1000);
  assert.ok(detail.body.batches.every(batch => batch.status === "validated"));
  assert.deepEqual((await api("state")).body.contacts, []);
  assert.equal(providerCalls.length, 0);
});

function senderListResponse(content = [], overrides = {}) {
  return Response.json({ content, totalElements: content.length, totalPages: 1, number: 0, last: true, numberOfElements: content.length, size: 15, ...overrides });
}
const activeSender = { sender_id: "Trezad", country: "Nigeria", status: "active", createdAt: "2026-10-22 10:00:00" };
const senderRequestBody = revision => ({ senderId: "TrezadNew", company: "Trezad Community", useCase: "Invitation to our community updates and events.", credentialRevision: revision });
function mockSenderList(content = [activeSender]) {
  mockProvider(url => {
    assert.equal(url.pathname, "/api/sender-id");
    assert.equal(url.searchParams.get("api_key"), ownedApiKey);
    return senderListResponse(content);
  });
}

test("dashboard balance is a private read and does not verify or activate the connection", async () => {
  const saved = await saveProvider();
  mockProvider(url => {
    assert.equal(url.pathname, "/api/get-balance");
    assert.equal(url.searchParams.get("api_key"), ownedApiKey);
    return Response.json({ balance: 0, currency: "NGN", user: "provider-private-user" });
  });
  const before = campaignTableCounts();
  const result = await api("provider/balance");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.balance, 0, "a real zero balance is not a missing balance");
  assert.equal(result.body.currency, "NGN");
  assert.equal(result.body.credentialRevision, saved.credentialRevision);
  assert.ok(result.body.fetchedAt > 0);
  assertNoCredentials(result.body, "provider-private-user");
  assert.deepEqual(campaignTableCounts(), before);
  const after = await providerState();
  assert.ok(!after.verifiedAt);
  assert.equal(after.liveEnabled, false);
  assert.equal(after.revision, saved.revision);
  const unauthenticated = await api("provider/balance", undefined, { authenticated: false });
  assert.equal(unauthenticated.status, 401);
  assert.equal(providerCalls.length, 1);
});

for (const endpoint of ["provider/balance", "provider/sender-ids"]) {
  test(`${endpoint} discards a response from credentials replaced while the read was in flight`, async () => {
    const saved = await saveProvider();
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    mockProvider(async () => {
      entered(); await gate;
      return endpoint.endsWith("balance") ? Response.json({ balance: 15, currency: "NGN" }) : senderListResponse([activeSender]);
    });
    const reading = api(endpoint);
    await started;
    assert.equal((await api("provider/settings", { apiKey: replacementApiKey, revision: saved.revision })).status, 200);
    release();
    const result = await reading;
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "provider_revision_conflict");
    assertNoCredentials(result.body);
    assert.equal(result.body.balance, undefined);
    assert.equal(result.body.senderIds, undefined);
  });
}

test("sender list preserves approval states and incomplete coverage without exposing provider account details", async () => {
  const saved = await saveProvider();
  mockProvider(url => {
    assert.equal(url.pathname, "/api/sender-id");
    return senderListResponse([
      { ...activeSender, company: "private-provider-company", usecase: "private-provider-usecase" },
      { ...activeSender, sender_id: "Pending", status: "pending" },
      { ...activeSender, sender_id: "Blocked", status: "blocked" },
      { ...activeSender, sender_id: "Foreign", country: "Ghana" },
      { ...activeSender, sender_id: "Unknown", status: "approved" },
    ], { totalElements: 20, totalPages: 2, last: false });
  });
  const result = await api("provider/sender-ids");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.senderIds.map(row => row.status), ["active", "pending", "blocked", "active", "unknown"]);
  assert.equal(result.body.complete, false);
  assert.equal(result.body.total, 20);
  assert.equal(result.body.credentialRevision, saved.credentialRevision);
  assert.deepEqual(result.body.requests, []);
  assertNoCredentials(result.body, "private-provider-company", "private-provider-usecase");
  assert.equal((await api("state")).body.settings.senderApproved, false);
});

test("selecting an active Nigerian sender verifies it on the server without enabling SMS or DND", async () => {
  await settings({ senderApproved: false, transactionalEnabled: false });
  const saved = await saveProvider();
  mockSenderList();
  const selected = await api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: saved.credentialRevision });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.settings.senderApproved, true);
  assert.equal(selected.body.settings.senderApprovalSource, "termii");
  assert.ok(selected.body.settings.senderVerifiedAt);
  assert.equal(selected.body.settings.ratePerSegment, 6.5);
  assert.equal(selected.body.settings.transactionalEnabled, false);
  assert.equal(selected.body.provider.liveEnabled, false);
  assert.ok(!selected.body.provider.verifiedAt);
  assert.equal(providerCalls.length, 1, "selection must freshly check the account's sender IDs");
  assert.deepEqual(campaignTableCounts(), { campaigns: 0, batches: 0, recipients: 0 });
  // Saving an estimate must preserve the source of a genuine provider approval.
  const priced = await api("settings", { ratePerSegment: 7.5 });
  assert.equal(priced.body.senderApprovalSource, "termii");
  assert.equal(priced.body.senderVerifiedAt, selected.body.settings.senderVerifiedAt);
  assert.equal((await api("provider/settings", { apiKey: replacementApiKey, revision: saved.revision })).status, 200);
  const current = (await api("state")).body.settings;
  assert.equal(current.senderApproved, false, "a replacement account cannot inherit this approval");
  assert.equal(current.senderApprovalSource, null);
});

for (const record of [
  { ...activeSender, status: "pending" }, { ...activeSender, status: "blocked" },
  { ...activeSender, status: "approved" }, { ...activeSender, country: "Ghana" },
]) {
  test(`sender selection rejects ${record.status} / ${record.country} and ignores forged approval fields`, async () => {
    const saved = await saveProvider();
    mockSenderList([record]);
    const result = await api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: saved.credentialRevision, status: "active", senderApproved: true });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "sender_not_active");
    assert.equal((await api("state")).body.settings.senderApproved, false);
  });
}

test("an in-flight sender selection cannot verify a replacement account", async () => {
  const saved = await saveProvider();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  mockProvider(async () => { entered(); await gate; return senderListResponse([activeSender]); });
  const selecting = api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: saved.credentialRevision });
  await started;
  await api("provider/settings", { apiKey: replacementApiKey, revision: saved.revision });
  release();
  assert.equal((await selecting).status, 409);
  assert.equal((await api("state")).body.settings.senderApproved, false);
});

test("a sender request submits the documented payload and remains pending without changing message settings", async () => {
  const saved = await saveProvider();
  const input = senderRequestBody(saved.credentialRevision);
  mockProvider((url, init) => {
    if (url.pathname === "/api/sender-id") return senderListResponse();
    assert.equal(url.pathname, "/api/sender-id/request");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { api_key: ownedApiKey, sender_id: input.senderId, company: input.company, use_case: input.useCase });
    return Response.json({ code: "ok", message: `private-provider-response-${ownedApiKey}` });
  });
  const result = await api("provider/sender-ids/request", input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.submitted, true);
  assert.equal(result.body.status, "pending");
  assert.equal(result.body.senderId, input.senderId);
  assert.equal(result.body.connectionChanged, false);
  assertNoCredentials(result.body);
  assert.equal((await api("state")).body.settings.senderApproved, false);
  assert.equal((await providerState()).liveEnabled, false);
  assert.deepEqual(campaignTableCounts(), { campaigns: 0, batches: 0, recipients: 0 });
  const repeated = await api("provider/sender-ids/request", input);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.code, "sender_request_exists");
  assert.equal(providerCalls.length, 2, "one listing plus one submission; no duplicate POST");
  mockSenderList([]);
  const listed = await api("provider/sender-ids");
  assert.deepEqual(listed.body.requests.map(row => [row.senderId, row.status]), [[input.senderId, "pending"]]);
});

test("concurrent sender approval requests submit to Termii at most once", async () => {
  const saved = await saveProvider();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  mockProvider(async url => {
    if (url.pathname === "/api/sender-id") return senderListResponse();
    assert.equal(url.pathname, "/api/sender-id/request");
    entered(); await gate;
    return Response.json({ code: "ok" });
  });
  const first = api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision));
  await started;
  const second = await api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision));
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 201);
  assert.equal(providerCalls.filter(call => call.url.pathname.endsWith("/request")).length, 1);
});

test("uncertain sender submissions stay recorded and are not retried or exposed as approved", async () => {
  const saved = await saveProvider();
  mockProvider(url => {
    if (url.pathname === "/api/sender-id") return senderListResponse();
    throw new TypeError(`private upstream transport ${ownedApiKey}`);
  });
  const result = await api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision));
  assert.equal(result.status, 502);
  assert.equal(result.body.outcome, "unknown");
  assert.equal(result.body.code, "provider_sender_id_request_network_error");
  assertNoCredentials(result.body);
  assert.equal(database.sqlite.prepare("SELECT status FROM sender_id_requests").get().status, "unknown");
  assert.equal((await api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision))).status, 409);
  assert.equal(providerCalls.length, 2);
  assert.equal((await api("state")).body.settings.senderApproved, false);
});

test("a rejected sender request permits a new explicit submission but never an automatic retry", async () => {
  const saved = await saveProvider();
  let requests = 0;
  mockProvider(url => {
    if (url.pathname === "/api/sender-id") return senderListResponse();
    requests += 1;
    return requests === 1 ? Response.json({ error: "rejected" }, { status: 422 }) : Response.json({ code: "ok" });
  });
  assert.equal((await api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision))).body.outcome, "rejected");
  assert.equal(requests, 1);
  assert.equal((await api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision))).status, 201);
  assert.equal(requests, 2);
});

test("invalid or already registered sender requests do not submit or reserve an invalid ID", async () => {
  const saved = await saveProvider();
  assert.equal((await api("provider/sender-ids/request", { ...senderRequestBody(saved.credentialRevision), useCase: "" })).status, 400);
  assert.equal(providerCalls.length, 0);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM sender_id_requests").get().count, 0);
  mockSenderList([activeSender]);
  const registered = await api("provider/sender-ids/request", { ...senderRequestBody(saved.credentialRevision), senderId: "Trezad" });
  assert.equal(registered.status, 409);
  assert.equal(registered.body.code, "sender_already_registered");
  assert.equal(providerCalls.length, 1);
});

test("sender requests, selections, lists and balances remain isolated by authenticated owner", async () => {
  const alice = await saveProvider();
  const bob = await saveProvider({ apiKey: replacementApiKey }, "owner-bob");
  mockProvider((url, init) => {
    if (url.pathname === "/api/sender-id/request") return Response.json({ code: "ok" });
    const expected = providerCalls.length === 1 ? ownedApiKey : replacementApiKey;
    assert.equal(url.searchParams.get("api_key"), expected);
    return url.pathname.endsWith("get-balance") ? Response.json({ balance: 99, currency: "NGN" }) : senderListResponse();
  });
  assert.equal((await api("provider/sender-ids/request", senderRequestBody(alice.credentialRevision))).status, 201);
  const bobList = await api("provider/sender-ids", undefined, { owner: "owner-bob" });
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.body.requests, []);
  const bobBalance = await api("provider/balance", undefined, { owner: "owner-bob" });
  assert.equal(bobBalance.body.balance, 99);
  for (const [path, body] of [["provider/sender-ids", undefined], ["provider/sender-ids/select", { senderId: "Trezad", credentialRevision: bob.credentialRevision }], ["provider/sender-ids/request", senderRequestBody(bob.credentialRevision)]]) {
    assert.equal((await api(path, body, { authenticated: false })).status, 401);
  }
  assert.equal(providerCalls.length, 4);
});

for (const change of ["blocked", "pending", "unknown", "complete absence", "partial absence"]) {
  test(`a ${change} sender refresh reconciles only evidenced revocation`, async () => {
    const saved = await saveProvider();
    mockSenderList();
    assert.equal((await api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: saved.credentialRevision })).status, 200);
    mockBalance();
    const verified = await verifyProvider();
    assert.equal((await api("provider/settings", { liveEnabled: true, revision: verified.revision })).status, 200);
    mockProvider(() => change.includes("absence")
      ? senderListResponse([], change === "partial absence" ? { totalElements: 30, totalPages: 2, last: false } : {})
      : senderListResponse([{ ...activeSender, status: change }]));
    const refreshed = await api("provider/sender-ids");
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const shouldRevoke = change !== "partial absence";
    assert.equal(refreshed.body.senderApprovalRevoked, shouldRevoke);
    const current = (await api("state")).body;
    assert.equal(current.settings.senderApproved, !shouldRevoke);
    assert.equal(current.provider.liveEnabled, !shouldRevoke);
    // Seeing an active record later does not silently reenable a revoked sender.
    mockSenderList();
    await api("provider/sender-ids");
    assert.equal((await api("state")).body.settings.senderApproved, !shouldRevoke);
  });
}

test("a key replacement after verification cannot relabel an old balance as the new account", async () => {
  await saveProvider();
  mockBalance();
  const prepare = database.prepare.bind(database);
  database.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE provider_settings SET verified_at")) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...bindings) => {
        const bound = bind(...bindings), run = bound.run.bind(bound);
        bound.run = async () => {
          const result = await run();
          // Simulate the credential replacement's committed write between the
          // verification CAS and the final provider-state read.
          database.sqlite.prepare("UPDATE provider_settings SET credential_revision = credential_revision + 1,revision = revision + 1,verified_at = NULL WHERE owner = ?").run("owner-alice");
          return result;
        };
        return bound;
      };
    }
    return statement;
  };
  const result = await api("provider/check", {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "provider_revision_conflict");
  assert.equal(result.body.balance, undefined);
});

test("a registration acknowledged after an account change is recorded only for the original connection", async () => {
  const saved = await saveProvider();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  mockProvider(async url => {
    if (url.pathname === "/api/sender-id") return senderListResponse();
    entered(); await gate;
    return Response.json({ code: "ok" });
  });
  const submitting = api("provider/sender-ids/request", senderRequestBody(saved.credentialRevision));
  await started;
  await api("provider/settings", { apiKey: replacementApiKey, revision: saved.revision });
  release();
  const result = await submitting;
  assert.equal(result.status, 201);
  assert.equal(result.body.connectionChanged, true);
  assert.equal(result.body.credentialRevision, saved.credentialRevision);
  mockProvider(() => senderListResponse());
  assert.deepEqual((await api("provider/sender-ids")).body.requests, []);
  assert.equal((await api("state")).body.settings.senderApproved, false);
});

// Multi-provider integration tests exercise the actual owner-scoped API and
// SQLite migrations. Every external provider response below is a local mock.
const multiTokens = {
  bulksmsnigeria: "fixture-bsng-api-token-never-used-on-network",
  smartsmssolutions: "fixture-smart-api-token-never-used-on-network",
  sendchamp: "fixture-sendchamp-api-token-never-used-on-network",
};
const multiOrigins = {
  bulksmsnigeria: "https://www.bulksmsnigeria.com",
  smartsmssolutions: "https://app.smartsmssolutions.com",
  sendchamp: "https://api.sendchamp.com",
};
async function multiDirectory(owner = "owner-alice") {
  const result = await api("sms/providers", undefined, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertNoCredentials(result.body, ...Object.values(multiTokens));
  return result.body;
}
async function saveMultiProvider(id, overrides = {}, owner = "owner-alice") {
  const current = (await multiDirectory(owner)).smsProviders.find(provider => provider.id === id);
  const result = await api(`sms/providers/${id}/settings`, {
    revision: current.revision,
    credentials: { apiToken: multiTokens[id] },
    senderId: "Trezad", senderApproved: true, ratePerSegment: 6.5,
    ...overrides,
  }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertNoCredentials(result.body, ...Object.values(multiTokens), ...Object.values(overrides.credentials || {}).filter(Boolean));
  return result.body.provider;
}
function mockMultiBalance(id, expectedToken = multiTokens[id]) {
  mockProvider((url, init) => {
    if (id === "bulksmsnigeria") {
      assert.equal(url.pathname, "/api/v2/balance");
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${expectedToken}`);
      return Response.json({ data: { status: "success" }, balance: { total_balance: 2500.75 } });
    }
    if (id === "smartsmssolutions") {
      assert.equal(url.pathname, "/io/api/client/v1/balance/");
      assert.equal(url.searchParams.get("token"), expectedToken);
      return Response.json(820.25);
    }
    assert.equal(id, "sendchamp");
    assert.equal(url.pathname, "/api/v1/wallet/wallet_balance");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${expectedToken}`);
    return Response.json({ status: "success", code: "200", data: { available_balance: "12.45", currency: "USD" } });
  }, multiOrigins[id]);
}
async function checkMultiProvider(id, owner = "owner-alice", expectedToken = multiTokens[id]) {
  const current = (await multiDirectory(owner)).smsProviders.find(provider => provider.id === id);
  mockMultiBalance(id, expectedToken);
  const result = await api(`sms/providers/${id}/check`, { credentialRevision: current.credentialRevision }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.connected, true);
  assert.ok(result.body.provider.verifiedAt);
  return result.body.provider;
}
async function activateMultiProvider(id, owner = "owner-alice") {
  const current = await multiDirectory(owner);
  const provider = current.smsProviders.find(provider => provider.id === id);
  const result = await api("sms/providers/active", { providerId: id, routingRevision: current.smsRoutingRevision, credentialRevision: provider?.credentialRevision }, { owner });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.activeSmsProviderId, id);
  assert.equal(result.body.smsProviders.filter(provider => provider.isActive).length, id ? 1 : 0);
  return result.body;
}
async function setupMultiProvider(id, { owner = "owner-alice", activate = true } = {}) {
  await saveMultiProvider(id, {}, owner);
  await checkMultiProvider(id, owner);
  return activate ? activateMultiProvider(id, owner) : multiDirectory(owner);
}
async function multiCampaign(numbers, overrides = {}, owner = "owner-alice") {
  const directory = await multiDirectory(owner);
  const provider = directory.smsProviders.find(provider => provider.id === directory.activeSmsProviderId);
  assert.ok(provider);
  const result = await api("campaigns", directCampaignBody(numbers.join("\n"), {
    channel: "generic", senderId: provider.senderId, smsProviderId: provider.id,
    smsCredentialRevision: provider.credentialRevision, ...overrides,
  }), { owner });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.campaign.smsProviderId, provider.id);
  assert.equal(result.body.campaign.smsCredentialRevision, provider.credentialRevision);
  return result.body.campaign;
}
function mockBsngSubmissions(handler = (_payload, index) => ({})) {
  const payloads = [];
  mockProvider((url, init) => {
    assert.equal(url.pathname, "/api/v2/sms");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${multiTokens.bulksmsnigeria}`);
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    const replacement = handler(payload, payloads.length);
    return replacement instanceof Response ? replacement : Response.json({ status: "success", code: "BSNG-0000", data: {
      message_id: `bsng-submission-${payloads.length}`, recipients_count: payload.to.split(",").length,
      gateway_used: "direct-refund", ...replacement,
    } });
  }, multiOrigins.bulksmsnigeria);
  return payloads;
}

test("multi-provider credentials are encrypted, owner scoped, and absent from public responses", async () => {
  const saved = await saveMultiProvider("bulksmsnigeria");
  const row = database.sqlite.prepare("SELECT * FROM sms_provider_accounts WHERE owner=? AND provider=?").get("owner-alice", "bulksmsnigeria");
  assert.match(row.credentials_ciphertext, /^v1:/);
  assert.ok(!JSON.stringify(row).includes(multiTokens.bulksmsnigeria));
  assert.equal(saved.credentialsConfigured.apiToken, true);
  assert.deepEqual(saved.publicValues, {});
  const bob = await multiDirectory("owner-bob");
  assert.ok(bob.smsProviders.every(provider => !provider.configured));
  assert.equal(bob.activeSmsProviderId, null);
  const denied = await api("sms/providers/bulksmsnigeria/balance", undefined, { owner: "owner-bob" });
  assert.equal(denied.status, 409);
  for (const [path, body] of [
    ["sms/providers", undefined], ["sms/providers/bulksmsnigeria/balance", undefined],
    ["sms/providers/bulksmsnigeria/settings", { revision: 0 }],
    ["sms/providers/active", { providerId: "bulksmsnigeria", routingRevision: 0, credentialRevision: 1 }],
  ]) assert.equal((await api(path, body, { authenticated: false })).status, 401);
  assert.equal(providerCalls.length, 0);
});

test("copying encrypted credentials between owners fails closed before any provider request", async () => {
  await saveMultiProvider("bulksmsnigeria");
  await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: "fixture-bob-secret-for-isolation" } }, "owner-bob");
  const alice = database.sqlite.prepare("SELECT credentials_ciphertext FROM sms_provider_accounts WHERE owner=? AND provider=?").get("owner-alice", "bulksmsnigeria");
  database.sqlite.prepare("UPDATE sms_provider_accounts SET credentials_ciphertext=? WHERE owner=? AND provider=?").run(alice.credentials_ciphertext, "owner-bob", "bulksmsnigeria");
  const result = await api("sms/providers/bulksmsnigeria/balance", undefined, { owner: "owner-bob" });
  assert.equal(result.status, 409);
  assertNoCredentials(result.body, ...Object.values(multiTokens));
  assert.equal(providerCalls.length, 0);
});

test("blank credentials preserve the verified account while replacement clears approval and active routing", async () => {
  await setupMultiProvider("bulksmsnigeria");
  providerCalls = [];
  const before = (await multiDirectory()).smsProviders.find(provider => provider.id === "bulksmsnigeria");
  const beforeRow = database.sqlite.prepare("SELECT credentials_ciphertext FROM sms_provider_accounts WHERE owner=? AND provider=?").get("owner-alice", "bulksmsnigeria");
  const preserved = await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: "" }, ratePerSegment: 7.25 });
  assert.equal(preserved.credentialRevision, before.credentialRevision);
  assert.equal(preserved.verifiedAt, before.verifiedAt);
  assert.equal(preserved.isActive, true);
  assert.equal(database.sqlite.prepare("SELECT credentials_ciphertext FROM sms_provider_accounts WHERE owner=? AND provider=?").get("owner-alice", "bulksmsnigeria").credentials_ciphertext, beforeRow.credentials_ciphertext);
  const changed = await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: "fixture-replacement-bsng-api-key" }, senderApproved: true });
  assert.equal(changed.credentialRevision, before.credentialRevision + 1);
  assert.equal(changed.verifiedAt, null);
  assert.equal(changed.senderApproved, false);
  assert.equal((await multiDirectory()).activeSmsProviderId, null);
  assert.equal(providerCalls.length, 0, "saving and rotating credentials cannot send or test implicitly");
});

test("each provider balance uses its own saved credentials and retains its own units without activating", async () => {
  for (const id of Object.keys(multiTokens)) await saveMultiProvider(id);
  for (const [id, expected] of [
    ["bulksmsnigeria", { balance: 2500.75, currency: "NGN", unit: "money" }],
    ["smartsmssolutions", { balance: 820.25, currency: "credits", unit: "credits" }],
    ["sendchamp", { balance: 12.45, currency: "USD", unit: "money" }],
  ]) {
    mockMultiBalance(id);
    const result = await api(`sms/providers/${id}/balance`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    for (const [key, value] of Object.entries(expected)) assert.equal(result.body[key], value);
    assert.equal(result.body.provider.verifiedAt, null, "a refresh is not a connection verification");
    assert.equal(result.body.providerId, id);
    assertNoCredentials(result.body, ...Object.values(multiTokens));
  }
  const state = await multiDirectory();
  assert.equal(state.activeSmsProviderId, null);
  assert.ok(state.smsProviders.every(provider => !provider.isActive));
  assert.equal(providerCalls.length, 3);
});

test("an old in-flight balance verification cannot verify a replacement account", async () => {
  const previous = await saveMultiProvider("bulksmsnigeria");
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  mockProvider(async url => { assert.equal(url.pathname, "/api/v2/balance"); entered(); await gate; return Response.json({ data: { status: "success" }, balance: { total_balance: 99 } }); }, multiOrigins.bulksmsnigeria);
  const checking = api("sms/providers/bulksmsnigeria/check", { credentialRevision: previous.credentialRevision });
  await started;
  await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: "fixture-new-account-during-check" } });
  release();
  const result = await checking;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "provider_revision_conflict");
  assert.equal(result.body.balance, undefined);
  const current = (await multiDirectory()).smsProviders.find(provider => provider.id === "bulksmsnigeria");
  assert.equal(current.verifiedAt, null);
  assert.equal(current.credentialRevision, previous.credentialRevision + 1);
  assert.equal(providerCalls.length, 1);
});

test("concurrent provider activation uses one atomic routing revision and never sends a message", async () => {
  await setupMultiProvider("bulksmsnigeria", { activate: false });
  await setupMultiProvider("smartsmssolutions", { activate: false });
  providerCalls = [];
  const current = await multiDirectory();
  const results = await Promise.all(["bulksmsnigeria", "smartsmssolutions"].map(id => api("sms/providers/active", {
    providerId: id, routingRevision: current.smsRoutingRevision,
    credentialRevision: current.smsProviders.find(provider => provider.id === id).credentialRevision,
  })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const after = await multiDirectory();
  assert.equal(after.smsProviders.filter(provider => provider.isActive).length, 1);
  assert.equal(after.smsRoutingRevision, current.smsRoutingRevision + 1);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM sms_routing WHERE owner=?").get("owner-alice").n, 1);
  await activateMultiProvider(null);
  assert.equal((await multiDirectory()).activeSmsProviderId, null);
  assert.equal(providerCalls.length, 0);
});

test("activation requires a verified connection and provider-specific sender confirmation", async () => {
  await saveMultiProvider("bulksmsnigeria", { senderApproved: false });
  let directory = await multiDirectory();
  let provider = directory.smsProviders.find(provider => provider.id === "bulksmsnigeria");
  const activate = () => api("sms/providers/active", { providerId: provider.id, credentialRevision: provider.credentialRevision, routingRevision: directory.smsRoutingRevision });
  assert.equal((await activate()).status, 409);
  await checkMultiProvider("bulksmsnigeria");
  directory = await multiDirectory();
  provider = directory.smsProviders.find(provider => provider.id === "bulksmsnigeria");
  assert.equal((await activate()).status, 409);
  await saveMultiProvider("bulksmsnigeria", { credentials: {}, senderApproved: true });
  providerCalls = [];
  await activateMultiProvider("bulksmsnigeria");
  assert.equal(providerCalls.length, 0);
});

test("switching provider blocks an older pinned campaign and never silently redirects it", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign([phone(0)]);
  await setupMultiProvider("smartsmssolutions");
  providerCalls = [];
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 409);
  assert.equal(providerCalls.length, 0);
  const detail = await api(`campaigns/${draft.id}`);
  assert.equal(detail.body.campaign.smsProviderId, "bulksmsnigeria");
  assert.equal(detail.body.campaign.summary.pending, 1);
  await activateMultiProvider("bulksmsnigeria");
  const payloads = mockBsngSubmissions();
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).body.campaign.summary.accepted, 1);
  assert.equal(payloads.length, 1);
});

test("a replaced account cannot send a draft pinned to the earlier credential generation", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign([phone(0)]);
  const replacement = "fixture-new-bsng-account-for-frozen-campaign";
  await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: replacement } });
  await saveMultiProvider("bulksmsnigeria", { credentials: {}, senderApproved: true });
  await checkMultiProvider("bulksmsnigeria", "owner-alice", replacement);
  await activateMultiProvider("bulksmsnigeria");
  providerCalls = [];
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /credentials changed/i);
  assert.equal(providerCalls.length, 0);
  assert.equal((await api(`campaigns/${draft.id}`)).body.campaign.summary.pending, 1);
});

test("legacy SMS drafts with no recorded account generation cannot be dispatched", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign([phone(0)]);
  database.sqlite.prepare("UPDATE campaigns SET sms_credential_revision=NULL WHERE id=?").run(draft.id);
  providerCalls = [];
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /older campaign|account version/i);
  assert.equal(providerCalls.length, 0);
  assert.equal((await api(`campaigns/${draft.id}`)).body.campaign.summary.pending, 1);
});

test("a sender revoked between validation and credential reading cannot reach the submission API", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign([phone(0)]);
  providerCalls = [];
  const originalPrepare = database.prepare.bind(database);
  let directoryReads = 0;
  database.prepare = sql => {
    const statement = originalPrepare(sql);
    if (sql.includes("LEFT JOIN sms_provider_accounts a")) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values), first = bound.first.bind(bound);
        bound.first = async (...args) => {
          directoryReads++;
          if (directoryReads === 2) database.sqlite.prepare("UPDATE sms_provider_accounts SET sender_approved=0,revision=revision+1 WHERE owner=? AND provider=?").run("owner-alice", "bulksmsnigeria");
          return first(...args);
        };
        return bound;
      };
    }
    return statement;
  };
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 409);
  assert.ok(directoryReads >= 2);
  assert.equal(providerCalls.length, 0);
  assert.equal((await api(`campaigns/${draft.id}`)).body.campaign.summary.pending, 1);
});

test("100 native-bulk results persist within the D1 query budget and can never be submitted twice", async t => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign(Array.from({ length: 101 }, (_, index) => phone(index)));
  const payloads = mockBsngSubmissions();
  const before = database.queryCount;
  const first = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  const queries = database.queryCount - before;
  t.diagnostic(`100-recipient SMS dispatch: ${queries} database statements`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(queries <= 25, `a native bulk dispatch must retain query headroom; used ${queries} statements`);
  assert.equal(first.body.campaign.summary.accepted, 100);
  assert.equal(first.body.campaign.summary.delivered, 0);
  assert.equal(first.body.remaining, 1);
  assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).body.campaign.summary.accepted, 101);
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.deepEqual(payloads.map(payload => payload.to.split(",").length), [100, 1]);
  assert.equal(new Set(payloads.flatMap(payload => payload.to.split(","))).size, 101);
});

test("partial provider acknowledgments keep individual outcomes and halt every later batch", async () => {
  await setupMultiProvider("smartsmssolutions");
  const numbers = Array.from({ length: 101 }, (_, index) => phone(index));
  const draft = await multiCampaign(numbers);
  providerCalls = [];
  mockProvider((_url, init) => {
    assert.ok(init.body instanceof FormData);
    const sent = String(init.body.get("to")).split(",");
    assert.equal(sent.length, 100);
    return Response.json({ code: 1000, message_id: "smart-partial-1", successful: sent.slice(0, 98).join(","),
      failed: sent[98], invalid: "", flooding: "", insufficient_unit: "", dnd_numbers: "" });
  }, multiOrigins.smartsmssolutions);
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.halted, true);
  assert.equal(result.body.campaign.summary.accepted, 98);
  assert.equal(result.body.campaign.summary.failed, 1);
  assert.equal(result.body.campaign.summary.unknown, 1);
  assert.equal(result.body.campaign.summary.pending, 1);
  const replay = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(replay.body.halted, true);
  assert.equal(providerCalls.length, 1);
});

test("5,000-number previews retain provider-specific batch sizes within the creation query budget", async () => {
  const numbers = Array.from({ length: 5000 }, (_, index) => phone(index));
  for (const [id, expectedBatchCount] of [["bulksmsnigeria", 50], ["sendchamp", 1000]]) {
    await setupMultiProvider(id);
    const directory = await multiDirectory();
    const provider = directory.smsProviders.find(provider => provider.id === id);
    providerCalls = [];
    const before = database.queryCount;
    const result = await api("campaigns", directCampaignBody(numbers.join("\n"), {
      channel: "generic", mode: "preview", senderId: provider.senderId,
      smsProviderId: id, smsCredentialRevision: provider.credentialRevision,
    }));
    const queries = database.queryCount - before;
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok(queries <= 50, `${id} preview creation used ${queries} statements`);
    assert.equal(result.body.campaign.recipientCount, 5000);
    assert.equal(result.body.campaign.summary.validated, 5000);
    const detail = await api(`campaigns/${result.body.campaign.id}`);
    assert.equal(detail.body.recipients.length, 5000);
    assert.equal(detail.body.batches.length, expectedBatchCount);
    assert.equal((await api(`campaigns/${result.body.campaign.id}/send`, { confirmed: true })).status, 409);
    assert.equal(providerCalls.length, 0);
  }
});

test("delivery polling changes only exact message-recipient matches and blocks a replacement account", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign([phone(0), phone(1)]);
  mockBsngSubmissions();
  await api(`campaigns/${draft.id}/send`, { confirmed: true });
  mockProvider(url => {
    assert.equal(url.pathname, "/api/v2/delivery-reports");
    assert.equal(url.searchParams.get("message_id"), "bsng-submission-1");
    return Response.json({ status: "success", code: "BSNG-0000", data: { message_id: "bsng-submission-1", reports: [
      { recipient: phone(0).slice(1), delivery_status: "delivrd" },
      { recipient: phone(1).slice(1), delivery_status: "sent awaiting status" },
      { recipient: phone(99).slice(1), delivery_status: "delivrd" },
    ] } });
  }, multiOrigins.bulksmsnigeria);
  const refreshed = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.campaign.summary.delivered, 1);
  assert.equal(refreshed.body.campaign.summary.accepted, 1);
  mockProvider(() => Response.json({ status: "success", code: "BSNG-0000", data: { message_id: "foreign-message-id", reports: [{ recipient: phone(1).slice(1), delivery_status: "delivrd" }] } }), multiOrigins.bulksmsnigeria);
  const mismatched = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(mismatched.body.campaign.summary.delivered, 1);
  assert.ok(mismatched.body.warnings.length > 0);
  await saveMultiProvider("bulksmsnigeria", { credentials: { apiToken: "fixture-replacement-for-report-scope" } });
  providerCalls = [];
  assert.equal((await api(`campaigns/${draft.id}/refresh`, { cursor: 0 })).status, 409);
  assert.equal(providerCalls.length, 0);
});

test("WhatsApp remains on Termii when a different SMS provider is active", async () => {
  await setupWhatsApp();
  await setupMultiProvider("bulksmsnigeria");
  const draft = await whatsappCampaign([], { audienceSource: "direct", contactIds: undefined,
    directNumbers: phone(0), directConsent: true });
  providerCalls = [];
  const payloads = mockWhatsAppSends(payload => {
    assert.equal(payload.api_key, ownedApiKey);
    assert.equal(payload.phone_number, phone(0).slice(1));
    return Response.json({ code: "ok", message_id_str: "whatsapp-on-termii-with-bsng-sms-active" });
  });
  const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.campaign.summary.accepted, 1);
  assert.equal(payloads.length, 1);
  assert.equal(draft.smsProviderId, "termii");
  assert.equal((await multiDirectory()).activeSmsProviderId, "bulksmsnigeria");
});

test("5,000-contact import and deletion stay inside the request query budget and preserve owner scope", async t => {
  const numbers = Array.from({ length: 5000 }, (_, index) => ({ name: `Community member ${index}`, phone: phone(index), consent: true, group: "Community" }));
  const beforeImport = database.queryCount;
  const imported = await api("contacts", { contacts: numbers });
  const importQueries = database.queryCount - beforeImport;
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.inserted, 5000);
  t.diagnostic(`5,000-contact import: ${importQueries} database statements`);
  assert.ok(importQueries <= 25, `5,000-contact import used ${importQueries} statements`);

  const ownIds = database.sqlite.prepare("SELECT id FROM contacts WHERE owner=?").all("owner-alice").map(row => row.id);
  const bob = await contacts(1, "owner-bob");
  const beforeDelete = database.queryCount;
  const deleted = await api("contacts", { ids: [...ownIds.slice(0, 4999), bob[0].id] }, { method: "DELETE" });
  const deleteQueries = database.queryCount - beforeDelete;
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted, 4999);
  t.diagnostic(`5,000 selected contact IDs: ${deleteQueries} database statements`);
  assert.ok(deleteQueries <= 2, `bulk delete used ${deleteQueries} statements`);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM contacts WHERE owner=?").get("owner-alice").count, 1);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM contacts WHERE owner=?").get("owner-bob").count, 1);
  assert.equal(providerCalls.length, 0);
});

test("dashboard summaries load only the latest 100 campaigns", async t => {
  const insertCampaign = database.sqlite.prepare("INSERT INTO campaigns (id,owner,name,message,sender_id,channel,mode,status,recipient_count,segments,encoding,created_at,updated_at) VALUES (?,'owner-alice',?,'Community update','Trezad','generic','draft','draft',1,1,'GSM-7',?,?)");
  const insertBatch = database.sqlite.prepare("INSERT INTO batches (id,campaign_id,batch_index,status,created_at,updated_at) VALUES (?,?,0,'pending',0,0)");
  const insertRecipient = database.sqlite.prepare("INSERT INTO recipients (id,campaign_id,batch_id,contact_id,name,phone,status,updated_at) VALUES (?,?,?,'','Community member',?,'pending',0)");
  const ids = [];
  for (let index = 0; index < 120; index++) {
    const id = crypto.randomUUID(), batchId = crypto.randomUUID();
    ids.push(id);
    insertCampaign.run(id, `Campaign ${index}`, 1000 + index, 1000 + index);
    insertBatch.run(batchId, id);
    insertRecipient.run(crypto.randomUUID(), id, batchId, phone(index));
  }
  const beforeRows = database.resultRowCount;
  const result = await api("state");
  const returnedRows = database.resultRowCount - beforeRows;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.campaigns.map(campaign => campaign.id), ids.slice(-100).reverse());
  assert.ok(result.body.campaigns.every(campaign => campaign.summary.pending === 1));
  t.diagnostic(`Latest 100 campaign summaries: ${returnedRows} total database result rows`);
  assert.ok(returnedRows <= 210, `dashboard queried historical summaries unnecessarily (${returnedRows} rows)`);
  assert.equal(providerCalls.length, 0);
});

for (const cancel of [false, true]) {
  test(`a late provider pause releases an unsent batch${cancel ? " while respecting concurrent cancellation" : " without losing suppressions"}`, async () => {
    await setupMultiProvider("bulksmsnigeria");
    const numbers = Array.from({ length: 101 }, (_, index) => phone(index));
    const draft = await multiCampaign(numbers);
    // A new opt-out after draft creation must stay skipped even if a claimed
    // batch is subsequently released because the provider was paused.
    await api("contacts", { contacts: [{ name: "Opted out", phone: numbers[0], consent: false }] });
    providerCalls = [];
    const originalPrepare = database.prepare.bind(database);
    let paused = false;
    database.prepare = sql => {
      const statement = originalPrepare(sql);
      if (sql === "SELECT id,phone FROM recipients WHERE batch_id = ? AND status = 'sending'") {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values), all = bound.all.bind(bound);
          bound.all = async () => {
            const result = await all();
            if (!paused) {
              paused = true;
              database.sqlite.prepare("UPDATE sms_routing SET active_provider=NULL,active_credential_revision=NULL,revision=revision+1 WHERE owner=?").run("owner-alice");
              if (cancel) assert.equal((await api(`campaigns/${draft.id}/cancel`, {})).status, 200);
            }
            return result;
          };
          return bound;
        };
      }
      return statement;
    };
    const result = await api(`campaigns/${draft.id}/send`, { confirmed: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.halted, true);
    assert.match(result.body.message, /not submitted/i);
    assert.equal(providerCalls.length, 0, "a failed final guard must not contact the provider");
    const summary = result.body.campaign.summary;
    assert.equal(summary.failed, 0);
    assert.equal(summary.unknown, 0);
    assert.equal(summary.sending, 0);
    assert.equal(summary.pending, cancel ? 0 : 100);
    assert.equal(summary.skipped, cancel ? 101 : 1);
    const detail = await api(`campaigns/${draft.id}`);
    assert.ok(detail.body.batches.every(batch => batch.status === (cancel ? "cancelled" : "pending")));
    if (cancel) {
      assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).status, 409);
    } else {
      await activateMultiProvider("bulksmsnigeria");
      const payloads = mockBsngSubmissions();
      const resumed = await api(`campaigns/${draft.id}/send`, { confirmed: true });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      assert.equal(resumed.body.campaign.summary.accepted, 99);
      assert.equal(resumed.body.remaining, 1);
      assert.equal((await api(`campaigns/${draft.id}/send`, { confirmed: true })).body.campaign.summary.accepted, 100);
      assert.deepEqual(payloads.map(payload => payload.to.split(",").length), [99, 1]);
      const submitted = payloads.flatMap(payload => payload.to.split(","));
      assert.equal(new Set(submitted).size, 100);
      assert.ok(!submitted.includes(numbers[0].slice(1)), "the opted-out number must never be restored");
    }
  });
}

test("report paging bounds 5,000 message IDs and stays stable as delivered groups disappear", async t => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign(Array.from({ length: 5000 }, (_, index) => phone(index)));
  database.sqlite.prepare("UPDATE recipients SET status='accepted',provider_id='report-' || rowid WHERE campaign_id=?").run(draft.id);
  database.sqlite.prepare("UPDATE batches SET status='accepted' WHERE campaign_id=?").run(draft.id);
  database.sqlite.prepare("UPDATE campaigns SET mode='live',status='submitted' WHERE id=?").run(draft.id);
  const recipientRows = database.sqlite.prepare("SELECT rowid,phone,provider_id FROM recipients WHERE campaign_id=? ORDER BY rowid").all(draft.id);
  const byId = new Map(recipientRows.map(row => [row.provider_id, row]));
  const queriedIds = [];
  providerCalls = [];
  mockProvider(url => {
    assert.equal(url.pathname, "/api/v2/delivery-reports");
    const providerId = url.searchParams.get("message_id"), row = byId.get(providerId);
    assert.ok(row, "only this campaign's recorded message IDs may be queried");
    queriedIds.push(providerId);
    return Response.json({ status: "success", code: "BSNG-0000", data: { message_id: providerId, reports: [
      { recipient: row.phone.slice(1), delivery_status: "delivrd" },
    ] } });
  }, multiOrigins.bulksmsnigeria);
  const beforeRows = database.resultRowCount;
  const first = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  const returnedRows = database.resultRowCount - beforeRows;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.campaign.summary.delivered, 10);
  assert.equal(first.body.nextCursor, recipientRows[9].rowid);
  assert.equal(queriedIds.length, 10);
  t.diagnostic(`First page from 5,000 provider IDs: ${returnedRows} database result rows; 10 provider reads`);
  assert.ok(returnedRows <= 25, `one report page materialized ${returnedRows} database rows`);
  // Simulate independent reports arriving between pages; the cursor must not
  // skip remaining recipients when completed groups disappear from selection.
  database.sqlite.prepare("UPDATE recipients SET status='delivered' WHERE campaign_id=? AND rowid>?").run(draft.id, recipientRows[26].rowid);
  const second = await api(`campaigns/${draft.id}/refresh`, { cursor: first.body.nextCursor });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.nextCursor, recipientRows[19].rowid);
  const third = await api(`campaigns/${draft.id}/refresh`, { cursor: second.body.nextCursor });
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(third.body.nextCursor, null);
  assert.equal(third.body.campaign.summary.delivered, 5000);
  assert.deepEqual(queriedIds, recipientRows.slice(0, 27).map(row => row.provider_id));
  const complete = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(complete.body.updated, 0);
  assert.equal(complete.body.nextCursor, null);
  assert.equal(queriedIds.length, 27, "confirmed deliveries must not cause repeated provider lookups");
});

test("rate-limited and unauthorised reports stop after one five-request wave without losing successful updates", async () => {
  await setupMultiProvider("bulksmsnigeria");
  const draft = await multiCampaign(Array.from({ length: 25 }, (_, index) => phone(index)));
  database.sqlite.prepare("UPDATE recipients SET status='accepted',provider_id='limited-report-' || rowid WHERE campaign_id=?").run(draft.id);
  database.sqlite.prepare("UPDATE batches SET status='accepted' WHERE campaign_id=?").run(draft.id);
  database.sqlite.prepare("UPDATE campaigns SET mode='live',status='submitted' WHERE id=?").run(draft.id);
  const recipientRows = database.sqlite.prepare("SELECT phone,provider_id FROM recipients WHERE campaign_id=?").all(draft.id);
  const byId = new Map(recipientRows.map(row => [row.provider_id, row]));
  let expectedDelivered = 0;
  for (const [status, guidance] of [[429, /rate[- ]limit/i], [401, /credentials|authentication/i], [403, /denied|permissions|approval/i]]) {
    providerCalls = [];
    let requests = 0;
    mockProvider(url => {
      assert.equal(url.pathname, "/api/v2/delivery-reports");
      const providerId = url.searchParams.get("message_id"), row = byId.get(providerId);
      assert.ok(row);
      if (++requests === 1) return new Response(`private-upstream-payload-${multiTokens.bulksmsnigeria}`, { status });
      return Response.json({ status: "success", code: "BSNG-0000", data: { message_id: providerId, reports: [
        { recipient: row.phone.slice(1), delivery_status: "delivrd" },
      ] } });
    }, multiOrigins.bulksmsnigeria);
    const result = await api(`campaigns/${draft.id}/refresh`, { cursor: 0 });
    expectedDelivered += 4;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.halted, true);
    assert.equal(result.body.nextCursor, null, "the browser must stop requesting further report pages");
    assert.equal(requests, 5, "only the already-started request wave may finish");
    assert.equal(providerCalls.length, 5);
    assert.equal(result.body.updated, 4);
    assert.equal(result.body.campaign.summary.delivered, expectedDelivered);
    assert.equal(result.body.campaign.summary.accepted, 25 - expectedDelivered);
    assert.equal(result.body.campaign.summary.failed, 0);
    assert.equal(result.body.campaign.summary.unknown, 0);
    assert.match(result.body.warnings.join(" "), guidance);
    assert.match(result.body.warnings.join(" "), /report refresh paused/i);
    assertNoCredentials(result.body, multiTokens.bulksmsnigeria);
    assert.doesNotMatch(JSON.stringify(result.body), /private-upstream-payload/);
  }
});

async function termiiWithApprovedSenderAndWhatsApp() {
  await setupWhatsApp();
  const provider = await providerState();
  mockSenderList([activeSender]);
  const selected = await api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: provider.credentialRevision });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  await activateMultiProvider("termii");
  return (await api("state")).body;
}

test("re-entering the same Termii key preserves verification, approved sender, active SMS, and WhatsApp account generation", async () => {
  const before = await termiiWithApprovedSenderAndWhatsApp();
  const encryptedBefore = database.sqlite.prepare("SELECT api_key_ciphertext FROM provider_settings WHERE owner=?").get("owner-alice").api_key_ciphertext;
  providerCalls = [];
  const saved = await api("provider/settings", { apiKey: `  ${ownedApiKey}  `, baseUrl: before.provider.baseUrl, revision: before.provider.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = (await api("state")).body;
  assert.equal(after.provider.credentialRevision, before.provider.credentialRevision);
  assert.equal(after.provider.verifiedAt, before.provider.verifiedAt);
  assert.equal(after.provider.revision, before.provider.revision + 1);
  assert.equal(after.settings.senderApproved, true);
  assert.equal(after.settings.senderApprovalSource, "termii");
  assert.equal(after.settings.senderCredentialRevision, before.settings.senderCredentialRevision);
  assert.equal(after.activeSmsProviderId, "termii");
  assert.equal(after.whatsapp.liveEnabled, true);
  assert.equal(after.whatsapp.providerRevision, before.whatsapp.providerRevision);
  assert.equal(database.sqlite.prepare("SELECT api_key_ciphertext FROM provider_settings WHERE owner=?").get("owner-alice").api_key_ciphertext, encryptedBefore);
  assertNoCredentials(saved.body);
  assert.equal(providerCalls.length, 0);
});

for (const change of ["key", "base URL"]) {
  test(`a real Termii ${change} replacement invalidates account verification, sender approval, and both active channels`, async () => {
    const before = await termiiWithApprovedSenderAndWhatsApp();
    providerCalls = [];
    const changed = await api("provider/settings", { revision: before.provider.revision,
      ...(change === "key" ? { apiKey: replacementApiKey } : { baseUrl: "https://api.ng.termii.com", apiKey: ownedApiKey }),
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const after = (await api("state")).body;
    assert.equal(after.provider.credentialRevision, before.provider.credentialRevision + 1);
    assert.equal(after.provider.verifiedAt, null);
    assert.equal(after.settings.senderApproved, false);
    assert.equal(after.activeSmsProviderId, null);
    assert.equal(after.whatsapp.liveEnabled, false);
    assertNoCredentials(changed.body);
    assert.equal(providerCalls.length, 0);
  });
}

async function verifiedSmsProviderForChecks(id) {
  if (id === "termii") {
    const state = await termiiWithApprovedSenderAndWhatsApp();
    const enabled = await api("provider/settings", { liveEnabled: true, revision: state.provider.revision });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  } else await setupMultiProvider(id);
  return (await multiDirectory()).smsProviders.find(provider => provider.id === id);
}

for (const id of ["termii", "bulksmsnigeria"]) {
  test(`${id} explicit 401 clears previous verification, while background failures, timeouts, and 429 preserve it`, async () => {
    const before = await verifiedSmsProviderForChecks(id);
    const origin = id === "termii" ? "https://api.termii.com" : multiOrigins[id];
    const checkPath = id === "termii" ? "provider/check" : `sms/providers/${id}/check`;
    const balancePath = id === "termii" ? "provider/balance" : `sms/providers/${id}/balance`;
    const rowForProvider = () => id === "termii"
      ? database.sqlite.prepare("SELECT api_key_ciphertext AS ciphertext FROM provider_settings WHERE owner=?").get("owner-alice")
      : database.sqlite.prepare("SELECT credentials_ciphertext AS ciphertext FROM sms_provider_accounts WHERE owner=? AND provider=?").get("owner-alice", id);
    const ciphertext = rowForProvider().ciphertext;
    providerCalls = [];
    mockProvider(() => Response.json({ error: "private-authentication-payload" }, { status: 401 }), origin);
    assert.equal((await api(balancePath)).status, 502);
    let directory = await multiDirectory();
    let current = directory.smsProviders.find(provider => provider.id === id);
    assert.equal(current.verifiedAt, before.verifiedAt, "a background balance read must not change activation");
    assert.equal(directory.activeSmsProviderId, id);

    for (const failure of [429, 408, "timeout"]) {
      mockProvider(() => {
        if (failure === "timeout") throw new DOMException("mocked request timeout", "TimeoutError");
        return Response.json({ error: "private-temporary-payload" }, { status: failure });
      }, origin);
      const result = await api(checkPath, { credentialRevision: before.credentialRevision });
      assert.equal(result.status, 502, JSON.stringify(result.body));
      directory = await multiDirectory();
      current = directory.smsProviders.find(provider => provider.id === id);
      assert.equal(current.verifiedAt, before.verifiedAt, `${failure} must not erase an existing verification`);
      assert.equal(current.revision, before.revision);
      assert.equal(directory.activeSmsProviderId, id);
      assertNoCredentials(result.body, ...Object.values(multiTokens));
    }

    mockProvider(() => Response.json({ error: "private-authentication-payload" }, { status: 401 }), origin);
    const rejected = await api(checkPath, { credentialRevision: before.credentialRevision });
    assert.equal(rejected.status, 502, JSON.stringify(rejected.body));
    assert.equal(rejected.body.diagnostic.upstreamStatus, 401);
    directory = await multiDirectory();
    current = directory.smsProviders.find(provider => provider.id === id);
    assert.equal(current.verifiedAt, null);
    assert.equal(current.revision, before.revision + 1);
    assert.equal(current.credentialRevision, before.credentialRevision);
    assert.equal(directory.activeSmsProviderId, null);
    assert.equal(current.isActive, false);
    assert.equal(current.configured, true, "authentication rejection must not erase saved credentials");
    assert.equal(current.senderApproved, true, "connection verification must not rewrite sender approval");
    assert.equal(rowForProvider().ciphertext, ciphertext);
    if (id === "termii") {
      const state = (await api("state")).body;
      assert.equal(state.provider.liveEnabled, false);
      assert.equal(state.whatsapp.liveEnabled, false, "shared WhatsApp sending also needs a verified Termii connection");
      assert.equal(state.settings.senderApproved, true);
    }
    assert.equal(providerCalls.length, 5, "none of these balance requests may retry automatically");
    assertNoCredentials(rejected.body, ...Object.values(multiTokens));
    assert.doesNotMatch(JSON.stringify(rejected.body), /private-authentication-payload/);
  });

  for (const newer of ["replacement account", "newer successful check"]) {
    test(`${id} old in-flight 401 cannot invalidate a ${newer}`, async () => {
      await verifiedSmsProviderForChecks(id);
      // Model an earlier successful verification without sleeping; the next
      // successful check must have an observably newer verifiedAt timestamp.
      if (id === "termii") database.sqlite.prepare("UPDATE provider_settings SET verified_at=? WHERE owner=?").run(Date.now() - 1000, "owner-alice");
      else database.sqlite.prepare("UPDATE sms_provider_accounts SET verified_at=? WHERE owner=? AND provider=?").run(Date.now() - 1000, "owner-alice", id);
      const previous = (await multiDirectory()).smsProviders.find(provider => provider.id === id);
      let release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      mockProvider(async url => {
        assert.equal(url.pathname, id === "termii" ? "/api/get-balance" : "/api/v2/balance");
        entered();
        await gate;
        return Response.json({ error: "private-stale-authentication-payload" }, { status: 401 });
      }, id === "termii" ? "https://api.termii.com" : multiOrigins[id]);
      const checking = api(id === "termii" ? "provider/check" : `sms/providers/${id}/check`, { credentialRevision: previous.credentialRevision });
      await started;
      if (id === "termii") {
        if (newer === "replacement account") {
          const saved = await api("provider/settings", { apiKey: replacementApiKey, revision: previous.revision });
          assert.equal(saved.status, 200, JSON.stringify(saved.body));
        }
        const key = newer === "replacement account" ? replacementApiKey : ownedApiKey;
        mockBalance(key);
        const verified = await verifyProvider();
        if (newer === "replacement account") {
          mockProvider(url => {
            assert.equal(url.pathname, "/api/sender-id");
            assert.equal(url.searchParams.get("api_key"), replacementApiKey);
            return senderListResponse([activeSender]);
          });
          const selected = await api("provider/sender-ids/select", { senderId: "Trezad", credentialRevision: verified.credentialRevision });
          assert.equal(selected.status, 200, JSON.stringify(selected.body));
          await activateMultiProvider(id);
        }
      } else {
        const token = newer === "replacement account" ? "fixture-replacement-while-old-401-pending" : multiTokens[id];
        if (newer === "replacement account") await saveMultiProvider(id, { credentials: { apiToken: token } });
        await checkMultiProvider(id, "owner-alice", token);
        if (newer === "replacement account") {
          await saveMultiProvider(id, { credentials: { apiToken: "" }, senderApproved: true });
          await activateMultiProvider(id);
        }
      }
      const verified = (await multiDirectory()).smsProviders.find(provider => provider.id === id);
      assert.ok(verified.verifiedAt > previous.verifiedAt);
      assert.equal(verified.isActive, true);
      release();
      const stale = await checking;
      assert.ok([409, 502].includes(stale.status), JSON.stringify(stale.body));
      const directory = await multiDirectory(), current = directory.smsProviders.find(provider => provider.id === id);
      assert.equal(current.verifiedAt, verified.verifiedAt);
      assert.equal(current.revision, verified.revision);
      assert.equal(current.credentialRevision, verified.credentialRevision);
      assert.equal(current.senderApproved, true);
      assert.equal(directory.activeSmsProviderId, id);
      assertNoCredentials(stale.body, ...Object.values(multiTokens));
      assert.doesNotMatch(JSON.stringify(stale.body), /private-stale-authentication-payload/);
    });
  }
}
