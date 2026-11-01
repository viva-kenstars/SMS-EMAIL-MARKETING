import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { nigeriaAdapters } from "../app/lib/sms-providers/nigeria.ts";
import { ProviderError } from "../app/lib/termii.ts";
import type { SmsSendInput } from "../app/lib/sms-providers/types.ts";

const credentials = { apiToken: "nigeria-adapter-test-token-not-a-real-credential" };
const phone = "+2348012345678";
const second = "+2348098765432";
const input: SmsSendInput = { phones: [phone], senderId: "Trezad", message: "Hello community", channel: "generic" };
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error("Unexpected outbound request blocked by tests"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = nativeFetch; });

function respond(value: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(value, { status })) as typeof fetch;
}
function outcome(expected: "unknown" | "rejected") {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.outcome, expected);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /nigeria-adapter-test-token|secret-upstream|2348012345678/);
    return true;
  };
}
function bsngSuccess(count = 1) {
  return { status: "success", code: "BSNG-0000", data: { message_id: "bsng-id-1", recipients_count: count, gateway_used: "direct-refund" } };
}
function smartSuccess() {
  return { code: 1000, successful: phone.slice(1), failed: "", flooding: "", insufficient_unit: "", invalid: "", dnd_numbers: "", message_id: "msg-example-1" };
}
function sendchampSuccess(recipient = phone) {
  return { code: 200, status: "success", data: { id: "MN-SMS-example-1", reference: "MN-SMS-example-1", phone_number: recipient.slice(1), status: "processing" } };
}

test("BulkSMSNigeria checks its actual total NGN wallet balance with Bearer authentication", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://www.bulksmsnigeria.com/api/v2/balance");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${credentials.apiToken}`);
    assert.equal(init?.redirect, "manual");
    return Response.json({ data: { status: "success" }, balance: { total_balance: "1250.50", sms_bonus: "99" } });
  }) as typeof fetch;
  assert.deepEqual(await nigeriaAdapters.bulksmsnigeria.balance(credentials), { balance: 1250.5, currency: "NGN", unit: "money" });
});

test("BulkSMSNigeria never invents a zero balance for malformed or failed responses", async () => {
  for (const value of [null, {}, { data: { status: "success" }, balance: { total_balance: null } },
    { data: { status: "error" }, balance: { total_balance: 4 } },
    { data: { status: "success" }, balance: { total_balance: "NaN" } }]) {
    respond(value);
    await assert.rejects(nigeriaAdapters.bulksmsnigeria.balance(credentials), outcome("unknown"));
  }
  respond({ data: { status: "success" }, balance: { total_balance: 0 } });
  assert.equal((await nigeriaAdapters.bulksmsnigeria.balance(credentials)).balance, 0);
});

test("BulkSMSNigeria bulk payload preserves text and selects only the requested promotional route", async () => {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://www.bulksmsnigeria.com/api/v2/sms");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(init?.body)), { from: "Trezad", to: `${phone.slice(1)},${second.slice(1)}`,
      body: "Ẹ káàrọ̀ 👋 ’", gateway: "direct-refund", unicode: true });
    return Response.json(bsngSuccess(2));
  }) as typeof fetch;
  const result = await nigeriaAdapters.bulksmsnigeria.send(credentials, { ...input, phones: [phone, second], message: "Ẹ káàrọ̀ 👋 ’" });
  assert.deepEqual(result.map(row => row.status), ["accepted", "accepted"]);
  assert.equal(calls, 1);
});

test("BulkSMSNigeria partial counts and different gateways retain IDs as unknown rather than claiming every recipient", async () => {
  for (const data of [
    { message_id: "id-1", recipients_count: 1, gateway_used: "direct-refund" },
    { message_id: "id-1", recipients_count: 2, gateway_used: "corporate" },
    { message_id: "id-1", recipients_count: 2, gateway_used: "direct-refund", skipped_recipients: [second.slice(1)] },
  ]) {
    respond({ status: "success", code: "BSNG-0000", data });
    const result = await nigeriaAdapters.bulksmsnigeria.send(credentials, { ...input, phones: [phone, second] });
    assert.deepEqual(result.map(row => row.status), ["unknown", "unknown"]);
    assert.deepEqual(result.map(row => row.providerId), ["id-1", "id-1"]);
  }
});

