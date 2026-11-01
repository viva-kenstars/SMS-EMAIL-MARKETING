import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
// @ts-ignore Node's native TypeScript runner resolves the source extension directly.
import { getBalance, getDeliveryReports, getSenderIds, ProviderError, requestSenderId, sendBulk, sendWhatsAppTemplate, validateBaseUrl, validateSenderIdRequest } from "../app/lib/termii.ts";

const config = { apiKey: "test-secret-not-a-real-credential", baseUrl: "https://api.ng.termii.com" };
const message = { phones: ["2348012345678"], senderId: "Trezad", message: "Hello", channel: "generic" as const };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error("Unexpected provider request blocked by the test harness"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

function isOutcome(outcome: "rejected" | "unknown") {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.outcome, outcome);
    assert.ok(["configuration", "balance", "delivery_reports", "sms_submit", "whatsapp_submit", "sender_ids", "sender_id_request"].includes(error.operation));
    assert.ok(["validation", "authentication", "rate_limited", "http_error", "timeout", "network_error", "redirect", "invalid_json", "invalid_response"].includes(error.reason));
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /test-secret|api\.ng\.termii|sensitive|recipient-body|redirect-target/);
    return true;
  };
}

test("base URLs are canonical HTTPS Termii origins", () => {
  assert.equal(validateBaseUrl("https://API.NG.TERMII.COM/"), "https://api.ng.termii.com");
  assert.equal(validateBaseUrl("https://termii.com"), "https://termii.com");
  assert.equal(validateBaseUrl("https://api.termii.ai"), "https://api.termii.ai");
});

test("base URL rejects external hosts, credentials, ports, paths, and URL normalization tricks", () => {
  for (const value of [
    "http://api.termii.com", "https://termii.com.evil.example", "https://eviltermii.com",
    "https://api.termii.com:443", "https://api.termii.com:8443", "https://user:pass@api.termii.com",
    "https://api.termii.com/path", "https://api.termii.com/a/..", "https://api.termii.com?",
    "https://api.termii.com?api_key=x", "https://api.termii.com#", "https://api.termii.com/#x",
    "https://api.termii.com\\x", "https://api..termii.com", "https://api.termii.com./", "not a URL",
  ]) assert.throws(() => validateBaseUrl(value), isOutcome("rejected"), value);
});

test("sendBulk accepts exactly 100 numbers and uses the documented payload without modifying text", async () => {
  const phones = Array.from({ length: 100 }, (_, index) => `234801234${String(index).padStart(4, "0")}`);
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), "https://api.ng.termii.com/api/sms/send/bulk");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      api_key: config.apiKey, to: phones, from: "Trezad", sms: "Ẹ káàrọ̀ 👋", type: "plain", channel: "dnd",
    });
    return Response.json({ code: "ok", message_id: "id_1", balance: 15.3 });
  }) as typeof fetch;
  assert.deepEqual(await sendBulk(config, { ...message, phones, message: "Ẹ káàrọ̀ 👋", channel: "dnd" }), { providerId: "id_1", balance: 15.3 });
  assert.equal(calls, 1);
});

test("empty and oversized batches are rejected before any provider request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("must not fetch"); }) as typeof fetch;
  await assert.rejects(sendBulk(config, { ...message, phones: [] }), isOutcome("rejected"));
  await assert.rejects(sendBulk(config, { ...message, phones: Array(101).fill("2348012345678") }), isOutcome("rejected"));
  assert.equal(calls, 0);
});

test("message validation rejects malformed recipients and invalid sender IDs", async () => {
  await assert.rejects(sendBulk(config, { ...message, phones: ["08012345678"] }), isOutcome("rejected"));
  await assert.rejects(sendBulk(config, { ...message, senderId: "sender-is-far-too-long" }), isOutcome("rejected"));
  await assert.rejects(sendBulk(config, { ...message, message: "  " }), isOutcome("rejected"));
});

test("long string message ID wins over rounded numeric message ID", async () => {
  respond({ code: "ok", message_id: 3017544054459083819856413, message_id_str: "3017544054459083819856413" });
  assert.equal((await sendBulk(config, message)).providerId, "3017544054459083819856413");
});

test("safe numeric IDs can be preserved but unsafe numeric IDs are unknown", async () => {
  respond({ code: "ok", message_id: 12345 });
  assert.equal((await sendBulk(config, message)).providerId, "12345");
  respond({ code: "ok", message_id: 9007199254740992 });
  await assert.rejects(sendBulk(config, message), isOutcome("unknown"));
});

