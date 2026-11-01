import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as MockResponse } from "miniflare";

// Exercise the real adapter inside workerd. Node's mocked fetch accepts options
// that the production Workers runtime rejects before making a request.
// All outbound traffic is intercepted locally; no real provider call is possible.
const root = fileURLToPath(new URL("../", import.meta.url));
const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
const compatibilityDate = viteConfig.match(/compatibility_date:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
assert.ok(compatibilityDate, "use the same compatibility date as the deployed app");
const bundled = await build({
  stdin: {
    resolveDir: root,
    sourcefile: "termii-runtime-regression.ts",
    loader: "ts",
    contents: `
      import { getBalance, getSenderIds, requestSenderId, sendBulk, sendWhatsAppTemplate, ProviderError } from "./app/lib/termii.ts";
      const config = { baseUrl: "https://v4.api.termii.com", apiKey: "fake-worker-test-key-no-network" };
      export default {
        async fetch(request) {
          const operation = new URL(request.url).pathname;
          try {
            const result = operation === "/balance" ? await getBalance(config)
              : operation === "/sender-ids" ? await getSenderIds(config)
              : operation === "/sender-id-request" ? await requestSenderId(config, {
                senderId: "Trezad", company: "Trezad Community", useCase: "Hello Ada, your community update is ready."
              })
              : operation === "/sms" ? await sendBulk(config, {
                phones: ["2348000000000"], senderId: "Trezad", message: "Local test only", channel: "generic"
              })
              : await sendWhatsAppTemplate(config, {
                phone: "2348000000000", deviceId: "test_device", templateId: "test_template", data: { name: "Test" }
              });
            return Response.json(result);
          } catch (error) {
            if (!(error instanceof ProviderError)) throw error;
            return Response.json({
              error: error.message, outcome: error.outcome, operation: error.operation,
              reason: error.reason, upstreamStatus: error.upstreamStatus
            }, { status: 502 });
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
let calls;
let respond;

before(async () => {
  runtime = new Miniflare({
    modules: true,
    compatibilityDate,
    script: bundled.outputFiles[0].text,
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ url, method: request.method, body: request.method === "POST" ? await request.json() : undefined });
      // This service is the only outbound destination. A followed redirect is
      // still local and is observable as an extra call rather than real traffic.
      if (url.pathname === "/unexpected-redirect") return MockResponse.json({ code: "ok", message_id: "unexpected-replay" });
      return respond();
    },
  });
  await runtime.ready;
});

beforeEach(() => { calls = []; });
after(async () => { await runtime?.dispose(); });

test("saved-connection balance checks succeed through the actual Workers fetch implementation", async () => {
  respond = () => MockResponse.json({ balance: "1234.50", currency: "NGN" });
  const result = await runtime.dispatchFetch("http://localhost/balance");
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { balance: 1234.5, currency: "NGN" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, "/api/get-balance");
  assert.equal(calls[0].url.searchParams.get("api_key"), "fake-worker-test-key-no-network");
  assert.equal(calls[0].body, undefined);
});

test("sender IDs are read in Workers without requesting an undocumented next page", async () => {
  respond = () => MockResponse.json({
    content: [{ sender_id: "Trezad", country: "Nigeria", status: "active" }],
    totalElements: 16, totalPages: 2, first: true, last: false, number: 0,
  });
  const result = await runtime.dispatchFetch("http://localhost/sender-ids");
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), {
    senderIds: [{ senderId: "Trezad", country: "Nigeria", status: "active", createdAt: null }], complete: false, total: 16,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, "/api/sender-id");
  assert.deepEqual([...calls[0].url.searchParams.keys()], ["api_key"]);
  assert.equal(calls[0].body, undefined);
});

test("sender-ID approval submits the documented payload once in Workers", async () => {
  respond = () => MockResponse.json({ code: "ok", message: "Untrusted provider text" });
  const result = await runtime.dispatchFetch("http://localhost/sender-id-request");
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { submitted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.pathname, "/api/sender-id/request");
  assert.deepEqual(calls[0].body, {
    api_key: "fake-worker-test-key-no-network", sender_id: "Trezad", company: "Trezad Community",
    use_case: "Hello Ada, your community update is ready.",
  });
});

for (const submission of [
  { route: "sms", path: "/api/sms/send/bulk", operation: "sms_submit" },
  { route: "whatsapp", path: "/api/send/template", operation: "whatsapp_submit" },
]) {
  test(`${submission.route} submissions work in Workers and contact the mock exactly once`, async () => {
    respond = () => MockResponse.json({ code: "ok", message_id: "runtime-test-id" });
    const result = await runtime.dispatchFetch(`http://localhost/${submission.route}`);
    assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual(await result.json(), { providerId: "runtime-test-id" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.pathname, submission.path);
    assert.equal(calls[0].body.api_key, "fake-worker-test-key-no-network");
  });
}

for (const operation of [
  { route: "balance", name: "balance", status: 302 },
  { route: "sms", name: "sms_submit", status: 307 },
  { route: "whatsapp", name: "whatsapp_submit", status: 307 },
  { route: "sender-ids", name: "sender_ids", status: 302 },
  { route: "sender-id-request", name: "sender_id_request", status: 307 },
]) {
  test(`Workers does not follow a ${operation.route} redirect or replay the request`, async () => {
    respond = () => new MockResponse(null, {
      status: operation.status,
      headers: { Location: "https://v4.api.termii.com/unexpected-redirect" },
    });
    const result = await runtime.dispatchFetch(`http://localhost/${operation.route}`);
    assert.equal(result.status, 502);
    const failure = await result.json();
    assert.equal(failure.operation, operation.name);
    assert.equal(failure.reason, "redirect");
    assert.equal(failure.outcome, "unknown");
    assert.equal(failure.upstreamStatus, operation.status);
    assert.equal(calls.length, 1, "redirects must not cause another request");
    if (operation.route === "balance" || operation.route === "sender-ids") assert.match(failure.error, /does not send messages/);
    else if (operation.route === "sender-id-request") assert.match(failure.error, /Check the sender-ID list before retrying/);
    else assert.match(failure.error, /Check provider history before sending again/);
  });
}
