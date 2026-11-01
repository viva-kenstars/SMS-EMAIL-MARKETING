import assert from "node:assert/strict";
import { test } from "node:test";
import { emailCsvCell, emailCsvRows, exportEmailResults, type EmailExportRow } from "../app/lib/email/export.ts";

test("CSV neutralizes formulas and quotes untrusted input", () => {
  assert.equal(emailCsvCell('=HYPERLINK("https://example.net")'), '"\'=HYPERLINK(""https://example.net"")"');
  assert.equal(emailCsvCell("  +1"), '"\'  +1"');
  assert.equal(emailCsvCell("a@example.net"), '"a@example.net"');
  assert.ok(emailCsvRows([{ email: "a@example.net", sourceRow: 2, status: "unknown", reason: "Unconfirmed", checkedAt: 0 }]).includes("1970-01-01T00:00:00.000Z"));
});

test("a51,007-row export writes incremental pages into one file", async () => {
  let written = 0, closed = false, aborted = false, calls = 0;
  const browser = globalThis as any;
  const original = browser.showSaveFilePicker;
  browser.showSaveFilePicker = async () => ({ createWritable: async () => ({
    write: async (chunk: string) => { written += chunk.split("\r\n").length - 1; assert.ok(chunk.length < 500_000); },
    close: async () => { closed = true; }, abort: async () => { aborted = true; },
  }) });
  try {
    const count = 51_007;
    const result = await exportEmailResults({ fileName: "all-results.csv", fetchPage: async (cursor = 0) => {
      calls++;
      const end = Math.min(cursor + 1000, count);
      const rows: EmailExportRow[] = Array.from({ length: end - cursor }, (_, i) => ({ email: `user${cursor + i}@example.net`, sourceRow: cursor + i + 1, status: "valid", reason: "Safe", checkedAt: 0 }));
      return { rows, nextCursor: end < count ? end : null };
    } });
    assert.equal(result.count, count); assert.equal(result.mode, "stream"); assert.equal(result.nextCursor, null);
    assert.equal(written, count + 1); assert.equal(calls, 52); assert.equal(closed, true); assert.equal(aborted, false);
  } finally { browser.showSaveFilePicker = original; }
});

test("a repeated cursor aborts the output instead of looping or repeating records", async () => {
  const browser = globalThis as any;
  const original = browser.showSaveFilePicker;
  let aborted = false;
  browser.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => { aborted = true; } }) });
  try {
    await assert.rejects(exportEmailResults({ fileName: "results", fetchPage: async () => ({ rows: [], nextCursor: 0 }) }), /cursor did not advance/i);
    assert.equal(aborted, true);
  } finally { browser.showSaveFilePicker = original; }
});

test("cancelling the picker never triggers a fallback download", async () => {
  const browser = globalThis as any;
  const original = browser.showSaveFilePicker;
  let fetched = false;
  browser.showSaveFilePicker = async () => { throw new DOMException("Cancelled", "AbortError"); };
  try {
    await assert.rejects(exportEmailResults({ fileName: "results", fetchPage: async () => { fetched = true; return { rows: [], nextCursor: null }; } }), { name: "AbortError" });
    assert.equal(fetched, false);
  } finally { browser.showSaveFilePicker = original; }
});