test("success must have both an explicit ok code and an unambiguous ID", async () => {
  for (const body of [{ code: "ok" }, { message_id: "valid" }, { code: "failed", message_id: "valid" }, { code: "ok", message_id: "" }]) {
    respond(body);
    await assert.rejects(sendBulk(config, message), isOutcome("unknown"));
  }
});

test("HTTP 4xx rejection differs from ambiguous timeout and server outcomes", async () => {
  for (const [status, outcome] of [[401, "rejected"], [403, "rejected"], [422, "rejected"], [429, "rejected"], [408, "unknown"], [500, "unknown"], [503, "unknown"]] as const) {
    respond({ sensitive: config.apiKey }, status);
    await assert.rejects(sendBulk(config, message), isOutcome(outcome));
  }
});

test("timeout, network, and response parse failures stay unknown without exposing provider data", async () => {
  for (const failure of [new DOMException("sensitive timeout", "TimeoutError"), new Error(`sensitive ${config.apiKey} ${config.baseUrl}`)]) {
    globalThis.fetch = (async () => { throw failure; }) as typeof fetch;
    await assert.rejects(sendBulk(config, message), isOutcome("unknown"));
  }
  globalThis.fetch = (async () => new Response("sensitive recipient-body not JSON")) as typeof fetch;
  await assert.rejects(sendBulk(config, message), isOutcome("unknown"));
});

test("balance is fetched with query authentication and returns only the balance and currency", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/get-balance");
    assert.equal(url.searchParams.get("api_key"), config.apiKey);
    return Response.json({ balance: "785.57", currency: "ngn", user: "sensitive" });
  }) as typeof fetch;
  assert.deepEqual(await getBalance(config), { balance: 785.57, currency: "NGN" });
});

test("invalid balance responses fail instead of displaying a made-up zero", async () => {
  respond({ balance: "not a balance", currency: "NGN" });
  await assert.rejects(getBalance(config), isOutcome("unknown"));
});

test("delivery reports always query a single ID and retain raw provider statuses", async () => {
  const id = "3017545711235443752697757";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/sms/inbox");
    assert.equal(url.searchParams.get("api_key"), config.apiKey);
    assert.equal(url.searchParams.get("message_id"), id);
    return Response.json([
      { receiver: "+2348012345678", message_id: id, status: "DND Active on Phone Number", amount: "6.49" },
      { receiver: "2348012345679", message_id: "unrelated", status: "Delivered" },
    ]);
  }) as typeof fetch;
  assert.deepEqual(await getDeliveryReports(config, id), [{ phone: "2348012345678", providerId: id, status: "DND Active on Phone Number", amount: 6.49 }]);
});

test("missing message IDs cannot trigger account-wide report retrieval", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json([]); }) as typeof fetch;
  await assert.rejects(getDeliveryReports(config, ""), isOutcome("rejected"));
  assert.equal(calls, 0);
});

test("malformed or unsafe report data is not treated as a delivery confirmation", async () => {
  for (const body of [{ reports: [] }, [{ receiver: "2348012345678", message_id: 9007199254740992, status: "Delivered" }], [{ receiver: "2348012345678", message_id: "abc", status: "" }]]) {
    respond(body);
    await assert.rejects(getDeliveryReports(config, "abc"), isOutcome("unknown"));
  }
  respond([]);
  assert.deepEqual(await getDeliveryReports(config, "abc"), []);
});

const whatsappMessage = {
  phone: "2348012345678",
  deviceId: "device_123",
  templateId: "template-456",
  data: { name: "Ada", invite_url: "https://example.com/community" },
};
const senderIdRequest = { senderId: "Trezad", company: "Trezad Community", useCase: "Hello Ada, your community update is ready." };

test("WhatsApp templates use the exact single-recipient documented payload", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), "https://api.ng.termii.com/api/send/template");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      api_key: config.apiKey,
      phone_number: "2348012345678",
      device_id: "device_123",
      template_id: "template-456",
      data: { name: "Ada", invite_url: "https://example.com/community" },
    });
    return Response.json({ code: "ok", message_id: "wa_id_1", balance: "25.50" });
  }) as typeof fetch;
  assert.deepEqual(await sendWhatsAppTemplate(config, whatsappMessage), { providerId: "wa_id_1", balance: 25.5 });
  assert.equal(calls, 1);
});