test("BulkSMSNigeria requires a success code and safe string ID", async () => {
  for (const value of [{ status: "success", data: { message_id: "id" } },
    { ...bsngSuccess(), data: { message_id: 9007199254740992, recipients_count: 1, gateway_used: "direct-refund" } },
    { ...bsngSuccess(), data: { message_id: "secret-upstream\nnot-an-id" } }]) {
    respond(value);
    await assert.rejects(nigeriaAdapters.bulksmsnigeria.send(credentials, input), outcome("unknown"));
  }
});

test("BulkSMSNigeria explicit rejection is safe and never exposes its arbitrary message", async () => {
  respond({ status: "error", code: "BSNG-2012", message: `secret-upstream ${credentials.apiToken}` });
  await assert.rejects(nigeriaAdapters.bulksmsnigeria.send(credentials, input), outcome("rejected"));
});

test("BulkSMSNigeria accepts a documented one-character alphabetic sender ID", async () => {
  respond(bsngSuccess());
  const result = await nigeriaAdapters.bulksmsnigeria.send(credentials, { ...input, senderId: "A" });
  assert.equal(result[0].status, "accepted");
});

test("BulkSMSNigeria delivery polling matches the requested ID and distinguishes delivery from queueing", async () => {
  globalThis.fetch = (async (value, init) => {
    const url = new URL(String(value));
    assert.equal(url.origin, "https://www.bulksmsnigeria.com");
    assert.equal(url.searchParams.get("message_id"), "id-1");
    assert.equal(url.searchParams.get("per_page"), "1000");
    assert.equal(init?.redirect, "manual");
    return Response.json({ status: "success", code: "BSNG-0000", data: { message_id: "id-1", reports: [
      { recipient: phone.slice(1), delivery_status: "success" },
      { recipient: second.slice(1), delivery_status: "sent awaiting status" },
    ] } });
  }) as typeof fetch;
  assert.deepEqual(await nigeriaAdapters.bulksmsnigeria.reports!(credentials, "id-1"), [
    { phone, providerId: "id-1", status: "delivered" }, { phone: second, providerId: "id-1", status: "accepted" },
  ]);
});

test("BulkSMSNigeria rejects mismatched report IDs and duplicate conflicting recipients", async () => {
  for (const data of [
    { message_id: "another-id", reports: [] },
    { message_id: "id-1", reports: [{ recipient: phone.slice(1), delivery_status: "delivrd" }, { recipient: phone, delivery_status: "failed" }] },
    { message_id: "id-1", reports: [{ recipient: "not-a-phone", delivery_status: "delivrd" }] },
  ]) {
    respond({ status: "success", code: "BSNG-0000", data });
    await assert.rejects(nigeriaAdapters.bulksmsnigeria.reports!(credentials, "id-1"), outcome("unknown"));
  }
});

test("SmartSMS reads documented scalar balance and labels it as credits without assuming currency", async () => {
  globalThis.fetch = (async (value, init) => {
    const url = new URL(String(value));
    assert.equal(url.origin, "https://app.smartsmssolutions.com");
    assert.equal(url.pathname, "/io/api/client/v1/balance/");
    assert.equal(url.searchParams.get("token"), credentials.apiToken);
    assert.equal(init?.redirect, "manual");
    return Response.json(123.45);
  }) as typeof fetch;
  assert.deepEqual(await nigeriaAdapters.smartsmssolutions.balance(credentials), { balance: 123.45, currency: "credits", unit: "credits" });
});

test("SmartSMS rejects object, boolean and missing balance payloads", async () => {
  for (const value of [false, null, {}, { balance: 99 }, "", "123abc", -5]) {
    respond(value);
    await assert.rejects(nigeriaAdapters.smartsmssolutions.balance(credentials), outcome("unknown"));
  }
});

test("SmartSMS uses multipart fields, Unicode type and promotional routing without rewriting message text", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://app.smartsmssolutions.com/io/api/client/v1/sms/");
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual(Object.fromEntries((init.body as FormData).entries()), {
      token: credentials.apiToken, sender: "Trezad", to: phone.slice(1), message: "Ẹ káàrọ̀ 👋", type: "2", routing: "2",
    });
    return Response.json(smartSuccess());
  }) as typeof fetch;
  assert.deepEqual(await nigeriaAdapters.smartsmssolutions.send(credentials, { ...input, message: "Ẹ káàrọ̀ 👋" }), [
    { phone, providerId: "msg-example-1", status: "accepted" },
  ]);
});

