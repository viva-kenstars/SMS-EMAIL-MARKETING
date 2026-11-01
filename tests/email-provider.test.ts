import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReoonError,
  createReoonBulkTask,
  getReoonBalance,
  normalizeEmailIdentity,
  pollReoonBulkTask,
  verifyReoonSinglePower,
} from "../app/lib/email/reoon.ts";
import type { ReoonErrorKind, ReoonOptions, ReoonSubmissionOutcome } from "../app/lib/email/reoon.ts";

const apiKey = "reoon-test-key-not-a-real-credential";
const email = "Member+test@example.net";
const secondEmail = "Another@example.net";
const addresses = Array.from({ length: 10 }, (_, index) => `Member${index}@example.net`);

function options(fetcher: typeof globalThis.fetch, extra: Partial<ReoonOptions> = {}): ReoonOptions {
  return { apiKey, fetch: fetcher, ...extra };
}

function reply(body: unknown, status = 200, extra: Partial<ReoonOptions> = {}): ReoonOptions {
  return options(async () => Response.json(body, { status }), extra);
}

function safeRow(address = email): Record<string, unknown> {
  return { email: address, status: "safe", is_safe_to_send: true, is_deliverable: true,
    is_disposable: false, is_role_account: false, has_inbox_full: false,
    is_catch_all: false, is_disabled: false, is_spamtrap: false };
}

function completed(results: unknown, taskId: unknown = "123456"): Record<string, unknown> {
  return { status: "completed", task_id: taskId, results };
}

function outcome(kind: ReoonErrorKind, submissionOutcome: ReoonSubmissionOutcome, taskId?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ReoonError);
    assert.equal(error.kind, kind);
    assert.equal(error.submissionOutcome, submissionOutcome);
    if (taskId !== undefined) assert.equal(error.taskId, taskId);
    const serialized = JSON.stringify({ ...error, message: error.message });
    assert.doesNotMatch(serialized, /reoon-test-key|Member\+test|secret-upstream|emailverifier\.reoon\.com/);
    return true;
  };
}

test("identity normalization preserves local-part case and plus tags while lowercasing only the domain", () => {
  assert.equal(normalizeEmailIdentity("Member+test@EXAMPLE.NET"), email);
  assert.notEqual(normalizeEmailIdentity("member+test@example.net"), email);
  for (const value of ["", " User@example.net", "User@example.net ", "Display <User@example.net>",
    '"User"@example.net', "üser@example.net", "User@éxample.net", "a..b@example.net", ".a@example.net",
    "a.@example.net", "a@@example.net", "a@-bad.example", "a@bad_.example", "a@localhost",
    "a@example.net\n", `${"a".repeat(65)}@example.net`, `a@${"x".repeat(64)}.net`]) {
    assert.equal(normalizeEmailIdentity(value), null, value);
  }
});

test("balance uses a fixed HTTPS origin, encoded key, manual redirects and no-store", async () => {
  const credentials = "test+key/with=punctuation";
  const result = await getReoonBalance(options(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://emailverifier.reoon.com");
    assert.equal(url.pathname, "/api/v1/check-account-balance/");
    assert.equal(url.searchParams.get("key"), credentials);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return Response.json({ status: "success", api_status: "active", remaining_daily_credits: 20, remaining_instant_credits: "5000" });
  }, { apiKey: credentials }));
  assert.deepEqual(result, { apiStatus: "active", dailyCredits: 20, instantCredits: 5000 });
});

test("a confirmed zero balance is valid; absent, malformed or failed balances never become zero", async () => {
  const base = { status: "success", api_status: "active", remaining_daily_credits: 0, remaining_instant_credits: 0 };
  assert.deepEqual(await getReoonBalance(reply(base)), { dailyCredits: 0, instantCredits: 0, apiStatus: "active" });
  for (const body of [{}, { ...base, status: "failed" }, { ...base, remaining_daily_credits: null },
    { ...base, remaining_instant_credits: -1 }, { ...base, remaining_instant_credits: true },
    { ...base, remaining_instant_credits: "1.5" }, { ...base, remaining_instant_credits: "9 credits" },
    { ...base, remaining_instant_credits: Number.MAX_SAFE_INTEGER, remaining_daily_credits: 1 }]) {
    await assert.rejects(getReoonBalance(reply(body)), outcome("invalid_response", "not_submitted"));
  }
});