test("WhatsApp recipient, ID and flat-variable validation happens before any fetch", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("must not fetch"); }) as typeof fetch;
  const invalidData: unknown[] = [
    [], ["Ada"], null, { name: 123 }, { name: {} }, { name: "" }, { name: " " },
    { name: "a".repeat(1501) }, { name: "{{unresolved}}" },
    JSON.parse('{"__proto__":"private"}'), { constructor: "private" }, { prototype: "private" },
    { toString: "private" }, { "bad-key": "private" },
    Object.create({ name: "Ada" }), { name: "Ada", [Symbol("hidden")]: "private" },
    Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`v${index}`, "x"])),
  ];
  for (const data of invalidData) {
    await assert.rejects(sendWhatsAppTemplate(config, { ...whatsappMessage, data: data as Record<string, string> }), isOutcome("rejected"));
  }
  for (const phone of [["2348012345678"], "08012345678", "+2348012345678", "2348012345678,2348012345679", "", 2348012345678]) {
    await assert.rejects(sendWhatsAppTemplate(config, { ...whatsappMessage, phone: phone as string }), isOutcome("rejected"));
  }
  for (const id of ["", "device/id", "device id", "a".repeat(129)]) {
    await assert.rejects(sendWhatsAppTemplate(config, { ...whatsappMessage, deviceId: id }), isOutcome("rejected"));
    await assert.rejects(sendWhatsAppTemplate(config, { ...whatsappMessage, templateId: id }), isOutcome("rejected"));
  }
  assert.equal(calls, 0);
});

test("WhatsApp variable accessors are rejected without evaluating supplied code", async () => {
  let getterCalls = 0;
  let fetchCalls = 0;
  const data = Object.defineProperty({}, "name", { enumerable: true, get() { getterCalls += 1; return "Ada"; } });
  globalThis.fetch = (async () => { fetchCalls += 1; return Response.json({}); }) as typeof fetch;
  await assert.rejects(sendWhatsAppTemplate(config, { ...whatsappMessage, data }), isOutcome("rejected"));
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("static WhatsApp templates may send an empty variable object", async () => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)).data, {});
    return Response.json({ code: "ok", message_id: "wa_static" });
  }) as typeof fetch;
  assert.deepEqual(await sendWhatsAppTemplate(config, { ...whatsappMessage, data: {} }), { providerId: "wa_static" });
});

test("WhatsApp responses reuse authoritative string IDs and reject ambiguous acknowledgements", async () => {
  respond({ code: "ok", message_id: 3017544054459083819856413, message_id_str: "3017544054459083819856413" });
  assert.equal((await sendWhatsAppTemplate(config, whatsappMessage)).providerId, "3017544054459083819856413");
  respond({ code: "ok", message_id: 12345 });
  assert.equal((await sendWhatsAppTemplate(config, whatsappMessage)).providerId, "12345");
  for (const body of [
    { code: "ok", message_id: 9007199254740992 }, { code: "ok" },
    { message_id: "wa_id" }, { code: "failed", message_id: "wa_id" },
    { code: "ok", message_id: "" }, [], null,
  ]) {
    respond(body);
    await assert.rejects(sendWhatsAppTemplate(config, whatsappMessage), isOutcome("unknown"));
  }
});

test("WhatsApp preserves rejected versus unknown outcomes without leaking provider data", async () => {
  for (const [status, outcome] of [[401, "rejected"], [403, "rejected"], [422, "rejected"], [429, "rejected"], [408, "unknown"], [500, "unknown"]] as const) {
    respond({ sensitive: config.apiKey }, status);
    await assert.rejects(sendWhatsAppTemplate(config, whatsappMessage), isOutcome(outcome));
  }
  globalThis.fetch = (async () => { throw new Error(`sensitive ${config.apiKey}`); }) as typeof fetch;
  await assert.rejects(sendWhatsAppTemplate(config, whatsappMessage), isOutcome("unknown"));
  globalThis.fetch = (async () => new Response("sensitive recipient-body")) as typeof fetch;
  await assert.rejects(sendWhatsAppTemplate(config, whatsappMessage), isOutcome("unknown"));
});

