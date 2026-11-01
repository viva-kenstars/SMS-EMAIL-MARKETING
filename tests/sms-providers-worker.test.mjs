import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as MockResponse } from "miniflare";

// This exercises the real provider registry and fetch implementation inside
// workerd. The outbound service intercepts every request, including redirects;
// none of these tests can send a message or access a real provider account.
const root = fileURLToPath(new URL("../", import.meta.url));
const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
const compatibilityDate = viteConfig.match(/compatibility_date:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
assert.ok(compatibilityDate, "match the deployed application's runtime date");
const accountSid = `AC${"a".repeat(32)}`;
const messageSid = `SM${"b".repeat(32)}`;
const phone = "+2348012345678";
const bundled = await build({
  stdin: {
    resolveDir: root, sourcefile: "sms-providers-runtime-regression.ts", loader: "ts",
    contents: `
      import { smsAdapter, submitSms } from "./app/lib/sms-providers/index.ts";
      import { ProviderError } from "./app/lib/termii.ts";
      const credentials = {
        bulksmsnigeria: { apiToken: "fake-bsng-runtime-token" },
        smartsmssolutions: { apiToken: "fake-smart-runtime-token" },
        sendchamp: { apiToken: "fake-sendchamp-runtime-token" },
        africastalking: { username: "runtime_test_app", apiKey: "fake-at-runtime-token" },
        twilio: { accountSid: "${accountSid}", authToken: "fake-twilio-runtime-token" },
        vonage: { apiKey: "abc12345", apiSecret: "fake-vonage-runtime-token" }
      };
      export default {
        async fetch(request) {
          const url = new URL(request.url);
          const [, provider, operation] = url.pathname.split("/");
          try {
            const adapter = smsAdapter(provider);
            const result = operation === "balance" ? await adapter.balance(credentials[provider])
              : operation === "reports" ? await adapter.reports(credentials[provider], "${messageSid}")
              : await submitSms(provider, credentials[provider], {
                phones: ["${phone}"], senderId: url.searchParams.get("sender") || "Trezad",
                message: "Local runtime test only.", channel: "generic"
              });
            return Response.json(result);
          } catch (error) {
            if (!(error instanceof ProviderError)) throw error;
            return Response.json({ error: error.message, outcome: error.outcome,
              operation: error.operation, reason: error.reason, upstreamStatus: error.upstreamStatus }, { status: 502 });
          }
        }
      }`,
  },
  bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
});

const providers = [
  { id: "bulksmsnigeria", host: "www.bulksmsnigeria.com", balancePath: "/api/v2/balance", balanceMethod: "GET", sendPath: "/api/v2/sms", currency: "NGN", unit: "money",
    balanceResponse: { data: { status: "success" }, balance: { total_balance: "123.45" } },
    sendResponse: { status: "success", code: "BSNG-0000", data: { message_id: "bsng-runtime-id", recipients_count: 1, gateway_used: "direct-refund", skipped_recipients: [] } } },
  { id: "smartsmssolutions", host: "app.smartsmssolutions.com", balancePath: "/io/api/client/v1/balance/", balanceMethod: "GET", sendPath: "/io/api/client/v1/sms/", currency: "credits", unit: "credits",
    balanceResponse: 123.45,
    sendResponse: { code: 1000, successful: phone.slice(1), message_id: "smart-runtime-id" } },
  { id: "sendchamp", host: "api.sendchamp.com", balancePath: "/api/v1/wallet/wallet_balance", balanceMethod: "POST", sendPath: "/api/v1/sms/send", currency: "NGN", unit: "money",
    balanceResponse: { code: 200, status: "success", data: { available_balance: "123.45", currency: "NGN" } },
    sendResponse: { code: 200, status: "success", data: { id: "sendchamp-runtime-id", phone_number: phone.slice(1), status: "processing" } } },
  { id: "africastalking", host: "api.africastalking.com", balancePath: "/version1/user", balanceMethod: "GET", sendPath: "/version1/messaging", currency: "NGN", unit: "money",
    balanceResponse: { UserData: { balance: "NGN 123.45" } },
    sendResponse: { SMSMessageData: { Recipients: [{ number: phone, statusCode: 102, messageId: "ATXid_runtime_id" }] } } },
  { id: "twilio", host: "api.twilio.com", balancePath: `/2010-04-01/Accounts/${accountSid}/Balance.json`, balanceMethod: "GET", sendPath: `/2010-04-01/Accounts/${accountSid}/Messages.json`, currency: "USD", unit: "money",
    balanceResponse: { account_sid: accountSid, balance: "123.45", currency: "USD" },
    sendResponse: { account_sid: accountSid, sid: messageSid, to: phone, status: "queued" } },
  { id: "vonage", host: "rest.nexmo.com", balancePath: "/account/get-balance", balanceMethod: "GET", sendPath: "/sms/json", currency: "EUR", unit: "money",
    balanceResponse: { value: 123.45, autoReload: false },
    sendResponse: { "message-count": "1", messages: [{ to: phone.slice(1), "message-id": "0A0000001234567B", status: "0" }] } },
];

let runtime;
let calls = [];
let respond = () => { throw new Error("Unconfigured mock outbound request"); };

before(async () => {
  runtime = new Miniflare({
    modules: true, compatibilityDate, script: bundled.outputFiles[0].text,
    outboundService: async request => {
      const contentType = request.headers.get("content-type") || "";
      let body;
      if (request.method === "POST") {
        if (contentType.includes("application/json")) body = await request.json();
        else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(await request.formData());
        else body = await request.text();
      }
      const call = { url: new URL(request.url), method: request.method, headers: request.headers, contentType, body };
      calls.push(call);
      if (call.url.pathname === "/unexpected-redirect") return MockResponse.json({ unsafe: "redirect was followed" });
      return respond(call);
    },
  });
  await runtime.ready;
});
beforeEach(() => { calls = []; });
after(async () => { await runtime?.dispose(); });

for (const provider of providers) {
  test(`${provider.id} balance works with actual Workers fetch and returns the provider's units`, async () => {
    respond = () => MockResponse.json(provider.balanceResponse);
    const response = await runtime.dispatchFetch(`http://localhost/${provider.id}/balance`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { balance: 123.45, currency: provider.currency, unit: provider.unit });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.protocol, "https:");
    assert.equal(calls[0].url.hostname, provider.host);
    assert.equal(calls[0].url.pathname, provider.balancePath);
    assert.equal(calls[0].method, provider.balanceMethod);
    assert.equal(calls[0].headers.get("Accept"), "application/json");
    if (provider.id === "africastalking") {
      assert.equal(calls[0].url.searchParams.get("username"), "runtime_test_app");
      assert.equal(calls[0].headers.get("apiKey"), "fake-at-runtime-token");
    }
    if (provider.id === "twilio") assert.equal(calls[0].headers.get("Authorization"), `Basic ${btoa(`${accountSid}:fake-twilio-runtime-token`)}`);
    if (provider.id === "vonage") assert.equal(calls[0].headers.get("Authorization"), `Basic ${btoa("abc12345:fake-vonage-runtime-token")}`);
  });

  test(`${provider.id} submits its documented body once through the real Workers runtime`, async () => {
    respond = () => MockResponse.json(provider.sendResponse);
    const response = await runtime.dispatchFetch(`http://localhost/${provider.id}/send`);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.length, 1);
    assert.equal(result[0].phone, phone);
    assert.equal(result[0].status, "accepted");
    assert.ok(result[0].providerId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.hostname, provider.host);
    assert.equal(calls[0].url.pathname, provider.sendPath);
    assert.equal(calls[0].method, "POST");
    if (provider.id === "smartsmssolutions") {
      assert.match(calls[0].contentType, /^multipart\/form-data; boundary=/);
      assert.equal(calls[0].body.token, "fake-smart-runtime-token");
      assert.equal(calls[0].body.routing, "2");
      assert.equal(calls[0].body.to, phone.slice(1));
    }
    if (provider.id === "africastalking") {
      assert.equal(calls[0].body.username, "runtime_test_app");
      assert.equal(calls[0].body.bulkSMSMode, "1");
      assert.equal(calls[0].body.to, phone);
    }
    if (provider.id === "twilio") assert.equal(calls[0].body.To, phone);
    if (provider.id === "vonage") assert.equal(calls[0].body.to, phone.slice(1));
    if (provider.id === "bulksmsnigeria") assert.equal(calls[0].body.gateway, "direct-refund");
    if (provider.id === "sendchamp") assert.deepEqual(calls[0].body.to, [phone.slice(1)]);
  });

  test(`${provider.id} does not follow a balance redirect or forward its credentials`, async () => {
    respond = () => new MockResponse(null, { status: 302, headers: { Location: "https://different.example/unexpected-redirect" } });
    const response = await runtime.dispatchFetch(`http://localhost/${provider.id}/balance`);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.reason, "redirect");
    assert.equal(result.operation, "balance");
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fake-.*token|different\.example/);
  });

  test(`${provider.id} does not replay a redirected SMS submission`, async () => {
    respond = () => new MockResponse(null, { status: 307, headers: { Location: "https://different.example/unexpected-redirect" } });
    const response = await runtime.dispatchFetch(`http://localhost/${provider.id}/send`);
    const result = await response.json();
    if (response.status === 502) {
      assert.equal(result.outcome, "unknown");
      assert.equal(result.reason, "redirect");
    } else {
      assert.equal(response.status, 200);
      assert.equal(result[0].status, "unknown");
    }
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fake-.*token|different\.example/);
  });
}

test("Twilio report lookup uses Basic auth and matches message and account IDs in Workers", async () => {
  respond = () => MockResponse.json({ ...providers.find(provider => provider.id === "twilio").sendResponse, status: "delivered" });
  const response = await runtime.dispatchFetch("http://localhost/twilio/reports");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), [{ phone, providerId: messageSid, status: "delivered" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, `/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`);
});

for (const [id, sender, field, expected] of [
  ["twilio", "+14155552671", "From", "+14155552671"],
  ["vonage", "+447700900000", "from", "447700900000"],
]) {
  test(`${id} accepts the numeric sender advertised by the catalog in Workers`, async () => {
    respond = () => MockResponse.json(providers.find(provider => provider.id === id).sendResponse);
    const response = await runtime.dispatchFetch(`http://localhost/${id}/send?sender=${encodeURIComponent(sender)}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json())[0].status, "accepted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body[field], expected);
  });
}