test("bulk sends one JSON request, normalizes domain case, and retains an acknowledged task", async () => {
  let calls = 0;
  const task = await createReoonBulkTask(options(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.href, "https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/");
    assert.equal(url.search, "");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "Trezad-test", emails: addresses, key: apiKey });
    return Response.json({ status: "success", task_id: 123456, count_submitted: 10,
      count_processing: 10, count_duplicates_removed: 0 }, { status: 201 });
  }), addresses.map(value => value.replace("example.net", "EXAMPLE.NET")), "Trezad-test");
  assert.equal(calls, 1);
  assert.deepEqual(task, { taskId: "123456", submittedCount: 10, processingCount: 10,
    duplicatesRemoved: 0, rejectedCount: null });
});

test("bulk rejects invalid cardinality, duplicates, addresses and names before contacting Reoon", async () => {
  let calls = 0;
  const opts = options(async () => { calls++; throw new Error("No network allowed"); });
  for (const list of [[], addresses.slice(0, 9), [...addresses, addresses[0]],
    [...addresses, addresses[0].replace("example.net", "EXAMPLE.NET")],
    [...addresses.slice(0, 9), "Display <bad@example.net>"],
    Array.from({ length: 50_001 }, (_, index) => `m${index}@example.net`)]) {
    await assert.rejects(createReoonBulkTask(opts, list), outcome("rejected", "not_submitted"));
  }
  await assert.rejects(createReoonBulkTask(opts, addresses, "x".repeat(26)), outcome("rejected", "not_submitted"));
  await assert.rejects(createReoonBulkTask(opts, addresses, "bad\nname"), outcome("rejected", "not_submitted"));
  assert.equal(calls, 0);
});

test("the adapter accepts the documented 50,000-address provider ceiling", async () => {
  const largeList = Array.from({ length: 50_000 }, (_, index) => `m${index}@example.net`);
  const task = await createReoonBulkTask(reply({ status: "success", task_id: "123456", count_submitted: 50_000,
    count_processing: 50_000, count_duplicates_removed: 0, count_rejected_emails: 0 }, 201), largeList);
  assert.equal(task.processingCount, 50_000);
});

test("creation requires HTTP201 plus success and a safe task ID, without retrying ambiguous acknowledgements", async () => {
  for (const [body, status] of [
    [{ status: "success", task_id: "123456" }, 200],
    [{ status: "success" }, 201],
    [{ status: "success", task_id: "secret-upstream\n123" }, 201],
    [{ status: "success", task_id: 9007199254740992 }, 201],
    [{ status: "waiting", task_id: "123456" }, 201],
  ] as const) {
    let calls = 0;
    await assert.rejects(createReoonBulkTask(options(async () => {
      calls++;
      return Response.json(body, { status });
    }), addresses), outcome("uncertain", "uncertain"));
    assert.equal(calls, 1);
  }
});

test("accepted tasks with corrupt counts retain their ID and cannot be mistaken for an unsent request", async () => {
  for (const counts of [{ count_submitted: 9 }, { count_processing: -1 }, { count_rejected_emails: null },
    { count_processing: 9, count_duplicates_removed: 0, count_rejected_emails: 0 }]) {
    await assert.rejects(createReoonBulkTask(reply({ status: "success", task_id: "123456", ...counts }, 201), addresses),
      outcome("invalid_response", "accepted", "123456"));
  }
});

test("provider rejection categories are useful without leaking provider text, emails or credentials", async () => {
  for (const [reason, kind] of [
    ["Invalid API key", "auth"], ["Insufficient credits", "credits"],
    ["Too many requests", "rate_limit"], ["Service unavailable", "temporary"], ["Unexpected rejection", "rejected"],
  ] as const) {
    const opts = reply({ status: "error", reason: `${reason}: secret-upstream ${apiKey} ${email}` }, 400);
    await assert.rejects(createReoonBulkTask(opts, addresses), outcome(kind, "rejected"));
  }
});