test("all operations construct a native Request with manual redirects and perform only one fetch", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("Accept"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    const url = new URL(request.url);
    if (url.pathname === "/api/get-balance") {
      assert.equal(request.method, "GET");
      return Response.json({ balance: 0, currency: "NGN" });
    }
    if (url.pathname === "/api/sms/inbox") {
      assert.equal(request.method, "GET");
      return Response.json([]);
    }
    if (url.pathname === "/api/sender-id") {
      assert.equal(request.method, "GET");
      return Response.json({ content: [], totalElements: 0 });
    }
    assert.equal(request.method, "POST");
    return Response.json({ code: "ok", message_id: "native_request_id" });
  }) as typeof fetch;
  assert.deepEqual(await getBalance(config), { balance: 0, currency: "NGN" });
  assert.deepEqual(await getDeliveryReports(config, "native_request_id"), []);
  assert.equal((await sendBulk(config, message)).providerId, "native_request_id");
  assert.equal((await sendWhatsAppTemplate(config, whatsappMessage)).providerId, "native_request_id");
  assert.deepEqual(await getSenderIds(config), { senderIds: [], complete: true, total: 0 });
  assert.deepEqual(await requestSenderId(config, senderIdRequest), { submitted: true });
  assert.equal(requests.length, 6);
});

test("Termii HTTP 429 identifies throttling on every operation without retrying or exposing headers", async () => {
  const operations = [
    { operation: "balance", invoke: () => getBalance(config) },
    { operation: "delivery_reports", invoke: () => getDeliveryReports(config, "report_id") },
    { operation: "sms_submit", invoke: () => sendBulk(config, message) },
    { operation: "whatsapp_submit", invoke: () => sendWhatsAppTemplate(config, whatsappMessage) },
    { operation: "sender_ids", invoke: () => getSenderIds(config) },
    { operation: "sender_id_request", invoke: () => requestSenderId(config, senderIdRequest) },
  ];
  for (const { operation, invoke } of operations) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(`sensitive ${config.apiKey} recipient-body`, { status: 429, headers: {
        "Content-Type": "application/json", "Retry-After": `sensitive-${config.apiKey}`,
      } });
    }) as typeof fetch;
    await assert.rejects(invoke(), error => {
      isOutcome("rejected")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, operation);
      assert.equal(error.reason, "rate_limited");
      assert.equal(error.upstreamStatus, 429);
      assert.match(error.message, /HTTP 429/);
      assert.match(error.message, /Wait before trying/);
      if (operation.endsWith("_submit")) assert.match(error.message, /review campaign results before resending/);
      else assert.match(error.message, /does not send messages/);
      return true;
    });
    assert.equal(calls, 1, `${operation} must not retry after throttling`);
  }
});

test("Termii distinguishes invalid credentials, missing permissions and rejected fields with safe actions", async () => {
  const operations = [
    () => getBalance(config), () => getDeliveryReports(config, "report_id"),
    () => getSenderIds(config), () => requestSenderId(config, senderIdRequest),
    () => sendBulk(config, message), () => sendWhatsAppTemplate(config, whatsappMessage),
  ];
  for (const status of [400, 401, 403, 422]) {
    for (const invoke of operations) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(`sensitive ${config.apiKey} recipient-body`, { status });
      }) as typeof fetch;
      await assert.rejects(invoke(), error => {
        isOutcome("rejected")(error);
        assert.ok(error instanceof ProviderError);
        assert.equal(error.upstreamStatus, status);
        assert.equal(error.reason, status === 401 || status === 403 ? "authentication" : "http_error");
        if (status === 401) assert.match(error.message, /API key and the account-specific HTTPS API base URL/);
        else if (status === 403) {
          assert.match(error.message, /permission/);
          assert.match(error.message, /enabled/);
        } else assert.match(error.message, /fields/);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("every 3xx response is rejected without following redirects or replaying a POST", async () => {
  const operations = [
    { operation: "balance", invoke: () => getBalance(config) },
    { operation: "delivery_reports", invoke: () => getDeliveryReports(config, "report_id") },
    { operation: "sms_submit", invoke: () => sendBulk(config, message) },
    { operation: "whatsapp_submit", invoke: () => sendWhatsAppTemplate(config, whatsappMessage) },
    { operation: "sender_ids", invoke: () => getSenderIds(config) },
    { operation: "sender_id_request", invoke: () => requestSenderId(config, senderIdRequest) },
  ];
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    for (const { operation, invoke } of operations) {
      let calls = 0;
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        assert.equal(init?.redirect, "manual");
        return new Response(null, { status, headers: {
          Location: `https://redirect-target.example/?api_key=${config.apiKey}`,
          "Content-Type": `text/html; diagnostic=${config.apiKey}`,
        } });
      }) as typeof fetch;
      await assert.rejects(invoke(), error => {
        isOutcome("unknown")(error);
        assert.ok(error instanceof ProviderError);
        assert.equal(error.operation, operation);
        assert.equal(error.reason, "redirect");
        assert.equal(error.upstreamStatus, status);
        assert.equal(error.contentType, "text/html");
        if (operation.endsWith("_submit")) assert.match(error.message, /Check provider history before sending again/);
        else if (operation === "sender_id_request") {
          assert.match(error.message, /sender-ID approval submission/);
          assert.match(error.message, /Check the sender-ID list before retrying/);
        } else assert.match(error.message, /This check does not send messages/);
        return true;
      });
      assert.equal(calls, 1, `${operation} must not follow or retry HTTP ${status}`);
    }
  }
});

