import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { internationalAdapters } from "../app/lib/sms-providers/international.ts";
import { ProviderError } from "../app/lib/termii.ts";
import type { SmsSendInput } from "../app/lib/sms-providers/types.ts";

const { twilio, vonage, africastalking } = internationalAdapters;
const accountSid = `AC${"a".repeat(32)}`;
const messageSid = `SM${"b".repeat(32)}`;
const twilioCredentials = { accountSid, authToken: "mock-twilio-secret-only" };
const vonageCredentials = { apiKey: "abc12345", apiSecret: "mock-vonage-secret-only" };
const africaCredentials = { username: "live_mock_app", apiKey: "mock-africa-secret-only" };
const firstPhone = "+2348012345678";
const secondPhone = "+2349012345678";
const thirdPhone = "+2347012345678";
const input: SmsSendInput = { phones: [firstPhone], senderId: "Trezad", message: "Community meeting on Saturday.", channel: "generic" };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error("Unexpected request blocked: these tests never call a live provider."); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

function reply(body: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
}

function providerError(outcome: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.outcome, outcome);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /mock-.*secret|sensitive upstream|provider\.example/);
    return true;
  };
}

function twilioSuccess(phone = firstPhone, extra: Record<string, unknown> = {}) {
  return { sid: messageSid, account_sid: accountSid, to: phone, status: "queued", ...extra };
}

function vonageSuccess(phone = firstPhone, id = "0A0000001234567B") {
  return { "message-count": "1", messages: [{ to: phone.slice(1), "message-id": id, status: "0" }] };
}

function africaRecipient(number = firstPhone, statusCode = 102, messageId: unknown = "ATXid_example123") {
  return { number, statusCode, messageId, status: "Success", cost: "NGN 5.00" };
}

test("Twilio balance uses Basic authentication and preserves actual currency and negative balances", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${btoa(`${accountSid}:${twilioCredentials.authToken}`)}`);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ account_sid: accountSid, balance: "-3.24", currency: "usd", other: "sensitive upstream" });
  }) as typeof fetch;
  assert.deepEqual(await twilio.balance(twilioCredentials), { balance: -3.24, currency: "USD", unit: "money" });
});

test("Twilio does not invent a balance for malformed or mismatched account responses", async () => {
  for (const data of [
    { account_sid: `AC${"c".repeat(32)}`, balance: "4", currency: "USD" },
    { account_sid: accountSid, balance: "", currency: "USD" },
    { account_sid: accountSid, balance: "4", currency: "credits" },
    { balance: 3, currency: "USD" },
  ]) {
    reply(data);
    await assert.rejects(twilio.balance(twilioCredentials), providerError("unknown"));
  }
});

test("Twilio send submits canonical +234 recipients and unchanged text as form data", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init?.body));
    assert.deepEqual(Object.fromEntries(form), { To: firstPhone, From: "Trezad", Body: "Ẹ káàrọ̀ 👋 & welcome" });
    return Response.json(twilioSuccess(), { status: 201 });
  }) as typeof fetch;
  assert.deepEqual(await twilio.send(twilioCredentials, { ...input, message: "Ẹ káàrọ̀ 👋 & welcome" }), [{ phone: firstPhone, status: "accepted", providerId: messageSid }]);
});

test("Twilio preserves independent successes, rejections, and uncertain results without retrying", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const phone = new URLSearchParams(String(init?.body)).get("To");
    if (phone === firstPhone) return Response.json(twilioSuccess(firstPhone));
    if (phone === secondPhone) return Response.json({ message: "sensitive upstream" }, { status: 400 });
    throw new Error("sensitive upstream provider.example mock-twilio-secret-only");
  }) as typeof fetch;
  const results = await twilio.send(twilioCredentials, { ...input, phones: [firstPhone, secondPhone, thirdPhone] });
  assert.deepEqual(results.map(row => row.status), ["accepted", "failed", "unknown"]);
  assert.equal(calls, 3);
  assert.doesNotMatch(JSON.stringify(results), /sensitive upstream|mock-twilio-secret|provider\.example/);
});

test("Twilio accepts a permitted international numeric sender and preserves its leading plus", async () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URLSearchParams(String(init?.body)).get("From"), "+14155552671");
    return Response.json(twilioSuccess());
  }) as typeof fetch;
  assert.equal((await twilio.send(twilioCredentials, { ...input, senderId: "+14155552671" }))[0].status, "accepted");
});

test("Twilio requires a matching account, recipient, valid SID, and known status", async () => {
  for (const response of [
    twilioSuccess(secondPhone), twilioSuccess(firstPhone, { account_sid: `AC${"c".repeat(32)}` }),
    twilioSuccess(firstPhone, { sid: 9007199254740992 }), twilioSuccess(firstPhone, { status: "receiving" }),
    { sid: messageSid, status: "queued" },
  ]) {
    reply(response);
    assert.equal((await twilio.send(twilioCredentials, input))[0].status, "unknown");
  }
});

test("Twilio keeps failed message IDs for provider-history reconciliation", async () => {
  reply(twilioSuccess(firstPhone, { status: "failed", error_message: "sensitive upstream" }));
  const result = (await twilio.send(twilioCredentials, input))[0];
  assert.equal(result.status, "failed");
  assert.equal(result.providerId, messageSid);
  assert.doesNotMatch(result.reason!, /sensitive/);
});

test("Twilio reports verify message ownership and normalize final statuses", async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`);
    return Response.json(twilioSuccess(firstPhone, { status: "delivered" }));
  }) as typeof fetch;
  assert.deepEqual(await twilio.reports!(twilioCredentials, messageSid), [{ phone: firstPhone, providerId: messageSid, status: "delivered" }]);
  reply(twilioSuccess(firstPhone, { status: "canceled" }));
  assert.equal((await twilio.reports!(twilioCredentials, messageSid))[0].status, "failed");
  reply(twilioSuccess(firstPhone, { sid: `SM${"c".repeat(32)}` }));
  await assert.rejects(twilio.reports!(twilioCredentials, messageSid), providerError("unknown"));
  await assert.rejects(twilio.reports!(twilioCredentials, "../../Balance"), providerError("rejected"));
});