test("HTTP authentication, credit and rate errors are confirmed rejections with bounded retry guidance", async () => {
  for (const [status, kind] of [[401, "auth"], [403, "auth"], [402, "credits"], [429, "rate_limit"]] as const) {
    const opts = options(async () => new Response(`secret-upstream ${apiKey}`, { status, headers: { "Retry-After": "120" } }));
    await assert.rejects(createReoonBulkTask(opts, addresses), (error: unknown) => {
      assert.ok(outcome(kind, "rejected")(error));
      assert.equal((error as ReoonError).retryAfterSeconds, 120);
      return true;
    });
  }
});

test("redirects, server errors and network failures never trigger a second creation attempt", async () => {
  for (const status of [302, 408, 500, 503]) {
    let calls = 0;
    const opts = options(async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response("secret-upstream", { status, headers: { Location: "https://example.org/collect" } });
    });
    await assert.rejects(createReoonBulkTask(opts, addresses), outcome("uncertain", "uncertain"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(createReoonBulkTask(options(async () => {
    calls++;
    throw new Error(`secret-upstream ${apiKey} ${email}`);
  }), addresses), outcome("uncertain", "uncertain"));
  assert.equal(calls, 1);
  await assert.rejects(getReoonBalance(reply({}, 503)), outcome("temporary", "not_submitted"));
});

test("fetch timeout aborts the request, even if the injected fetch ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const opts = options(async (_input, init) => {
    calls++;
    signal = init?.signal;
    return await new Promise<Response>(() => {});
  }, { timeoutMs: 10 });
  await assert.rejects(createReoonBulkTask(opts, addresses), outcome("uncertain", "uncertain"));
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("response-body stalls are also timed out and cancelled", async () => {
  let cancelled = false;
  const opts = options(async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  })), { timeoutMs: 10 });
  await assert.rejects(getReoonBalance(opts), outcome("temporary", "not_submitted"));
  assert.equal(cancelled, true);
});

test("response size is bounded by actual streamed bytes as well as Content-Length", async () => {
  for (const withLength of [false, true]) {
    let cancelled = false;
    const opts = options(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(129))); },
      cancel() { cancelled = true; },
    }), { headers: withLength ? { "Content-Length": "129" } : {} }), { maxResponseBytes: 128 });
    await assert.rejects(getReoonBalance(opts), outcome("invalid_response", "not_submitted"));
    assert.equal(cancelled, true);
  }
  await assert.rejects(createReoonBulkTask(options(async () => new Response("x".repeat(129), { status: 201 }),
    { maxResponseBytes: 128 }), addresses), outcome("uncertain", "uncertain"));
});

test("malformed and non-object JSON never count as a successful acknowledgement", async () => {
  for (const value of ["not-json", "[]", "null", "true", '"success"']) {
    await assert.rejects(createReoonBulkTask(options(async () => new Response(value, { status: 201 })), addresses),
      outcome("uncertain", "uncertain"));
    await assert.rejects(getReoonBalance(options(async () => new Response(value))), outcome("invalid_response", "not_submitted"));
  }
});

test("invalid UTF-8 cancels an unfinished response without exposing its contents", async () => {
  let cancelled = false;
  const opts = options(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0xff])); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(getReoonBalance(opts), outcome("invalid_response", "not_submitted"));
  assert.equal(cancelled, true);
});

test("invalid credentials/options fail locally without network", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  for (const key of ["", " key", "key\nsecret"]) {
    await assert.rejects(getReoonBalance(options(fetcher, { apiKey: key })), outcome("auth", "not_submitted"));
  }
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120_001 },
    { maxResponseBytes: 0 }, { maxResponseBytes: 33 * 1024 * 1024 }]) {
    await assert.rejects(getReoonBalance(options(fetcher, extra)), outcome("rejected", "not_submitted"));
  }
  assert.equal(calls, 0);
});

test("poll uses task_id, confirms returned identity, and exposes progress without premature results", async () => {
  const result = await pollReoonBulkTask(options(async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/get-result-bulk-verification-task/");
    assert.equal(url.searchParams.get("task_id"), "123456");
    assert.equal(url.searchParams.has("task-id"), false);
    return Response.json({ status: "running", task_id: 123456, count_total: 10, count_checked: 4,
      progress_percentage: 40.0, results: { [email]: safeRow() } });
  }), "123456", [email]);
  assert.deepEqual(result, { taskId: "123456", status: "running", totalCount: 10, checkedCount: 4,
    progressPercent: 40, identityMatched: false, results: [] });
  for (const id of ["999999", "123456\n", 9007199254740992, null]) {
    await assert.rejects(pollReoonBulkTask(reply(completed({}, id)), "123456", [email]), outcome("invalid_response", "not_submitted"));
  }
});