test("SmartSMS partial success is attributed per recipient", async () => {
  respond({ ...smartSuccess(), insufficient_unit: second.slice(1) });
  const result = await nigeriaAdapters.smartsmssolutions.send(credentials, { ...input, phones: [phone, second] });
  assert.equal(result[0].status, "accepted");
  assert.equal(result[1].status, "failed");
  assert.match(result[1].reason || "", /insufficient credit/);
});

test("SmartSMS missing and contradictory recipient confirmations remain unknown", async () => {
  respond(smartSuccess());
  const missing = await nigeriaAdapters.smartsmssolutions.send(credentials, { ...input, phones: [phone, second] });
  assert.equal(missing[0].status, "accepted");
  assert.equal(missing[1].status, "unknown");
  respond({ ...smartSuccess(), failed: phone.slice(1) });
  assert.equal((await nigeriaAdapters.smartsmssolutions.send(credentials, input))[0].status, "unknown");
});

test("SmartSMS does not accept a foreign recipient, unsafe ID or wrong success code", async () => {
  for (const value of [{ ...smartSuccess(), successful: second.slice(1) },
    { ...smartSuccess(), message_id: 9007199254740992 }, { ...smartSuccess(), code: 9999 }]) {
    respond(value);
    await assert.rejects(nigeriaAdapters.smartsmssolutions.send(credentials, input), outcome("unknown"));
  }
});

test("SmartSMS DND omissions are explicit failures on the promotional route", async () => {
  respond({ ...smartSuccess(), successful: "", dnd_numbers: phone.slice(1), message_id: null });
  const result = await nigeriaAdapters.smartsmssolutions.send(credentials, input);
  assert.equal(result[0].status, "failed");
  assert.match(result[0].reason || "", /DND/);
});

test("Sendchamp retains the balance's own currency and does not mix it with converted business amounts", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://api.sendchamp.com/api/v1/wallet/wallet_balance");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${credentials.apiToken}`);
    return Response.json({ status: "success", code: "200", data: { available_balance: "1.82450", currency: "USD", business_currency: "NGN", details: { business_amount: 912.25 } } });
  }) as typeof fetch;
  assert.deepEqual(await nigeriaAdapters.sendchamp.balance(credentials), { balance: 1.8245, currency: "USD", unit: "money" });
});

test("Sendchamp rejects missing currency and incorrect success envelopes", async () => {
  for (const value of [{ status: "success", code: 200, data: { available_balance: 10 } },
    { status: "failed", code: 400, data: { available_balance: 10, currency: "USD" } },
    { status: "success", code: 200, data: { available_balance: true, currency: "USD" } }]) {
    respond(value);
    await assert.rejects(nigeriaAdapters.sendchamp.balance(credentials), outcome("unknown"));
  }
});

test("Sendchamp sends each recipient separately and validates each exact acknowledgment", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://api.sendchamp.com/api/v1/sms/send");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.route, "non_dnd");
    assert.equal(body.sender_name, "Sendchamp");
    assert.equal(body.message, input.message);
    assert.equal(body.to.length, 1);
    seen.push(body.to[0]);
    return Response.json(sendchampSuccess(`+${body.to[0]}`));
  }) as typeof fetch;
  const result = await nigeriaAdapters.sendchamp.send(credentials, { ...input, senderId: "Sendchamp", phones: [phone, second] });
  assert.deepEqual(seen.sort(), [phone.slice(1), second.slice(1)].sort());
  assert.deepEqual(result.map(row => row.status), ["accepted", "accepted"]);
});

test("Sendchamp foreign recipient remains unknown without retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json(sendchampSuccess(second)); }) as typeof fetch;
  assert.equal((await nigeriaAdapters.sendchamp.send(credentials, input))[0].status, "unknown");
  assert.equal(calls, 1);
});

test("Sendchamp permits a distinct reference while confirming the exact phone and message ID", async () => {
  respond({ ...sendchampSuccess(), data: { ...sendchampSuccess().data, reference: "different-id" } });
  const result = await nigeriaAdapters.sendchamp.send(credentials, input);
  assert.equal(result[0].status, "accepted");
  assert.equal(result[0].providerId, "MN-SMS-example-1");
});