test("all international adapters reject invalid batches, route overrides, and unconfigured credentials before requests", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
  for (const [adapter, credentials] of [[twilio, twilioCredentials], [vonage, vonageCredentials], [africastalking, africaCredentials]] as const) {
    for (const changes of [{ phones: [] }, { phones: ["08012345678"] }, { phones: [firstPhone, firstPhone] }, { senderId: "bad<>" }, { message: " " }, { channel: "dnd" as const }]) {
      await assert.rejects(adapter.send(credentials, { ...input, ...changes }), providerError("rejected"));
    }
    await assert.rejects(adapter.send({}, input), providerError("rejected"));
  }
  await assert.rejects(twilio.send(twilioCredentials, { ...input, message: "x".repeat(1601) }), providerError("rejected"));
  const phones = Array.from({ length: 6 }, (_, index) => `+234801234${String(index).padStart(4, "0")}`);
  await assert.rejects(twilio.send(twilioCredentials, { ...input, phones }), providerError("rejected"));
  await assert.rejects(vonage.send(vonageCredentials, { ...input, phones }), providerError("rejected"));
  assert.equal(calls, 0);
});

test("Vonage balance uses the documented EUR value and Basic credentials", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://rest.nexmo.com/account/get-balance");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${btoa(`${vonageCredentials.apiKey}:${vonageCredentials.apiSecret}`)}`);
    return Response.json({ value: 10.28, autoReload: false });
  }) as typeof fetch;
  assert.deepEqual(await vonage.balance(vonageCredentials), { balance: 10.28, currency: "EUR", unit: "money" });
  reply({ "error-code": 4, "error-code-label": "sensitive upstream" });
  await assert.rejects(vonage.balance(vonageCredentials), providerError("unknown"));
});

