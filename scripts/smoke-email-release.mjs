/** Exercises the built deployment artifact in actual workerd with an isolated D1. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(join(root, "dist/server/wrangler.json"), "utf8"));
const token = "synthetic-release-worker-token-never-sent";
const master = Buffer.alloc(32, 47).toString("base64");
const password = "synthetic-smtp-password-never-sent";
let outbound = 0, checks = 0;
const serverDirectory = join(root, "dist/server");
const moduleFiles = (await readdir(serverDirectory, { recursive: true })).filter(file => file.endsWith(".js") && file !== config.main);
const runtime = new Miniflare({
  modulesRoot: serverDirectory,
  modules: [config.main, ...moduleFiles].map(file => ({ type: "ESModule", path: join(serverDirectory, file) })),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  d1Databases: ["DB"],
  bindings: { SMS_SETTINGS_ENCRYPTION_KEY: master, EMAIL_WORKER_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"), APP_ORIGIN: "https://runtime.trezad.test" },
  assets: { directory: join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
  outboundService: () => { outbound++; throw new Error("External network access is blocked in release verification."); },
});
async function api(path, body, { owner = "release-fixture", status = 200, headers = {} } = {}) {
  const response = await runtime.dispatchFetch(`https://runtime.trezad.test/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(owner ? { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": "fixture@example.net" } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: "https://runtime.trezad.test" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(text, `${path}: expected JSON, received empty HTTP ${response.status}`);
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 500)}`); }
  assert.equal(response.status, status, JSON.stringify(value));
  assert.ok(!JSON.stringify(value).includes(password), "saved SMTP secret must not appear in API output");
  assert.ok(!JSON.stringify(value).includes(master), "master key must not appear in API output");
  return value;
}
try {
  await runtime.ready;
  const db = await runtime.getD1Database("DB");
  for (const name of (await readdir(join(root, "drizzle"))).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    for (const statement of (await readFile(join(root, "drizzle", name), "utf8")).split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await api("marketing/state", undefined, { owner: null, status: 401 }); checks++;
  const state = await api("marketing/state");
  assert.equal(state.settings.configurationAvailable, true); assert.equal(state.accounts.length, 0); checks++;
  const saved = await api("marketing/accounts", { revision: 0, label: "Runtime fixture", host: "smtp.example.net", port: 587, security: "starttls", username: "fixture", password, fromEmail: "fixture@example.net", fromName: "Fixture", replyTo: "", dailyLimit: 100, minIntervalSeconds: 5 }, { status: 201 });
  assert.equal(saved.account.enabled, false); assert.equal(saved.account.verifiedAt, null); checks++;
  const accountRow = await db.prepare("SELECT password_ciphertext FROM smtp_accounts WHERE id=?").bind(saved.account.id).first();
  assert.match(accountRow.password_ciphertext, /^v1:/); assert.ok(!accountRow.password_ciphertext.includes(password)); checks++;
  const draft = await api("marketing/campaigns", { revision: 0, name: "Runtime draft", subject: "Fixture subject", preheader: "Fixture preview", html: '<script>alert(1)</script><p style="color:#0969da">Hello</p><img src="https://example.net/logo.png" onerror="alert(2)">', text: "Hello" }, { status: 201 });
  assert.equal(draft.campaign.status, "draft"); assert.ok(!draft.campaign.html.includes("script")); assert.ok(!draft.campaign.html.includes("onerror")); assert.ok(draft.campaign.html.includes("#0969da")); checks++;
  await api(`marketing/campaigns/${draft.campaign.id}`, undefined, { owner: "different-fixture", status: 404 }); checks++;
  const group = await api("marketing/groups", { name: "Runtime group" }, { status: 201 });
  assert.equal(group.group.contactCount, 0); checks++;
  await api("marketing/worker", {}, { owner: null, status: 401 }); checks++;
  const result = await api("marketing/worker", {}, { owner: null, headers: { "X-Marketing-Worker-Token": token } });
  assert.equal(result.ok, true); assert.equal(result.advanced, 0); checks++;
  const report = await api("marketing/state"); assert.equal(report.runner.healthy, true); assert.equal(report.campaigns[0].status, "draft"); checks++;
  await api("marketing/worker", { owner: "different-fixture" }, { owner: null, status: 400, headers: { "X-Marketing-Worker-Token": token } }); checks++;
  const setup = await runtime.dispatchFetch("https://runtime.trezad.test/smtp-service-setup.html");
  assert.equal(setup.status, 200); assert.match(await setup.text(), /Download SMTP service package/); checks++;
  const archive = await runtime.dispatchFetch("https://runtime.trezad.test/downloads/trezad-smtp-service.zip");
  assert.equal(archive.status, 200); const bytes = new Uint8Array(await archive.arrayBuffer()); assert.deepEqual([...bytes.slice(0, 2)], [80, 75]); checks++;
  assert.equal(outbound, 0, "release verification must not contact a provider or send messages"); checks++;
  console.log(`PASS built Worker release verification (${checks} checks; zero external requests)`);
} finally { await runtime.dispose(); }
