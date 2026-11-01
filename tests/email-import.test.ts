import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmailChunks, previewEmailImport } from "../app/lib/email/import.ts";

async function rows(source: string | Blob, options: Parameters<typeof parseEmailChunks>[1]) {
  const result = [];
  for await (const chunk of parseEmailChunks(source, options)) result.push(...chunk.rows);
  return result;
}

test("CSV preview identifies the email column and handles BOM, escaped quotes and multiline cells", async () => {
  const source = '\uFEFFName,Email,Note\r\n"A, B",first@example.net,"two\nlines"\r\n"A ""quote""",second@example.net,ok\r\n';
  const preview = await previewEmailImport(source, { format: "csv" });
  assert.equal(preview.hasHeader, true);
  assert.equal(preview.suggestedEmailColumn, 1);
  assert.equal(preview.sampleRows[0][2], "two\nlines");
  assert.equal(preview.sampleRows[1][0], 'A "quote"');
  assert.deepEqual(await rows(source, { format: "csv", hasHeader: true, emailColumn: 1 }), [
    { email: "first@example.net", sourceRow: 2 }, { email: "second@example.net", sourceRow: 3 },
  ]);
});

test("50,001 records stream in bounded chunks without a 20k cap", async () => {
  const count = 50_001;
  const source = new Blob(["Email\n", Array.from({ length: count }, (_, i) => `user${i}@example.net`).join("\n")]);
  let total = 0, expectedIndex = 0;
  for await (const chunk of parseEmailChunks(source, { format: "csv", hasHeader: true })) {
    assert.equal(chunk.index, expectedIndex++);
    assert.ok(chunk.rows.length <= 500);
    assert.equal(chunk.rows[0].sourceRow, total + 2);
    total += chunk.rows.length;
  }
  assert.equal(total, count);
  assert.equal(expectedIndex, 101);
});

test("all four delimiter/header choices remain deterministic for resumed imports", async () => {
  for (const delimiter of [",", ";", "\t"] as const) {
    const data = `Name${delimiter}Email\r\nOne${delimiter}one@example.net\r\nTwo${delimiter}\r\n`;
    const options = { format: "csv" as const, delimiter, hasHeader: true, emailColumn: 1, chunkSize: 1 };
    assert.deepEqual(await rows(data, options), await rows(new Blob([data]), options));
    assert.equal((await rows(data, options))[1].email, "");
  }
  assert.deepEqual(await rows("one@example.net; two@example.net\r\nthree@example.net", { format: "text" }), [
    { email: "one@example.net", sourceRow: 1 }, { email: "two@example.net", sourceRow: 1 }, { email: "three@example.net", sourceRow: 2 },
  ]);
});

test("quoted fields and CRLF split across read boundaries parse correctly", async () => {
  // Place an escaped quote across the64KB file-read boundary without exceeding
  // the independent record-size limit: previous small records consume space.
  const prefix = "a@example.net\r\n".repeat(4500);
  const source = new Blob([prefix, '"hello ""world""";end@example.net\r\n']);
  const result = await rows(source, { format: "csv", delimiter: ";", emailColumn: 0 });
  assert.equal(result.length, 4501);
  assert.equal(result.at(-1)?.email, 'hello "world"');
});

test("bad CSV, unsupported UTF-8 and oversized individual values fail explicitly", async () => {
  await assert.rejects(rows('Email\n"unclosed', { format: "csv", hasHeader: true }), /unclosed/i);
  await assert.rejects(rows('"ok"junk@example.net', { format: "csv" }), /closing quote/i);
  await assert.rejects(rows(new Blob([new Uint8Array([0xc0, 0xaf])]), { format: "text" }), /UTF-8/i);
  await assert.rejects(rows("a".repeat(2049), { format: "text" }), /too long/i);
  await assert.rejects(rows("a@example.net", { format: "text", chunkSize: 20000 }), /between 1 and 500/i);
});

test("cancelled imports stop before uploading further chunks", async () => {
  const controller = new AbortController();
  const iterator = parseEmailChunks("a@example.net\nb@example.net", { format: "text", chunkSize: 1, signal: controller.signal });
  assert.equal((await iterator.next()).value?.rows.length, 1);
  controller.abort();
  await assert.rejects(iterator.next(), { name: "AbortError" });
});

test("headerless CSV never discards a first address during automatic preview", async () => {
  const value = "Email,first@example.net\nSecond,second@example.net";
  const preview = await previewEmailImport(value, { format: "csv" });
  assert.equal(preview.hasHeader, false);
  assert.equal(preview.suggestedEmailColumn, 1);
  assert.equal(preview.sampleRows[0][1], "first@example.net");
});

test("large Unicode cells produce smaller deterministic chunks within the request byte limit", async () => {
  const value = Array.from({ length: 1000 }, () => "漢".repeat(1000)).join("\n");
  let count = 0, chunks = 0;
  for await (const chunk of parseEmailChunks(value, { format: "text" })) {
    assert.ok(new TextEncoder().encode(JSON.stringify({ index: chunk.index, rows: chunk.rows })).byteLength < 1_048_576);
    count += chunk.rows.length; chunks++;
  }
  assert.equal(count, 1000); assert.ok(chunks > 2);
});