test("balance HTTP failures carry safe diagnostics and never imply a message was submitted", async () => {
  for (const [status, outcome, reason] of [
    [401, "rejected", "authentication"], [403, "rejected", "authentication"],
    [404, "rejected", "http_error"], [422, "rejected", "http_error"], [429, "rejected", "rate_limited"],
    [408, "unknown", "http_error"], [500, "unknown", "http_error"], [503, "unknown", "http_error"],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls += 1;
      assert.equal(new URL(String(input)).pathname, "/api/get-balance");
      return new Response(`sensitive ${config.apiKey} recipient-body`, { status, headers: { "Content-Type": `application/json; diagnostic=${config.apiKey}` } });
    }) as typeof fetch;
    await assert.rejects(getBalance(config), error => {
      isOutcome(outcome)(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "balance");
      assert.equal(error.reason, reason);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.contentType, "application/json");
      assert.match(error.message, /balance check/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("balance network and timeout failures contain no raw exception or fabricated response metadata", async () => {
  for (const [failure, reason] of [
    [new Error(`sensitive ${config.apiKey} ${config.baseUrl}`), "network_error"],
    [new DOMException(`sensitive ${config.apiKey}`, "TimeoutError"), "timeout"],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw failure; }) as typeof fetch;
    await assert.rejects(getBalance(config), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "balance");
      assert.equal(error.reason, reason);
      assert.equal(error.upstreamStatus, undefined);
      assert.equal(error.contentType, undefined);
      assert.match(error.message, /balance check/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("balance JSON parsing failures retain only the status and a known content-type category", async () => {
  for (const [status, header, expected] of [
    [200, "Text/HTML; charset=utf-8", "text/html"],
    [200, "text/plain", "text/plain"],
    [200, "application/json", "application/json"],
    [200, "application/problem+json", "application/json"],
    [200, `application/sensitive-${config.apiKey}`, "other"],
    [204, null, "missing"],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(status === 204 ? null : `sensitive recipient-body ${config.apiKey}`, {
        status, headers: header ? { "Content-Type": header } : {},
      });
    }) as typeof fetch;
    await assert.rejects(getBalance(config), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "balance");
      assert.equal(error.reason, "invalid_json");
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.contentType, expected);
      assert.match(error.message, /balance check/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("balance schema failures preserve response diagnostics without inventing a zero balance", async () => {
  for (const body of [null, [], {}, { balance: "sensitive", currency: "NGN" }, { balance: 1, currency: config.apiKey }, { balance: 1 }]) {
    respond(body, 202);
    await assert.rejects(getBalance(config), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "balance");
      assert.equal(error.reason, "invalid_response");
      assert.equal(error.upstreamStatus, 202);
      assert.equal(error.contentType, "application/json");
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
  }
});

test("delivery-report failures identify the read operation without submission uncertainty wording", async () => {
  const failures = [
    { fetch: async () => new Response("sensitive", { status: 503 }), reason: "http_error" },
    { fetch: async () => new Response("sensitive malformed JSON"), reason: "invalid_json" },
    { fetch: async () => Response.json({ reports: [] }), reason: "invalid_response" },
    { fetch: async () => { throw new Error(`sensitive ${config.apiKey}`); }, reason: "network_error" },
  ];
  for (const failure of failures) {
    globalThis.fetch = failure.fetch as typeof fetch;
    await assert.rejects(getDeliveryReports(config, "report_id"), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "delivery_reports");
      assert.equal(error.reason, failure.reason);
      assert.match(error.message, /delivery-report check/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
  }
});

test("validation diagnostics identify the operation and contain no upstream response fields", async () => {
  assert.throws(() => validateBaseUrl("https://sensitive.invalid"), error => {
    isOutcome("rejected")(error);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.operation, "configuration");
    assert.equal(error.reason, "validation");
    assert.equal(error.upstreamStatus, undefined);
    assert.equal(error.contentType, undefined);
    return true;
  });
  await assert.rejects(getBalance({ ...config, apiKey: "" }), error => {
    isOutcome("rejected")(error);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.operation, "balance");
    assert.equal(error.reason, "validation");
    assert.equal(error.upstreamStatus, undefined);
    return true;
  });
});

const senderRow = { sender_id: "Trezad", country: "Nigeria", status: "active", createdAt: "2026-10-22 12:00:00" };

test("sender IDs use the account origin, query authentication, and documented response fields", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://v4.api.termii.com");
    assert.equal(url.pathname, "/api/sender-id");
    assert.deepEqual([...url.searchParams.entries()], [["api_key", config.apiKey]]);
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("Accept"), "application/json");
    assert.equal(init?.body, undefined);
    return Response.json({
      content: [
        { ...senderRow, sender_id: " Trezad ", country: " Nigeria ", status: " ACTIVE ", company: "sensitive", usecase: config.apiKey },
        { sender_id: "Waiting", country: "Nigeria", status: "pending" },
        { sender_id: "Blocked", country: "Nigeria", status: "blocked", createdAt: null },
      ],
      pageable: { pageNumber: 0, pageSize: 15, offset: 0, paged: true, unpaged: false },
      totalElements: 3, last: true, totalPages: 1, size: 15, number: 0,
      first: true, numberOfElements: 3, empty: false,
    });
  }) as typeof fetch;
  assert.deepEqual(await getSenderIds({ ...config, baseUrl: "https://v4.api.termii.com" }), {
    senderIds: [
      { senderId: "Trezad", country: "Nigeria", status: "active", createdAt: "2026-10-22 12:00:00" },
      { senderId: "Waiting", country: "Nigeria", status: "pending", createdAt: null },
      { senderId: "Blocked", country: "Nigeria", status: "blocked", createdAt: null },
    ],
    complete: true,
    total: 3,
  });
  assert.equal(calls, 1);
});

test("unknown sender states never become active through substring or approval synonyms", async () => {
  const states = ["inactive", "not active", "approved", "unapproved", "disabled", "rejected", "awaiting approval"];
  respond({ content: states.map((status, index) => ({ ...senderRow, sender_id: `Sender${index}`, status })), totalElements: states.length });
  const result = await getSenderIds(config);
  assert.equal(result.senderIds.length, states.length);
  assert.ok(result.senderIds.every(row => row.status === "unknown"));
});

test("sender lists require explicit evidence before claiming all records were fetched", async () => {
  for (const metadata of [
    { totalElements: 1 },
    { first: true, last: true },
    { number: 0, last: true },
    { totalPages: 1, pageable: { pageNumber: 0 } },
    { pageable: { unpaged: true } },
  ]) {
    respond({ content: [senderRow], ...metadata });
    const result = await getSenderIds(config);
    assert.equal(result.complete, true, JSON.stringify(metadata));
    assert.equal(result.total, "totalElements" in metadata ? 1 : null);
  }
  for (const metadata of [
    {}, { last: true }, { first: true }, { number: 0 },
    { totalElements: 2 }, { totalElements: 0 },
    { totalElements: 1, last: false }, { totalElements: 1, first: false },
    { totalElements: 1, totalPages: 2 }, { totalElements: 1, totalPages: 0 },
    { totalElements: 1, number: 1 }, { totalElements: 1, pageable: { pageNumber: 1 } },
    { totalElements: 1, pageable: { offset: 15 } },
    { totalElements: 1, numberOfElements: 0 },
    { totalElements: 1, size: 0 }, { totalElements: 1, pageable: { pageSize: 0 } },
    { totalElements: 1, size: 15, pageable: { pageSize: 30 } },
    { totalElements: 1, empty: true },
    { totalElements: 1, pageable: { paged: true, unpaged: true } },
  ]) {
    respond({ content: [senderRow], ...metadata });
    assert.equal((await getSenderIds(config)).complete, false, JSON.stringify(metadata));
  }
  respond({ content: [], totalElements: 0, totalPages: 0, first: true, last: true, empty: true });
  assert.deepEqual(await getSenderIds(config), { senderIds: [], complete: true, total: 0 });
  respond({ content: [] });
  assert.deepEqual(await getSenderIds(config), { senderIds: [], complete: false, total: null });
});

test("sender lists reject malformed rows and oversized responses without returning partial results", async () => {
  const malformedRows = [
    null, [], "Trezad", {},
    { ...senderRow, sender_id: 123 }, { ...senderRow, sender_id: "" }, { ...senderRow, sender_id: "a".repeat(65) },
    { ...senderRow, sender_id: "Trezad\u0000" },
    { ...senderRow, country: null }, { ...senderRow, country: " " }, { ...senderRow, country: "a".repeat(101) },
    { ...senderRow, status: true }, { ...senderRow, status: "" }, { ...senderRow, status: "a".repeat(65) },
    { ...senderRow, createdAt: 123 }, { ...senderRow, createdAt: "" }, { ...senderRow, createdAt: "a".repeat(65) },
  ];
  for (const body of [null, [], {}, { content: {} }, ...malformedRows.map(row => ({ content: [senderRow, row] })), { content: Array(1001).fill(senderRow) }]) {
    respond(body);
    await assert.rejects(getSenderIds(config), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_ids");
      assert.equal(error.reason, "invalid_response");
      assert.match(error.message, /sender-ID check/);
      assert.match(error.message, /This check does not send messages/);
      return true;
    });
  }
  respond({ content: Array.from({ length: 1000 }, (_, index) => ({ ...senderRow, sender_id: `Sender${index}` })), totalElements: 1000 });
  assert.equal((await getSenderIds(config)).senderIds.length, 1000);
});

test("malformed pagination metadata cannot be coerced into a complete sender list", async () => {
  for (const metadata of [
    { totalElements: "1" }, { totalElements: -1 }, { totalElements: 1.5 }, { totalElements: Number.MAX_SAFE_INTEGER + 1 },
    { totalPages: "1" }, { last: "false" }, { first: 1 }, { empty: null },
    { number: -1 }, { size: "15" }, { numberOfElements: 0.5 },
    { pageable: null }, { pageable: [] }, { pageable: { pageNumber: "0" } },
    { pageable: { pageSize: -1 } }, { pageable: { offset: "0" } }, { pageable: { unpaged: "true" } },
  ]) {
    respond({ content: [senderRow], ...metadata });
    await assert.rejects(getSenderIds(config), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.reason, "invalid_response");
      return true;
    });
  }
});

test("sender-ID checks distinguish safe read failures and do not expose upstream data", async () => {
  const failures = [
    { fetch: async () => new Response(`sensitive ${config.apiKey}`, { status: 401 }), reason: "authentication", outcome: "rejected" },
    { fetch: async () => new Response(`sensitive ${config.apiKey}`, { status: 422 }), reason: "http_error", outcome: "rejected" },
    { fetch: async () => new Response(`sensitive ${config.apiKey}`, { status: 503 }), reason: "http_error", outcome: "unknown" },
    { fetch: async () => new Response(`sensitive ${config.apiKey}`), reason: "invalid_json", outcome: "unknown" },
    { fetch: async () => { throw new Error(`sensitive ${config.apiKey}`); }, reason: "network_error", outcome: "unknown" },
    { fetch: async () => { throw new DOMException(`sensitive ${config.apiKey}`, "TimeoutError"); }, reason: "timeout", outcome: "unknown" },
  ] as const;
  for (const failure of failures) {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return failure.fetch(); }) as typeof fetch;
    await assert.rejects(getSenderIds(config), error => {
      isOutcome(failure.outcome)(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_ids");
      assert.equal(error.reason, failure.reason);
      assert.match(error.message, /sender-ID check/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("sender-ID approval validation trims fields, preserves sample line breaks, and accepts exact limits", () => {
  assert.deepEqual(validateSenderIdRequest({ senderId: " Trezad ", company: " Trezad Community ", useCase: " Hello Ada,\r\nyour update is ready. " }), {
    senderId: "Trezad", company: "Trezad Community", useCase: "Hello Ada,\r\nyour update is ready.",
  });
  assert.deepEqual(validateSenderIdRequest({ senderId: "A12", company: "AB", useCase: "1234567890" }), { senderId: "A12", company: "AB", useCase: "1234567890" });
  const atMaximum = { senderId: "A1234567890", company: "c".repeat(200), useCase: "m".repeat(2000) };
  assert.deepEqual(validateSenderIdRequest(atMaximum), atMaximum);
});

test("sender-ID approval rejects invalid input before fetching, including hidden fields and control characters", async () => {
  let calls = 0;
  let getters = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("must not fetch"); }) as typeof fetch;
  const accessor = { ...senderIdRequest };
  Object.defineProperty(accessor, "company", { enumerable: true, get() { getters += 1; return "Trezad"; } });
  const invalid = [
    null, [], {}, "Trezad", accessor, Object.create(senderIdRequest),
    ...["ab", "a".repeat(12), "123456", "Tre zad", "Tre-zad", "Trézad", "Trezad\n", "\tTrezad"].map(senderId => ({ ...senderIdRequest, senderId })),
    ...[" ", "A", "a".repeat(201), "Company\nName", "Company\tName", "Company\u0085Name", "Company\u2028Name"].map(company => ({ ...senderIdRequest, company })),
    ...[" ", "123456789", "a".repeat(2001), "Hello\tcommunity", "Hello\u0000community", "Hello\u007fcommunity"].map(useCase => ({ ...senderIdRequest, useCase })),
    { ...senderIdRequest, company: 123 }, { ...senderIdRequest, useCase: ["Hello community"] },
  ];
  for (const input of invalid) {
    await assert.rejects(requestSenderId(config, input), error => {
      isOutcome("rejected")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_id_request");
      assert.equal(error.reason, "validation");
      assert.match(error.message, /approval/);
      return true;
    });
  }
  assert.equal(getters, 0);
  assert.equal(calls, 0);
});

test("sender-ID approval submits the documented JSON once and only acknowledges submission", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.ng.termii.com/api/sender-id/request");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("Content-Type"), "application/json");
    assert.deepEqual(await request.json(), {
      api_key: config.apiKey, sender_id: "Trezad", company: "Trezad Community", use_case: senderIdRequest.useCase,
    });
    return Response.json({ code: "ok", message: `sensitive ${config.apiKey}`, status: "active" });
  }) as typeof fetch;
  assert.deepEqual(await requestSenderId(config, { ...senderIdRequest, senderId: " Trezad ", company: " Trezad Community " }), { submitted: true });
  assert.equal(calls, 1);
});

test("sender-ID approval requires the exact ok acknowledgement without echoing upstream text", async () => {
  for (const body of [null, [], {}, { code: "OK" }, { code: "failed" }, { submitted: true }, { message: `sensitive ${config.apiKey}` }]) {
    respond(body);
    await assert.rejects(requestSenderId(config, senderIdRequest), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_id_request");
      assert.equal(error.reason, "invalid_response");
      assert.match(error.message, /sender-ID approval submission/);
      assert.match(error.message, /Check the sender-ID list before retrying/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
  }
});

test("sender-ID approval failures retain uncertainty without replaying the mutation", async () => {
  for (const [status, outcome] of [[401, "rejected"], [403, "rejected"], [422, "rejected"], [429, "rejected"], [408, "unknown"], [500, "unknown"]] as const) {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(`sensitive ${config.apiKey}`, { status }); }) as typeof fetch;
    await assert.rejects(requestSenderId(config, senderIdRequest), error => {
      isOutcome(outcome)(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_id_request");
      assert.equal(error.upstreamStatus, status);
      assert.match(error.message, /sender-ID approval submission/);
      assert.match(error.message, /This request does not send messages/);
      if (outcome === "unknown") assert.match(error.message, /Check the sender-ID list before retrying/);
      assert.doesNotMatch(error.message, /provider history|before sending again/);
      return true;
    });
    assert.equal(calls, 1);
  }
  for (const failure of [
    { fetch: async () => { throw new Error(`sensitive ${config.apiKey}`); }, reason: "network_error" },
    { fetch: async () => { throw new DOMException(`sensitive ${config.apiKey}`, "TimeoutError"); }, reason: "timeout" },
    { fetch: async () => new Response(`sensitive ${config.apiKey}`), reason: "invalid_json" },
  ]) {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return failure.fetch(); }) as typeof fetch;
    await assert.rejects(requestSenderId(config, senderIdRequest), error => {
      isOutcome("unknown")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_id_request");
      assert.equal(error.reason, failure.reason);
      assert.match(error.message, /Check the sender-ID list before retrying/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("sender operations validate connection configuration without misidentifying a send", async () => {
  for (const invalidConfig of [{ ...config, apiKey: "" }, { ...config, baseUrl: "https://sensitive.invalid" }]) {
    await assert.rejects(getSenderIds(invalidConfig), error => {
      isOutcome("rejected")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_ids");
      assert.equal(error.reason, "validation");
      assert.match(error.message, /sender-ID check/);
      assert.match(error.message, /This check does not send messages/);
      return true;
    });
    await assert.rejects(requestSenderId(invalidConfig, senderIdRequest), error => {
      isOutcome("rejected")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.operation, "sender_id_request");
      assert.match(error.message, /sender-ID approval submission/);
      return true;
    });
  }
});