test("Vonage sends digits-only recipients with GSM or Unicode encoding chosen from exact content", async () => {
  for (const [message, type] of [["Hello ^&€", "text"], ["Ẹ káàrọ̀ 👋", "unicode"]]) {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://rest.nexmo.com/sms/json");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), { from: "Trezad", to: firstPhone.slice(1), text: message, type });
      return Response.json(vonageSuccess());
    }) as typeof fetch;
    assert.equal((await vonage.send(vonageCredentials, { ...input, message }))[0].status, "accepted");
  }
});

test("Vonage aggregates successfully accepted multipart segment IDs without calling them delivered", async () => {
  reply({ "message-count": "2", messages: [vonageSuccess().messages[0], vonageSuccess(firstPhone, "0A0000001234567C").messages[0]] });
  assert.deepEqual(await vonage.send(vonageCredentials, input), [{ phone: firstPhone, status: "accepted", providerId: "0A0000001234567B,0A0000001234567C" }]);
});

test("Vonage accepts a permitted international numeric sender and formats it as digits", async () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URLSearchParams(String(init?.body)).get("from"), "447700900000");
    return Response.json(vonageSuccess());
  }) as typeof fetch;
  assert.equal((await vonage.send(vonageCredentials, { ...input, senderId: "+447700900000" }))[0].status, "accepted");
});

test("Vonage partial multipart acceptance is uncertain and preserves known IDs", async () => {
  reply({ "message-count": "2", messages: [vonageSuccess().messages[0], { status: "9", to: firstPhone.slice(1), "error-text": "sensitive upstream" }] });
  const result = (await vonage.send(vonageCredentials, input))[0];
  assert.equal(result.status, "unknown");
  assert.equal(result.providerId, "0A0000001234567B");
  assert.doesNotMatch(result.reason!, /sensitive/);
});

test("Vonage explicit application rejections stay failed while internal errors stay uncertain", async () => {
  reply({ "message-count": "1", messages: [{ status: "4", "error-text": "sensitive upstream" }] });
  assert.equal((await vonage.send(vonageCredentials, input))[0].status, "failed");
  for (const code of ["5", "999"]) {
    reply({ "message-count": "1", messages: [{ status: code }] });
    assert.equal((await vonage.send(vonageCredentials, input))[0].status, "unknown");
  }
});

test("Vonage rejects inconsistent counts, recipients, success IDs, and raw ambiguous responses", async () => {
  for (const data of [
    { "message-count": "2", messages: vonageSuccess().messages },
    vonageSuccess(secondPhone),
    { "message-count": "1", messages: [{ to: firstPhone.slice(1), status: "0" }] },
    { "message-count": "1", messages: [{ to: firstPhone.slice(1), status: "0", "message-id": 9007199254740992 }] },
    { success: true },
  ]) {
    reply(data);
    assert.equal((await vonage.send(vonageCredentials, input))[0].status, "unknown");
  }
});

test("Africa’s Talking balance requests JSON and parses actual currency including debt", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.africastalking.com");
    assert.equal(parsed.pathname, "/version1/user");
    assert.equal(parsed.searchParams.get("username"), africaCredentials.username);
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    assert.equal(new Headers(init?.headers).get("apiKey"), africaCredentials.apiKey);
    return Response.json({ UserData: { balance: "NGN -1206.2999" } });
  }) as typeof fetch;
  assert.deepEqual(await africastalking.balance(africaCredentials), { balance: -1206.2999, currency: "NGN", unit: "money" });
});

test("Africa’s Talking malformed balances never become a fabricated zero", async () => {
  for (const balance of [0, "0", "NGN", "NGN NaN", "credit 123", null, "NGN 1.23 extra"]) {
    reply({ UserData: { balance } });
    await assert.rejects(africastalking.balance(africaCredentials), providerError("unknown"));
  }
});

test("Africa’s Talking sandbox credentials cannot be mistaken for a live provider", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
  const credentials = { ...africaCredentials, username: "sandbox" };
  await assert.rejects(africastalking.balance(credentials), providerError("rejected"));
  await assert.rejects(africastalking.send(credentials, input), providerError("rejected"));
  assert.equal(calls, 0);
});