test("Sendchamp failures and uncertain errors are isolated per recipient with bounded safe text", async () => {
  globalThis.fetch = (async (_url, init) => {
    const recipient = JSON.parse(String(init?.body)).to[0];
    return recipient === phone.slice(1) ? Response.json(sendchampSuccess())
      : Response.json({ status: "error", error: `secret-upstream ${credentials.apiToken}` }, { status: 503 });
  }) as typeof fetch;
  const result = await nigeriaAdapters.sendchamp.send(credentials, { ...input, phones: [phone, second] });
  assert.deepEqual(result.map(row => row.status), ["accepted", "unknown"]);
  assert.doesNotMatch(JSON.stringify(result), /secret-upstream|nigeria-adapter-test-token/);
});

test("All adapters reject invalid batches, unsupported routes, oversized messages and empty credentials before fetching", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
  for (const adapter of Object.values(nigeriaAdapters)) {
    for (const value of [{ ...input, phones: [] }, { ...input, phones: [phone, phone] },
      { ...input, phones: ["08012345678"] }, { ...input, message: "x".repeat(1531) },
      { ...input, channel: "dnd" as const }, { ...input, senderId: "012345" }]) {
      await assert.rejects(adapter.send(credentials, value), outcome("rejected"));
    }
    await assert.rejects(adapter.balance({ apiToken: "" }), outcome("rejected"));
  }
  await assert.rejects(nigeriaAdapters.bulksmsnigeria.send(credentials, { ...input, senderId: "My Brand" }), outcome("rejected"));
  await assert.rejects(nigeriaAdapters.sendchamp.send(credentials, { ...input, phones: Array.from({ length: 6 }, (_, i) => `+234801234567${i}`) }), outcome("rejected"));
  assert.equal(calls, 0);
});

test("Redirects are refused and transport never retries any native bulk submission", async () => {
  for (const id of ["bulksmsnigeria", "smartsmssolutions"]) {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://secret-upstream.example" } });
    }) as typeof fetch;
    await assert.rejects(nigeriaAdapters[id].send(credentials, input), outcome("unknown"));
    assert.equal(calls, 1);
  }
});

test("Nigerian provider balance throttling is actionable and never retries or retains upstream data", async () => {
  for (const adapter of Object.values(nigeriaAdapters)) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(`secret-upstream ${credentials.apiToken}`, { status: 429, headers: {
        "Content-Type": "application/json", "Retry-After": `secret-upstream-${credentials.apiToken}`,
      } });
    }) as typeof fetch;
    await assert.rejects(adapter.balance(credentials), error => {
      outcome("rejected")(error);
      assert.ok(error instanceof ProviderError);
      assert.equal(error.reason, "rate_limited");
      assert.equal(error.upstreamStatus, 429);
      assert.match(error.message, /Wait before trying again/);
      assert.match(error.message, /This check does not send messages/);
      assert.doesNotMatch(error.message, /before resending/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Nigerian bulk providers distinguish credentials, permissions, fields and rate limits without retrying", async () => {
  for (const adapter of [nigeriaAdapters.bulksmsnigeria, nigeriaAdapters.smartsmssolutions]) {
    for (const [status, reason, guidance] of [
      [400, "http_error", /request fields/], [401, "authentication", /credentials and account environment/],
      [403, "authentication", /permission.*request/], [422, "http_error", /request fields/],
      [429, "rate_limited", /Wait before trying again.*Review campaign results/],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(`secret-upstream ${credentials.apiToken}`, { status });
      }) as typeof fetch;
      await assert.rejects(adapter.send(credentials, input), error => {
        outcome("rejected")(error);
        assert.ok(error instanceof ProviderError);
        assert.equal(error.reason, reason);
        assert.equal(error.upstreamStatus, status);
        assert.match(error.message, guidance);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("Sendchamp preserves the safe throttling action on the failed recipient without retrying", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(`secret-upstream ${credentials.apiToken}`, { status: 429 });
  }) as typeof fetch;
  const [result] = await nigeriaAdapters.sendchamp.send(credentials, input);
  assert.equal(result.status, "failed");
  assert.equal(result.providerId, null);
  assert.match(result.reason || "", /HTTP 429.*Wait before trying again.*Review campaign results/);
  assert.doesNotMatch(JSON.stringify(result), /secret-upstream|nigeria-adapter-test-token/);
  assert.equal(calls, 1);
});
