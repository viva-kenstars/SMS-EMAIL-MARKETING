import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url)), out = path.join(root, "outputs", "marketing-test");
await mkdir(out, { recursive: true });
await build({ entryPoints: [path.join(root, "app/lib/email-marketing/service.ts")], outfile: path.join(out, "service.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", external: ["sanitize-html"] });
const { handleMarketingApi, handleMarketingWorker, advanceMarketingQueue } = await import(pathToFileURL(path.join(out, "service.mjs")).href);
const migrations = await Promise.all((await readdir(path.join(root, "drizzle"))).filter(n => /^\d+.*\.sql$/.test(n)).sort().map(n => readFile(path.join(root, "drizzle", n), "utf8")));
const key = Buffer.from(new Uint8Array(32).fill(21)).toString("base64");
const password = "smtp-test-password-never-on-real-network", token = "relay-test-token-0000000000000000000000000000";
let db, calls, handler, dnsHandler;
class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first(column) { const row = this.db.sqlite.prepare(this.sql).get(...this.args); if (this.db.afterFirst) await this.db.afterFirst(this.sql, row); return row === undefined ? null : column ? row[column] : row; }
  async all() { return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args), meta: {} }; }
  execute() { const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { const result = this.execute(); if (this.db.afterRun) await this.db.afterRun(this.sql, result); return result; }
}
class Database {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec("PRAGMA foreign_keys=ON"); for (const sql of migrations) this.sqlite.exec(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { this.sqlite.exec("BEGIN"); try { const results = statements.map(s => s.execute()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
}
const fetchMock = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "cloudflare-dns.com") return dnsHandler(url, init);
  assert.equal(url.origin, "https://relay.example.com");
  assert.equal(init.headers.Authorization, `Bearer ${token}`);
  assert.equal(init.redirect, "manual");
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, init, body });
  return handler(url, init, body);
};
beforeEach(() => {
  db = new Database(); calls = [];
  dnsHandler = url => Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] });
  handler = url => url.pathname === "/v1/health" ? Response.json({ ok: true, service: "trezad-smtp-relay" }) : url.pathname === "/v1/check" ? Response.json({ ok: true }) : Response.json({ status: "accepted", messageId: "<synthetic@example.net>" });
});
afterEach(() => db.sqlite.close());
async function api(route, body, { owner = "alice", method = body === undefined ? "GET" : "POST", headers = {} } = {}) {
  const request = new Request(`https://app.example.com/api/marketing/${route}`, { method, headers: { Origin: "https://app.example.com", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handleMarketingApi(request, { db, owner, masterKey: key, fetch: fetchMock });
  return { status: response.status, body: await response.json() };
}
const ok = result => { assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
async function configured(owner = "alice") {
  const current = ok(await api("settings", undefined, { owner })).settings;
  const saved = await api("settings", { revision: current.revision, relayUrl: "https://relay.example.com", relayToken: token, postalAddress: "1 Example Avenue, Lagos" }, { owner }); ok(saved);
  return ok(await api("settings/test", {}, { owner })).settings;
}
async function account(label = "Primary", owner = "alice", overrides = {}) {
  let saved = ok(await api("accounts", { revision: 0, label, host: "smtp.example.com", port: 587, security: "starttls", username: `${label}@example.net`, password, fromEmail: "sender@example.net", fromName: "Trezad", dailyLimit: 500, minIntervalSeconds: 5, enabled: false, ...overrides }, { owner })).account;
  saved = ok(await api(`accounts/${saved.id}/test`, {}, { owner })).account;
  return ok(await api(`accounts/${saved.id}/toggle`, { revision: saved.revision, enabled: true }, { owner })).account;
}
function verificationJob(count = 3, owner = "alice", statuses) {
  const id = crypto.randomUUID(), now = Date.now();
  const rows = Array.from({ length: count }, (_, i) => [`person${i}@example.net`, i + 1, statuses?.[i] || "valid"]);
  db.sqlite.prepare("INSERT INTO email_jobs(id,owner,name,status,total_rows,valid_count,created_at,updated_at) VALUES(?,?,?,'completed',?,?,?,?)").run(id, owner, "Synthetic verified list", count, rows.filter(r => r[2] === "valid").length, now, now);
  db.sqlite.prepare("INSERT INTO email_targets(job_id,email,first_position,status,reason,updated_at) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),'safe',? FROM json_each(?)").run(id, now, JSON.stringify(rows));
  return id;
}
async function group(count = 3, owner = "alice", statuses) {
  const jobId = verificationJob(count, owner, statuses);
  let saved = ok(await api("groups", { name: `Group ${crypto.randomUUID()}` }, { owner })).group;
  let cursor;
  do { const result = ok(await api(`groups/${saved.id}/import-verified`, { jobId, cursor }, { owner })); saved = result.group; cursor = result.nextCursor; } while (cursor);
  return saved;
}
async function draft(owner = "alice", extra = {}) {
  return ok(await api("campaigns", { revision: 0, name: "November update", subject: "Hello {{first_name}}", preheader: "A short preview", html: '<p style="color:#123456">Hello {{email}}</p><a href="https://example.com">Visit us</a>', text: "Hello {{email}}", ...extra }, { owner })).campaign;
}
async function prepared(count = 3, extraAccounts = 0, launchExtra = {}) {
  await configured();
  const accounts = [await account()];
  for (let i = 0; i < extraAccounts; i++) accounts.push(await account(`Alternative${i}`));
  const contacts = await group(count), campaign = await draft();
  const launched = ok(await api(`campaigns/${campaign.id}/launch`, { revision: campaign.revision, groupIds: [contacts.id], accountIds: accounts.map(a => a.id), intervalSeconds: 10, acknowledgeConsent: true, ...launchExtra })).campaign;
  calls = [];
  return { accounts, group: contacts, campaign: launched };
}
const queue = options => advanceMarketingQueue(db, key, { fetch: fetchMock, ...options });
const sends = () => calls.filter(c => c.url.pathname === "/v1/send");
function due(id) { db.sqlite.prepare("UPDATE marketing_campaigns SET next_send_at=0 WHERE id=?").run(id); db.sqlite.exec("UPDATE smtp_accounts SET next_available_at=0"); }
function noSecrets(value) { const body = JSON.stringify(value); for (const secret of [key, password, token]) assert.ok(!body.includes(secret)); assert.ok(!body.includes("v1:")); }

test("settings and SMTP secrets are encrypted and never returned", async () => {
  await configured(); const acc = await account();
  noSecrets(ok(await api("state"))); noSecrets(acc);
  assert.ok(!JSON.stringify(db.sqlite.prepare("SELECT * FROM smtp_accounts").all()).includes(password));
  assert.ok(!JSON.stringify(db.sqlite.prepare("SELECT * FROM marketing_settings").all()).includes(token));
});
test("saving settings and accounts never contacts a provider or sends mail", async () => {
  ok(await api("settings", { revision: 0, relayUrl: "https://relay.example.com", relayToken: token }));
  ok(await api("accounts", { revision: 0, label: "Saved", host: "smtp.example.com", port: 465, security: "tls", username: "user", password, fromEmail: "sender@example.net" }));
  assert.equal(calls.length, 0);
});
test("private origins, IP literals, custom paths and insecure SMTP mode rejected", async () => {
  for (const relayUrl of ["http://relay.example.com", "https://127.0.0.1", "https://private.local", "https://relay.example.com/path", "https://user:pw@relay.example.com", "https://relay.example.com:8443"]) assert.equal((await api("settings", { revision: 0, relayUrl, relayToken: token })).status, 400);
  assert.equal((await api("accounts", { revision: 0, label: "Bad", host: "smtp.example.com", port: 587, security: "none", username: "a", password, fromEmail: "sender@example.net" })).status, 400);
});
test("DNS private address blocks service credential transmission", async () => {
  ok(await api("settings", { revision: 0, relayUrl: "https://relay.example.com", relayToken: token }));
  dnsHandler = () => Response.json({ Status: 0, Answer: [{ type: 1, data: "10.0.0.1" }] });
  assert.equal((await api("settings/test", {})).status, 502); assert.equal(calls.length, 0);
});
test("settings test validates authenticated health contract", async () => {
  ok(await api("settings", { revision: 0, relayUrl: "https://relay.example.com", relayToken: token }));
  handler = () => Response.json({ ok: true });
  assert.equal((await api("settings/test", {})).status, 502);
  assert.equal(ok(await api("settings")).settings.relayVerifiedAt, null);
});
test("unverified SMTP account cannot be enabled", async () => {
  const saved = ok(await api("accounts", { revision: 0, label: "Saved", host: "smtp.example.com", port: 587, security: "starttls", username: "u", password, fromEmail: "sender@example.net" })).account;
  assert.equal((await api(`accounts/${saved.id}/toggle`, { revision: saved.revision, enabled: true })).status, 409);
});
test("multiple verified SMTP accounts can be enabled simultaneously", async () => {
  await configured(); await account(); await account("Backup");
  const state = ok(await api("state")); assert.equal(state.accounts.filter(a => a.enabled).length, 2); assert.equal(sends().length, 0);
});
test("changing a credential invalidates verification and disables that account", async () => {
  await configured(); const acc = await account();
  const updated = ok(await api("accounts", { id: acc.id, revision: acc.revision, password: "replacement-password", enabled: false })).account;
  assert.equal(updated.verifiedAt, null); assert.equal(updated.enabled, false); assert.equal(updated.credentialRevision, acc.credentialRevision + 1);
});
test("identical SMTP secret preserves generation and verification", async () => {
  await configured(); const acc = await account();
  const updated = ok(await api("accounts", { id: acc.id, revision: acc.revision, password })).account;
  assert.equal(updated.credentialRevision, acc.credentialRevision); assert.equal(updated.verifiedAt, acc.verifiedAt); assert.equal(updated.enabled, true);
});
test("host and relay origin changes require secret re-entry", async () => {
  const settings = await configured(); const acc = await account();
  assert.equal((await api("accounts", { id: acc.id, revision: acc.revision, host: "other.example.com" })).status, 400);
  assert.equal((await api("settings", { revision: settings.revision, relayUrl: "https://other.example.com" })).status, 400);
});
test("stale account revision cannot overwrite a later toggle", async () => {
  await configured(); const acc = await account();
  ok(await api(`accounts/${acc.id}/toggle`, { revision: acc.revision, enabled: false }));
  assert.equal((await api("accounts", { id: acc.id, revision: acc.revision, label: "Stale" })).status, 409);
});
test("owner isolation covers SMTP accounts, contacts and campaign actions", async () => {
  const preparedState = await prepared();
  assert.equal((await api(`accounts/${preparedState.accounts[0].id}`, undefined, { owner: "bob" })).status, 404);
  assert.equal((await api(`groups/${preparedState.group.id}/contacts`, undefined, { owner: "bob" })).status, 404);
  assert.equal((await api(`campaigns/${preparedState.campaign.id}`, undefined, { owner: "bob" })).status, 404);
  assert.equal((await api(`campaigns/${preparedState.campaign.id}/advance`, {}, { owner: "bob" })).status, 404); assert.equal(sends().length, 0);
});
test("groups import only valid provider results and preserve reimport idempotency", async () => {
  const jobId = verificationJob(5, "alice", ["valid", "invalid", "risky", "unknown", "valid"]);
  const g = ok(await api("groups", { name: "Verified only" })).group;
  let imported = ok(await api(`groups/${g.id}/import-verified`, { jobId })); assert.equal(imported.imported, 2); assert.equal(imported.group.contactCount, 2);
  imported = ok(await api(`groups/${g.id}/import-verified`, { jobId })); assert.equal(imported.imported, 0); assert.equal(imported.group.contactCount, 2);
});
test("unfinished and foreign verification jobs cannot populate a group", async () => {
  const g = ok(await api("groups", { name: "Safe" })).group;
  const job = verificationJob(); db.sqlite.prepare("UPDATE email_jobs SET status='running' WHERE id=?").run(job);
  assert.equal((await api(`groups/${g.id}/import-verified`, { jobId: job })).status, 409);
  assert.equal((await api(`groups/${g.id}/import-verified`, { jobId: verificationJob(1, "bob") })).status, 404);
});
test("verified imports pass 20,000 total without an artificial list cap", async () => {
  const g = await group(20_001); assert.equal(g.contactCount, 20_001);
  const page = ok(await api(`groups/${g.id}/contacts`)); assert.equal(page.contacts.length, 100); assert.ok(page.nextCursor);
});
test("suppressed contacts remain suppressed when imported again", async () => {
  const jobId = verificationJob(1), g = ok(await api("groups", { name: "Suppression" })).group;
  ok(await api(`groups/${g.id}/import-verified`, { jobId }));
  const contact = ok(await api(`groups/${g.id}/contacts`)).contacts[0];
  ok(await api(`contacts/${contact.id}/suppress`, {}));
  const result = ok(await api(`groups/${g.id}/import-verified`, { jobId })); assert.equal(result.group.contactCount, 0);
});
test("HTML editor content is sanitized while retaining email tables and inline formatting", async () => {
  const campaign = await draft("alice", { html: '<style>body{display:none}</style><script>alert(1)</script><table cellpadding="8"><tr><td style="color:#123456;background-image:url(https://bad.example/x)"><img src="https://example.com/a.png" onerror="alert(2)"><a href="javascript:alert(3)">Open</a><iframe src="https://bad.example"></iframe></td></tr></table>' });
  for (const forbidden of ["<script", "<style", "onerror", "javascript:", "<iframe", "background-image"]) assert.ok(!campaign.html.includes(forbidden));
  assert.ok(campaign.html.includes("<table")); assert.ok(campaign.html.includes("color:#123456")); assert.ok(campaign.html.includes("https://example.com/a.png"));
});
test("draft saving never sends and list payload excludes large template bodies", async () => {
  const campaign = await draft(); assert.equal(campaign.status, "draft");
  const state = ok(await api("state")); assert.equal(state.campaigns[0].html, ""); assert.equal(sends().length, 0);
  assert.ok(ok(await api(`campaigns/${campaign.id}`)).campaign.html.includes("Hello"));
});
test("launch requires consent, valid groups, enabled accounts and mailing address", async () => {
  await configured(); const acc = await account(), g = await group(), campaign = await draft();
  const body = { revision: campaign.revision, groupIds: [g.id], accountIds: [acc.id], intervalSeconds: 5 };
  assert.equal((await api(`campaigns/${campaign.id}/launch`, body)).status, 400);
  db.sqlite.exec("UPDATE marketing_settings SET postal_address=''");
  assert.equal((await api(`campaigns/${campaign.id}/launch`, { ...body, acknowledgeConsent: true })).status, 409); assert.equal(sends().length, 0);
});
test("overlapping selected groups deduplicate each address in a launched campaign", async () => {
  await configured(); const acc = await account(), g1 = await group(3), g2 = await group(3), campaign = await draft();
  const launched = ok(await api(`campaigns/${campaign.id}/launch`, { revision: campaign.revision, groupIds: [g1.id, g2.id], accountIds: [acc.id], intervalSeconds: 5, acknowledgeConsent: true })).campaign;
  assert.equal(launched.recipientCount, 3); assert.equal(sends().length, 0);
});
test("a launched campaign is immutable and cannot be launched twice", async () => {
  const { campaign, group: g, accounts } = await prepared();
  assert.equal((await api("campaigns", { id: campaign.id, revision: campaign.revision, subject: "Changed" })).status, 409);
  assert.equal((await api(`campaigns/${campaign.id}/launch`, { revision: campaign.revision, groupIds: [g.id], accountIds: [accounts[0].id], intervalSeconds: 5, acknowledgeConsent: true })).status, 409);
  const copy = ok(await api(`campaigns/${campaign.id}/duplicate`, {})).campaign; assert.equal(copy.status, "draft"); assert.notEqual(copy.id, campaign.id);
});
test("campaign rotation alternates enabled accounts and honors interval", async () => {
  const { campaign, accounts } = await prepared(3, 1);
  await queue(); assert.equal(sends().length, 1); assert.equal(sends()[0].body.account.username, accounts[0].username);
  await queue(); assert.equal(sends().length, 1);
  due(campaign.id); await queue(); assert.equal(sends().length, 2); assert.equal(sends()[1].body.account.username, accounts[1].username);
  due(campaign.id); await queue(); assert.equal(sends().length, 3); assert.equal(sends()[2].body.account.username, accounts[0].username);
  const result = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(result.status, "completed"); assert.equal(result.summary.accepted, 3);
});
test("scheduled campaign does not send before its start time", async () => {
  await prepared(1, 0, { scheduledAt: Date.now() + 60_000 });
  assert.equal((await queue()).advanced, 0); assert.equal(sends().length, 0);
});
test("recipient substitutions are escaped in HTML", async () => {
  const { campaign } = await prepared(1);
  db.sqlite.prepare("UPDATE marketing_recipients SET name=? WHERE campaign_id=?").run('<img src=x onerror="alert(1)">', campaign.id);
  db.sqlite.prepare("UPDATE marketing_campaigns SET html='<p>{{name}}</p>' WHERE id=?").run(campaign.id);
  await queue(); assert.ok(sends()[0].body.message.html.includes("&lt;img")); assert.ok(!sends()[0].body.message.html.includes("<img"));
});
test("parallel worker requests claim a campaign only once", async () => {
  await prepared(2);
  let release, reached;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  handler = async url => { assert.equal(url.pathname, "/v1/send"); reached(); await pending; return Response.json({ status: "accepted" }); };
  const first = queue(); await ready;
  const second = await queue(); assert.equal(second.advanced, 0); assert.equal(sends().length, 1);
  release(); await first;
});
test("shared-account daily cap applies across distinct campaigns", async () => {
  const { campaign, accounts, group: g } = await prepared(2);
  db.sqlite.prepare("UPDATE smtp_accounts SET daily_limit=1 WHERE id=?").run(accounts[0].id);
  const secondDraft = await draft();
  const second = ok(await api(`campaigns/${secondDraft.id}/launch`, { revision: secondDraft.revision, groupIds: [g.id], accountIds: [accounts[0].id], intervalSeconds: 1, acknowledgeConsent: true })).campaign;
  await Promise.all([queue({ campaignId: campaign.id }), queue({ campaignId: second.id })]);
  assert.equal(sends().length, 1); assert.equal(db.sqlite.prepare("SELECT sent_today FROM smtp_accounts WHERE id=?").get(accounts[0].id).sent_today, 1);
});
test("shared-account minimum interval prevents another campaign from sending early", async () => {
  const { accounts, group: g, campaign } = await prepared(1);
  const draft2 = await draft(), second = ok(await api(`campaigns/${draft2.id}/launch`, { revision: draft2.revision, groupIds: [g.id], accountIds: [accounts[0].id], intervalSeconds: 1, acknowledgeConsent: true })).campaign;
  await queue({ campaignId: campaign.id }); await queue({ campaignId: second.id });
  assert.equal(sends().length, 1);
});
test("disabled accounts are excluded without selecting a different unapproved account", async () => {
  const { campaign, accounts } = await prepared(1, 1);
  ok(await api(`accounts/${accounts[0].id}/toggle`, { revision: accounts[0].revision, enabled: false }));
  await queue(); assert.equal(sends().length, 1); assert.equal(sends()[0].body.account.username, accounts[1].username);
  assert.equal(ok(await api(`campaigns/${campaign.id}`)).campaign.status, "completed");
});
test("credential rotation after launch pauses use of the changed account", async () => {
  const { campaign, accounts } = await prepared(1);
  ok(await api("accounts", { id: accounts[0].id, revision: accounts[0].revision, password: "replacement", enabled: false }));
  await queue(); assert.equal(sends().length, 0); assert.equal(ok(await api(`campaigns/${campaign.id}`)).campaign.status, "needs_attention");
});
test("relay replacement after launch never sends original credentials to a new service", async () => {
  const { campaign } = await prepared(1);
  db.sqlite.exec("UPDATE marketing_settings SET credential_revision=credential_revision+1");
  await queue(); assert.equal(sends().length, 0); assert.equal(ok(await api(`campaigns/${campaign.id}`)).campaign.status, "needs_attention");
});
test("campaign pause, cancellation and contact suppression are rechecked after DNS", async () => {
  const { campaign } = await prepared(1);
  dnsHandler = () => { db.sqlite.prepare("UPDATE marketing_campaigns SET status='paused' WHERE id=?").run(campaign.id); return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }); };
  await queue(); assert.equal(sends().length, 0);
  const result = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(result.status, "paused"); assert.equal(result.summary.pending, 1);
});
test("suppression after launch excludes the contact before SMTP", async () => {
  const { campaign } = await prepared(1); db.sqlite.exec("UPDATE marketing_contacts SET suppressed=1");
  await queue(); assert.equal(sends().length, 0);
  const result = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(result.summary.suppressed, 1); assert.equal(result.status, "completed");
});
test("relay unsubscribe outcome suppresses the stored contact", async () => {
  const { campaign } = await prepared(1); handler = () => Response.json({ status: "suppressed" });
  await queue(); assert.equal(db.sqlite.prepare("SELECT suppressed FROM marketing_contacts").get().suppressed, 1); assert.equal(ok(await api(`campaigns/${campaign.id}`)).campaign.summary.suppressed, 1);
});
test("unknown SMTP result stops the run and is never rotated to another account", async () => {
  const { campaign } = await prepared(2, 1); handler = () => { throw new Error("network timeout, secret material must not leak"); };
  await queue(); assert.equal(sends().length, 1);
  let current = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(current.status, "needs_attention"); assert.equal(current.summary.unknown, 1); assert.equal(current.summary.pending, 1);
  due(campaign.id); await queue(); assert.equal(sends().length, 1);
  current = ok(await api(`campaigns/${campaign.id}/resume`, { revision: current.revision })).campaign;
  handler = () => Response.json({ status: "accepted" }); due(campaign.id); await queue();
  assert.equal(sends().length, 2); assert.notEqual(sends()[0].body.deliveryId, sends()[1].body.deliveryId); assert.equal(ok(await api(`campaigns/${campaign.id}`)).campaign.summary.unknown, 1);
});
test("definitive SMTP rejection pauses remaining audience instead of exhausting it", async () => {
  const { campaign } = await prepared(5); handler = () => Response.json({ status: "failed", code: "smtp_auth" });
  await queue(); await queue(); assert.equal(sends().length, 1);
  const current = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(current.status, "needs_attention"); assert.equal(current.summary.pending, 4);
});
test("recovered sending intent becomes unknown without SMTP replay", async () => {
  const { campaign } = await prepared(2);
  db.sqlite.prepare("UPDATE marketing_recipients SET status='sending',attempted_at=0 WHERE id=(SELECT id FROM marketing_recipients WHERE campaign_id=? LIMIT 1)").run(campaign.id);
  await queue(); assert.equal(sends().length, 0); const current = ok(await api(`campaigns/${campaign.id}`)).campaign; assert.equal(current.status, "needs_attention"); assert.equal(current.summary.unknown, 1);
});
test("explicit cancel leaves unsent recipients without provider calls", async () => {
  const { campaign } = await prepared(); ok(await api(`campaigns/${campaign.id}/cancel`, { revision: campaign.revision }));
  due(campaign.id); assert.equal((await queue()).advanced, 0); assert.equal(sends().length, 0);
});
test("test email sends exactly once for the same request ID", async () => {
  await configured(); const acc = await account(), campaign = await draft(), requestId = crypto.randomUUID(); calls = [];
  const payload = { accountId: acc.id, email: "test@example.net", requestId };
  const sent = ok(await api(`campaigns/${campaign.id}/test`, payload)); assert.equal(sent.delivery.status, "accepted");
  const replay = ok(await api(`campaigns/${campaign.id}/test`, payload)); assert.equal(replay.delivery.id, sent.delivery.id); assert.equal(sends().length, 1);
  assert.equal((await api(`campaigns/${campaign.id}/test`, { ...payload, email: "different@example.net" })).status, 409);
});
test("uncertain test result is persisted and not retried", async () => {
  await configured(); const acc = await account(), campaign = await draft(), payload = { accountId: acc.id, email: "test@example.net", requestId: crypto.randomUUID() }; calls = [];
  handler = () => { throw new Error("timed out"); };
  assert.equal(ok(await api(`campaigns/${campaign.id}/test`, payload)).delivery.status, "unknown");
  assert.equal(ok(await api(`campaigns/${campaign.id}/test`, payload)).delivery.status, "unknown"); assert.equal(sends().length, 1);
});
test("worker requires the independent fingerprint and accepts only empty body", async () => {
  const workerToken = "synthetic-worker-token-not-used-outside-tests";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workerToken))).toString("hex");
  const worker = (headers, body = {}) => handleMarketingWorker(new Request("https://app.example.com/api/marketing/worker", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), { db, masterKey: key, workerTokenHash: hash, fetch: fetchMock });
  assert.equal((await worker({})).status, 401); assert.equal((await worker({ "X-Marketing-Worker-Token": "bad" })).status, 401);
  assert.equal((await worker({ "X-Marketing-Worker-Token": workerToken }, { owner: "alice" })).status, 400);
  const response = await worker({ "X-Marketing-Worker-Token": workerToken }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.advanced, 0); noSecrets(result);
});
test("cross-site writes and missing owner are rejected", async () => {
  assert.equal((await api("groups", { name: "Bad" }, { headers: { Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await api("state", undefined, { owner: "" })).status, 401);
});
test("full HTML documents omit head/title text from outgoing content", async () => {
  const campaign = await draft("alice", { html: '<!doctype html><html><head><title>Internal title</title><style>p{color:red}</style></head><body><p>Actual email</p></body></html>' });
  assert.equal(campaign.html, "<p>Actual email</p>");
});
test("business mailing address accepts and normalizes ordinary line breaks", async () => {
  const saved = ok(await api("settings", { revision: 0, relayUrl: "https://relay.example.com", relayToken: token, postalAddress: "1 Example Avenue\r\nLagos, Nigeria" })).settings;
  assert.equal(saved.postalAddress, "1 Example Avenue\nLagos, Nigeria");
});
test("test message subject uses the same personalization as a live campaign", async () => {
  await configured(); const acc = await account(), campaign = await draft(); calls = [];
  ok(await api(`campaigns/${campaign.id}/test`, { accountId: acc.id, email: "test@example.net", requestId: crypto.randomUUID() }));
  assert.equal(sends()[0].body.message.subject, "[Test] Hello there");
});
test("test sending honors a manually suppressed contact", async () => {
  await configured(); const acc = await account(), campaign = await draft(); await group(1); calls = [];
  db.sqlite.exec("UPDATE marketing_contacts SET suppressed=1");
  const result = ok(await api(`campaigns/${campaign.id}/test`, { accountId: acc.id, email: "person0@example.net", requestId: crypto.randomUUID() }));
  assert.equal(result.delivery.status, "suppressed"); assert.equal(sends().length, 0);
});
test("test sending rechecks account deletion during DNS", async () => {
  await configured(); const acc = await account(), campaign = await draft(); calls = [];
  dnsHandler = () => { db.sqlite.prepare("UPDATE smtp_accounts SET deleted_at=? WHERE id=?").run(Date.now(), acc.id); return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }); };
  const result = ok(await api(`campaigns/${campaign.id}/test`, { accountId: acc.id, email: "test@example.net", requestId: crypto.randomUUID() }));
  assert.equal(result.delivery.status, "failed"); assert.equal(sends().length, 0);
  assert.equal(db.sqlite.prepare("SELECT send_lease_until FROM smtp_accounts WHERE id=?").get(acc.id).send_lease_until, null);
});
test("test sending rechecks relay generation during DNS", async () => {
  await configured(); const acc = await account(), campaign = await draft(); calls = [];
  dnsHandler = () => { db.sqlite.exec("UPDATE marketing_settings SET credential_revision=credential_revision+1"); return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }); };
  const result = ok(await api(`campaigns/${campaign.id}/test`, { accountId: acc.id, email: "test@example.net", requestId: crypto.randomUUID() }));
  assert.equal(result.delivery.status, "failed"); assert.equal(sends().length, 0);
});
test("test sending rechecks a newly suppressed contact after DNS", async () => {
  await configured(); const acc = await account(), campaign = await draft(); await group(1); calls = [];
  dnsHandler = () => { db.sqlite.exec("UPDATE marketing_contacts SET suppressed=1"); return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }); };
  const result = ok(await api(`campaigns/${campaign.id}/test`, { accountId: acc.id, email: "person0@example.net", requestId: crypto.randomUUID() }));
  assert.equal(result.delivery.status, "failed"); assert.equal(sends().length, 0);
});
test("account in-flight lease prevents overlapping sends after the original interval passes", async () => {
  const { campaign, accounts, group: g } = await prepared(2);
  const draft2 = await draft(), second = ok(await api(`campaigns/${draft2.id}/launch`, { revision: draft2.revision, groupIds: [g.id], accountIds: [accounts[0].id], intervalSeconds: 1, acknowledgeConsent: true })).campaign;
  let release, reached;
  const pending = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  handler = async () => { reached(); await pending; return Response.json({ status: "accepted" }); };
  const originalNow = Date.now;
  let current = originalNow();
  Date.now = () => current;
  try {
    const first = queue({ campaignId: campaign.id }); await ready;
    current += 60_000; // SMTP is still in flight long after the 5-second spacing passed.
    await queue({ campaignId: second.id }); assert.equal(sends().length, 1);
    release(); await first;
    const accountRow = db.sqlite.prepare("SELECT * FROM smtp_accounts WHERE id=?").get(accounts[0].id);
    assert.equal(accountRow.send_lease_until, null); assert.ok(accountRow.next_available_at >= current + 5_000);
    const campaignRow = db.sqlite.prepare("SELECT * FROM marketing_campaigns WHERE id=?").get(campaign.id);
    assert.ok(campaignRow.next_send_at >= current + 10_000);
    await queue({ campaignId: campaign.id }); assert.equal(sends().length, 1);
  } finally { Date.now = originalNow; release(); }
});
test("SMTP account pages expose all configured accounts without a total-account cap", async () => {
  const now = Date.now(), values = Array.from({ length: 105 }, (_, i) => [crypto.randomUUID(), `Account ${i}`, now + i]);
  db.sqlite.prepare("INSERT INTO smtp_accounts(id,owner,label,host,port,security,username,password_ciphertext,from_email,created_at,updated_at) SELECT json_extract(value,'$[0]'),'alice',json_extract(value,'$[1]'),'smtp.example.com',587,'starttls','user','encrypted-placeholder','sender@example.net',json_extract(value,'$[2]'),json_extract(value,'$[2]') FROM json_each(?)").run(JSON.stringify(values));
  const state = ok(await api("state")); assert.equal(state.accounts.length, 100); assert.ok(state.accountsCursor);
  const second = ok(await api(`accounts?cursor=${encodeURIComponent(state.accountsCursor)}`)); assert.equal(second.accounts.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...state.accounts, ...second.accounts].map(a => a.id)).size, 105);
});
test("personalization cannot turn a saved relative link into an active URL", async () => {
  const { campaign } = await prepared(1);
  db.sqlite.prepare("UPDATE marketing_recipients SET name='javascript:alert(1)' WHERE campaign_id=?").run(campaign.id);
  db.sqlite.prepare("UPDATE marketing_campaigns SET html='<a href=\"{{name}}\">Visit</a>' WHERE id=?").run(campaign.id);
  await queue(); assert.equal(sends().length, 1); assert.ok(!sends()[0].body.message.html.includes("javascript:"));
});