test("both documented result shapes map exactly to requested identities", async () => {
  for (const results of [{ "Member+test@EXAMPLE.NET": safeRow("Member+test@example.net") }, [safeRow()]]) {
    const result = await pollReoonBulkTask(reply(completed(results)), "123456", ["Member+test@EXAMPLE.NET"]);
    assert.equal(result.identityMatched, true);
    assert.deepEqual(result.results, [{ email, category: "valid", reason: "safe", providerStatus: "safe" }]);
  }
});

test("completed reconciliation identity is strict even when normalized output still has all expected addresses", async () => {
  for (const results of [
    [safeRow("Different@example.net")], // Same count, completely different task.
    [safeRow("member+test@example.net")], // Local-part case must not be folded.
    [],
    [safeRow(), safeRow()],
    [safeRow(), safeRow("Unsolicited@example.org")],
    [safeRow(), null],
    { [email]: safeRow("Different@example.net") },
    { [email]: { status: "safe" } },
  ]) {
    const result = await pollReoonBulkTask(reply(completed(results)), "123456", [email]);
    assert.equal(result.status, "completed");
    assert.equal(result.identityMatched, false);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].email, email);
  }
  const unknown = await pollReoonBulkTask(reply(completed([{ email, status: "unknown" }])), "123456", [email]);
  assert.equal(unknown.identityMatched, true, "An identified Unknown verdict still belongs to the requested task.");
  assert.equal(unknown.results[0].category, "unknown");
});

test("all documented mailbox statuses retain their distinct meaning", async () => {
  const statuses = ["safe", "invalid", "disabled", "disposable", "inbox_full", "catch_all", "role_account", "spamtrap", "unknown"];
  const expected = ["valid", "invalid", "invalid", "risky", "risky", "risky", "risky", "risky", "unknown"];
  const requested = statuses.map((_, index) => `m${index}@example.net`);
  const rows = statuses.map((status, index) => status === "safe" ? safeRow(requested[index])
    : { email: requested[index], status, is_safe_to_send: false, is_spamtrap: "None" });
  const result = await pollReoonBulkTask(reply(completed(rows)), "123456", requested);
  assert.deepEqual(result.results.map(row => row.category), expected);
});

test("safe classification requires actual booleans and every documented risk flag", async () => {
  for (const field of ["is_safe_to_send", "is_deliverable", "is_disposable", "is_role_account", "has_inbox_full",
    "is_catch_all", "is_disabled", "is_spamtrap"]) {
    for (const value of [undefined, null, "false", "true", "None", 0, 1]) {
      const row = { ...safeRow(), [field]: value };
      const result = await pollReoonBulkTask(reply(completed([row])), "123456", [email]);
      assert.equal(result.results[0].category, "unknown", `${field}=${String(value)}`);
    }
  }
  for (const field of ["is_valid_syntax", "mx_accepts_mail", "can_connect_smtp"]) {
    const result = await pollReoonBulkTask(reply(completed([{ ...safeRow(), [field]: false }])), "123456", [email]);
    assert.equal(result.results[0].category, "unknown");
  }
});

test("catch-all, role, disposable, full-inbox and trap flags cannot be overridden by safe", async () => {
  for (const field of ["is_disposable", "is_role_account", "has_inbox_full", "is_catch_all", "is_spamtrap"]) {
    const result = await pollReoonBulkTask(reply(completed([{ ...safeRow(), [field]: true }])), "123456", [email]);
    assert.equal(result.results[0].category, "risky");
  }
  const disabled = await pollReoonBulkTask(reply(completed([{ ...safeRow(), is_disabled: true }])), "123456", [email]);
  assert.equal(disabled.results[0].category, "unknown");
  const future = await pollReoonBulkTask(reply(completed([{ ...safeRow(), status: "secret-upstream" }])), "123456", [email]);
  assert.equal(future.results[0].category, "unknown");
  assert.equal(future.results[0].providerStatus, null);
});

