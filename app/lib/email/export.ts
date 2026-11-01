/** Export pages incrementally. Full-list downloads never require one giant API response. */
export type EmailExportRow = {
  email: string; originalEmail?: string; sourceRow: number | string | null;
  status: string; reason: string; checkedAt?: number | null;
};
export type EmailExportOptions = {
  fileName: string;
  fetchPage: (cursor?: number) => Promise<{ rows: EmailExportRow[]; nextCursor: number | null }>;
  onProgress?: (count: number) => void;
  signal?: AbortSignal;
  cursor?: number;
};
export type EmailExportResult = { count: number; parts: number; mode: "stream" | "parts"; nextCursor: number | null };
type WritableFile = { write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type FilePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableFile> }>;
const encoder = new TextEncoder();
const HEADER = "\uFEFFSource row,Email address,Original value,Status,Reason,Checked at (UTC)\r\n";
const PART_BYTES = 8 * 1024 * 1024;
const PART_ROWS = 50_000;

export function emailCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // CSV files may be opened in Excel. Prevent an address/input/reason from
  // becoming a spreadsheet formula, including after leading whitespace.
  if (/^\s*[=+\-@\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function emailCsvRows(rows: EmailExportRow[]): string {
  return rows.map(row => {
    const checked = typeof row.checkedAt === "number" && Number.isFinite(row.checkedAt) ? new Date(row.checkedAt) : null;
    return [row.sourceRow, row.email, row.originalEmail ?? row.email, row.status, row.reason,
      checked && !Number.isNaN(checked.getTime()) ? checked.toISOString() : ""].map(emailCsvCell).join(",") + "\r\n";
  }).join("");
}

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
}

function nameFor(value: string) {
  const clean = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 160).replace(/\.csv$/i, "");
  return `${clean || "email-results"}.csv`;
}

export async function exportEmailResults(options: EmailExportOptions): Promise<EmailExportResult> {
  abort(options.signal);
  const fileName = nameFor(options.fileName);
  const browser = globalThis as typeof globalThis & { showSaveFilePicker?: FilePicker };
  let sink: WritableFile | null = null;
  if (options.cursor === undefined && typeof browser.showSaveFilePicker === "function") {
    // Call synchronously from the user's click, before any fetch can consume
    // the browser's user activation. No other code receives the file handle.
    try {
      const handle = await browser.showSaveFilePicker({ suggestedName: fileName, types: [{ description: "CSV results", accept: { "text/csv": [".csv"] } }] });
      sink = await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Sandboxed embeds or browsers without picker permission can download
      // bounded parts using the normal browser download action below.
      if (!(error instanceof DOMException) || !["SecurityError", "NotAllowedError", "NotSupportedError"].includes(error.name)) throw error;
    }
  }
  const parts: string[] = [];
  let count = 0, bytes = encoder.encode(HEADER).byteLength;
  let cursor = options.cursor;
  try {
    if (sink) await sink.write(HEADER); else parts.push(HEADER);
    for (;;) {
      abort(options.signal);
      const page = await options.fetchPage(cursor);
      abort(options.signal);
      if (!Array.isArray(page.rows) || page.rows.length > 1000) throw new Error("The export returned an invalid page. Refresh the results and retry.");
      if (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= (cursor ?? 0))) throw new Error("The export cursor did not advance. Retry from the last saved part.");
      const csv = emailCsvRows(page.rows);
      if (sink) await sink.write(csv); else parts.push(csv);
      count += page.rows.length;
      bytes += encoder.encode(csv).byteLength;
      options.onProgress?.(count);
      if (page.nextCursor === null || !sink && (bytes >= PART_BYTES || count >= PART_ROWS)) {
        if (sink) {
          await sink.close();
          return { count, parts: 1, mode: "stream", nextCursor: null };
        }
        const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return { count, parts: 1, mode: "parts", nextCursor: page.nextCursor };
      }
      if (page.rows.length === 0) throw new Error("The export returned an empty continuation page. Retry after refreshing the results.");
      cursor = page.nextCursor;
    }
  } catch (error) {
    if (sink) try { await sink.abort(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
