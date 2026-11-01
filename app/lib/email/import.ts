/** Bounded, browser-friendly readers. A total list-size limit is deliberately absent. */
export type EmailImportOptions = {
  format: "csv" | "text";
  delimiter?: "," | ";" | "\t";
  hasHeader?: boolean;
  emailColumn?: number;
  chunkSize?: number;
  signal?: AbortSignal;
};
export type EmailImportChunk = {
  index: number;
  rows: { email: string; sourceRow: number }[];
  processedBytes: number;
};
export type EmailImportPreview = {
  columns: string[];
  sampleRows: string[][];
  suggestedEmailColumn: number;
  format: "csv" | "text";
  delimiter: "," | ";" | "\t";
  hasHeader: boolean;
  byteLength: number;
};

const READ_BYTES = 64 * 1024;
const MAX_RECORD_CHARS = 64 * 1024;
const MAX_FIELDS = 256;
const MAX_EMAIL_CHARS = 1024;
const MAX_CHUNK_BYTES = 768 * 1024;
const encoder = new TextEncoder();

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
}

async function* readText(source: string | Blob, signal?: AbortSignal): AsyncGenerator<{ text: string; bytes: number }> {
  let bytes = 0;
  if (typeof source === "string") {
    for (let offset = 0; offset < source.length;) {
      abort(signal);
      let end = Math.min(offset + READ_BYTES, source.length);
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
      const text = source.slice(offset, end);
      bytes += encoder.encode(text).byteLength;
      yield { text, bytes };
      offset = end;
    }
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < source.size; offset += READ_BYTES) {
    abort(signal);
    const buffer = await source.slice(offset, offset + READ_BYTES).arrayBuffer();
    abort(signal);
    let text: string;
    try { text = decoder.decode(buffer, { stream: true }); }
    catch { throw new Error("Save the file as UTF-8 CSV or text, then upload it again."); }
    bytes += buffer.byteLength;
    yield { text, bytes };
  }
  try {
    const text = decoder.decode();
    if (text) yield { text, bytes };
  } catch { throw new Error("The file ends with an incomplete UTF-8 character. Save it as UTF-8 and try again."); }
}

type RecordRow = { fields: string[]; sourceRow: number; bytes: number };
async function* readRecords(source: string | Blob, delimiter: string, signal?: AbortSignal): AsyncGenerator<RecordRow> {
  let fields: string[] = [], field = "", quoted = false, afterQuote = false;
  let start = true, skipLF = false, recordChars = 0, sourceRow = 1, bytes = 0;
  const finishField = () => {
    fields.push(field);
    field = ""; afterQuote = false;
    if (fields.length > MAX_FIELDS) throw new Error(`Row ${sourceRow} has too many columns. Upload only the columns you need.`);
  };
  for await (const block of readText(source, signal)) {
    bytes = block.bytes;
    for (let index = 0; index < block.text.length; index++) {
      const char = block.text[index];
      if (start) { start = false; if (char === "\uFEFF") continue; }
      if (skipLF) { skipLF = false; if (char === "\n") continue; }
      if (++recordChars > MAX_RECORD_CHARS) throw new Error(`Row ${sourceRow} is too large. Keep each CSV record under 65,536 characters.`);
      if (quoted) {
        if (char === '"') { quoted = false; afterQuote = true; }
        else field += char;
        continue;
      }
      if (afterQuote && char === '"') { field += '"'; quoted = true; afterQuote = false; continue; }
      if (char === delimiter) { finishField(); continue; }
      if (char === "\n" || char === "\r") {
        finishField();
        const row = { fields, sourceRow, bytes };
        fields = []; recordChars = 0; sourceRow++; skipLF = char === "\r";
        if (row.fields.some(value => value.trim())) yield row;
        continue;
      }
      if (afterQuote) {
        if (char === " " || char === "\t") continue;
        throw new Error(`Row ${sourceRow} contains text after a closing quote. Correct the CSV quoting and retry.`);
      }
      if (char === '"') {
        if (field.length !== 0) throw new Error(`Row ${sourceRow} contains an unexpected quote. Use CSV quotes around the whole field.`);
        quoted = true;
      } else field += char;
    }
  }
  if (quoted) throw new Error(`Row ${sourceRow} has an unclosed CSV quote.`);
  if (field || fields.length || afterQuote) {
    finishField();
    if (fields.some(value => value.trim())) yield { fields, sourceRow, bytes };
  }
}