test("missing, duplicate, local-case-mismatched and unsolicited rows never become valid", async () => {
  const result = await pollReoonBulkTask(reply(completed([
    safeRow(), safeRow("Member+test@EXAMPLE.NET"), safeRow("another@example.net"), safeRow("Unsolicited@example.org"),
  ])), "123456", [email, secondEmail]);
  assert.deepEqual(result.results.map(row => [row.email, row.category, row.reason]), [
    [email, "unknown", "duplicate_result"], [secondEmail, "unknown", "missing_result"],
  ]);
  assert.equal(result.results.length, 2);
});

test("key/row identity conflicts taint affected addresses even when another apparently safe row exists", async () => {
  const result = await pollReoonBulkTask(reply(completed({ [email]: safeRow(secondEmail), [secondEmail]: safeRow(secondEmail) })),
    "123456", [email, secondEmail]);
  assert.deepEqual(result.results.map(row => row.category), ["unknown", "unknown"]);
  const missingIdentity = await pollReoonBulkTask(reply(completed({ [email]: { ...safeRow(), email: undefined } })), "123456", [email]);
  assert.equal(missingIdentity.results[0].category, "unknown");
});

test("duplicate JSON object keys are rejected before JSON.parse can hide conflicting results", async () => {
  const row = JSON.stringify(safeRow());
  const body = `{"status":"completed","task_id":"123456","results":{"${email}":${row},"${email}":${row}}}`;
  await assert.rejects(pollReoonBulkTask(options(async () => new Response(body)), "123456", [email]),
    outcome("invalid_response", "not_submitted"));
  const duplicateAck = '{"status":"error","status":"success","task_id":"123456"}';
  await assert.rejects(createReoonBulkTask(options(async () => new Response(duplicateAck, { status: 201 })), addresses),
    outcome("uncertain", "uncertain"));
});

test("completed tasks require a result collection; missing rows are explicit Unknown outcomes", async () => {
  for (const results of [undefined, null, true, "secret-upstream"]) {
    await assert.rejects(pollReoonBulkTask(reply(completed(results)), "123456", [email]), outcome("invalid_response", "not_submitted"));
  }
  for (const results of [{}, []]) {
    const result = await pollReoonBulkTask(reply(completed(results)), "123456", [email]);
    assert.equal(result.status, "completed");
    assert.equal(result.results[0].category, "unknown");
    assert.equal(result.results[0].reason, "missing_result");
  }
});

test("task terminal error states and future statuses cannot be interpreted as completion", async () => {
  for (const status of ["waiting", "file_not_found", "file_loading_error", "future_status"]) {
    const result = await pollReoonBulkTask(reply({ status, task_id: "123456" }), "123456", [email]);
    assert.equal(result.status, status === "future_status" ? "unknown" : status);
    assert.deepEqual(result.results, []);
  }
  for (const counters of [{ count_total: -1 }, { count_checked: true }, { count_total: 1, count_checked: 2 },
    { progress_percentage: 101 }, { progress_percentage: null }]) {
    await assert.rejects(pollReoonBulkTask(reply({ status: "running", task_id: "123456", ...counters }), "123456", [email]),
      outcome("invalid_response", "not_submitted"));
  }
});

test("single verification explicitly requests Power mode and preserves encoded plus aliases", async () => {
  const result = await verifyReoonSinglePower(options(async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://emailverifier.reoon.com");
    assert.equal(url.pathname, "/api/v1/verify");
    assert.equal(url.searchParams.get("mode"), "power");
    assert.equal(url.searchParams.get("email"), email);
    assert.equal(url.searchParams.get("key"), apiKey);
    return Response.json({ ...safeRow(), verification_mode: "power" });
  }), "Member+test@EXAMPLE.NET");
  assert.equal(result.category, "valid");
  for (const row of [{ ...safeRow(), verification_mode: "quick" }, safeRow(),
    { ...safeRow("member+test@example.net"), verification_mode: "power" }]) {
    assert.equal((await verifyReoonSinglePower(reply(row), email)).category, "unknown");
  }
});

test("single verification failures also preserve uncertainty and redact reflected inputs", async () => {
  let calls = 0;
  await assert.rejects(verifyReoonSinglePower(options(async () => {
    calls++;
    throw new Error(`secret-upstream ${apiKey} ${email}`);
  }), email), outcome("uncertain", "uncertain"));
  assert.equal(calls, 1);
});