test("Africa’s Talking submits a native 100-recipient form batch with plus-prefixed numbers", async () => {
  const phones = Array.from({ length: 100 }, (_, index) => `+234801234${String(index).padStart(4, "0")}`);
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://api.africastalking.com/version1/messaging");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), { username: africaCredentials.username, to: phones.join(","), from: "Trezad", message: input.message, bulkSMSMode: "1", enqueue: "1" });
    return Response.json({ SMSMessageData: { Recipients: phones.map((phone, index) => africaRecipient(phone, 102, `ATXid_${index}`)) } }, { status: 201 });
  }) as typeof fetch;
  const results = await africastalking.send(africaCredentials, { ...input, phones });
  assert.equal(results.length, 100);
  assert.ok(results.every(result => result.status === "accepted"));
  assert.equal(calls, 1);
});

test("Africa’s Talking matches out-of-order recipient acknowledgements individually", async () => {
  reply({ SMSMessageData: { Recipients: [africaRecipient(secondPhone, 405, ""), africaRecipient(firstPhone, 101), africaRecipient(thirdPhone, 500, "")] } });
  const results = await africastalking.send(africaCredentials, { ...input, phones: [firstPhone, secondPhone, thirdPhone] });
  assert.deepEqual(results.map(result => result.status), ["accepted", "failed", "unknown"]);
  assert.deepEqual(results.map(result => result.phone), [firstPhone, secondPhone, thirdPhone]);
});

test("Africa’s Talking missing recipients remain unknown while confirmed recipients stay accepted", async () => {
  reply({ SMSMessageData: { Recipients: [africaRecipient(firstPhone, 100)] } });
  const results = await africastalking.send(africaCredentials, { ...input, phones: [firstPhone, secondPhone] });
  assert.deepEqual(results.map(result => result.status), ["accepted", "unknown"]);
});

test("Africa’s Talking duplicate or unexpected recipients cannot masquerade as complete acceptance", async () => {
  for (const recipients of [
    [africaRecipient(firstPhone), africaRecipient(firstPhone)],
    [africaRecipient(firstPhone), africaRecipient(thirdPhone)],
  ]) {
    reply({ SMSMessageData: { Recipients: recipients } });
    const results = await africastalking.send(africaCredentials, { ...input, phones: [firstPhone, secondPhone] });
    assert.ok(results.every(result => result.status === "unknown"));
  }
});

test("Africa’s Talking acknowledgement needs an explicit acceptance code and safe string message ID", async () => {
  for (const row of [africaRecipient(firstPhone, 102, 9007199254740992), africaRecipient(firstPhone, 999), { number: firstPhone, status: "Success", messageId: "ATXid_test" }]) {
    reply({ SMSMessageData: { Recipients: [row] } });
    assert.equal((await africastalking.send(africaCredentials, input))[0].status, "unknown");
  }
});

test("all international adapters reject redirects without following them or exposing upstream text", async () => {
  for (const [adapter, credentials] of [[twilio, twilioCredentials], [vonage, vonageCredentials], [africastalking, africaCredentials]] as const) {
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response("sensitive upstream", { status: 307, headers: { Location: "https://provider.example/steal" } });
    }) as typeof fetch;
    const result = (await adapter.send(credentials, input))[0];
    assert.equal(result.status, "unknown");
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|provider\.example/);
  }
});

test("all international adapters distinguish definite HTTP refusal from uncertain server failure", async () => {
  for (const [adapter, credentials] of [[twilio, twilioCredentials], [vonage, vonageCredentials], [africastalking, africaCredentials]] as const) {
    for (const [status, outcome, guidance] of [
      [400, "failed", /request fields/], [401, "failed", /credentials and account environment/],
      [403, "failed", /permission.*request/], [422, "failed", /request fields/],
      [429, "failed", /HTTP 429.*Wait before trying again.*Review campaign results/],
      [408, "unknown", /Check its message history before sending again/],
      [503, "unknown", /Check its message history before sending again/],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json({ error: "sensitive upstream" }, { status });
      }) as typeof fetch;
      const result = (await adapter.send(credentials, input))[0];
      assert.equal(result.status, outcome);
      assert.match(result.reason || "", guidance);
      assert.doesNotMatch(JSON.stringify(result), /sensitive/);
      assert.equal(calls, 1);
    }
  }
});