async function* readPlain(source: string | Blob, signal?: AbortSignal): AsyncGenerator<RecordRow> {
  let token = "", sourceRow = 1, skipLF = false, first = true;
  let bytes = 0;
  for await (const block of readText(source, signal)) {
    bytes = block.bytes;
    for (const char of block.text) {
      if (first) { first = false; if (char === "\uFEFF") continue; }
      if (skipLF) { skipLF = false; if (char === "\n") continue; }
      if (/[\s,;]/u.test(char)) {
        if (token) { yield { fields: [token], sourceRow, bytes }; token = ""; }
        if (char === "\n" || char === "\r") { sourceRow++; skipLF = char === "\r"; }
      } else {
        token += char;
        if (token.length > MAX_EMAIL_CHARS) throw new Error(`An entry near line ${sourceRow} is too long to be an email address.`);
      }
    }
  }
  if (token) yield { fields: [token], sourceRow, bytes };
}

function guessDelimiter(text: string): "," | ";" | "\t" {
  const scores = new Map<"," | ";" | "\t", number>([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false, lines = 0;
  for (let i = 0; i < text.length && lines < 8; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (c === "\n") lines++;
    if (scores.has(c as "," | ";" | "\t")) scores.set(c as "," | ";" | "\t", scores.get(c as "," | ";" | "\t")! + 1);
  }
  return [...scores].sort((a, b) => b[1] - a[1])[0][0];
}

export async function previewEmailImport(source: string | Blob, options: Partial<EmailImportOptions> = {}): Promise<EmailImportPreview> {
  abort(options.signal);
  const byteLength = typeof source === "string" ? encoder.encode(source).byteLength : source.size;
  // Preview never reads the entire uploaded file; parsing below also streams it.
  let sample = "";
  for await (const block of readText(source, options.signal)) { sample = block.text; break; }
  const fileName = typeof source !== "string" && "name" in source ? String(source.name) : "";
  const format = options.format ?? (/\.(csv|tsv)$/i.test(fileName) ? "csv" : "text");
  const delimiter = options.delimiter ?? (/\.tsv$/i.test(fileName) ? "\t" : guessDelimiter(sample));
  const records: string[][] = [];
  const reader = format === "csv" ? readRecords(source, delimiter, options.signal) : readPlain(source, options.signal);
  for await (const row of reader) { records.push(row.fields); if (records.length >= 11) break; }
  const first = records[0] ?? [];
  const guessedHeader = format === "csv" && !first.some(cell => cell.includes("@")) && first.some(cell => /^e[-_ ]?mail(?:[-_ ]?address)?$/i.test(cell.trim()));
  const hasHeader = format === "csv" && (options.hasHeader ?? guessedHeader);
  const sampleRows = (hasHeader ? records.slice(1) : records).slice(0, 10);
  const width = Math.max(1, first.length, ...sampleRows.map(row => row.length));
  const columns = Array.from({ length: width }, (_, i) => hasHeader ? first[i]?.trim().slice(0, 100) || `Column ${i + 1}` : format === "text" ? "Email address" : `Column ${i + 1}`);
  let suggestedEmailColumn = hasHeader ? first.findIndex(cell => /^e[-_ ]?mail(?:[-_ ]?address)?$/i.test(cell.trim())) : -1;
  if (suggestedEmailColumn < 0) suggestedEmailColumn = Math.max(0, sampleRows[0]?.findIndex(cell => cell.includes("@")) ?? 0);
  return { columns, sampleRows, suggestedEmailColumn, format, delimiter, hasHeader, byteLength };
}

export async function* parseEmailChunks(source: string | Blob, options: EmailImportOptions): AsyncGenerator<EmailImportChunk> {
  const chunkSize = options.chunkSize ?? 500;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) throw new Error("Choose an import chunk size between 1 and 500.");
  const emailColumn = options.emailColumn ?? 0;
  if (!Number.isSafeInteger(emailColumn) || emailColumn < 0 || emailColumn >= MAX_FIELDS) throw new Error("Select an email column.");
  const reader = options.format === "csv" ? readRecords(source, options.delimiter ?? ",", options.signal) : readPlain(source, options.signal);
  let skipHeader = options.format === "csv" && !!options.hasHeader;
  let rows: EmailImportChunk["rows"] = [], index = 0, processedBytes = 0, chunkBytes = 64;
  for await (const row of reader) {
    abort(options.signal);
    processedBytes = row.bytes;
    if (skipHeader) { skipHeader = false; continue; }
    const email = row.fields[options.format === "text" ? 0 : emailColumn]?.trim() ?? "";
    if (email.length > MAX_EMAIL_CHARS) throw new Error(`The email value in row ${row.sourceRow} is too long. Select the correct email column.`);
    const value = { email, sourceRow: row.sourceRow };
    const valueBytes = encoder.encode(JSON.stringify(value)).byteLength + 1;
    if (rows.length && chunkBytes + valueBytes > MAX_CHUNK_BYTES) {
      yield { index: index++, rows, processedBytes }; rows = []; chunkBytes = 64;
    }
    rows.push(value); chunkBytes += valueBytes;
    if (rows.length === chunkSize) { yield { index: index++, rows, processedBytes }; rows = []; chunkBytes = 64; }
  }
  if (rows.length) yield { index, rows, processedBytes };
}
