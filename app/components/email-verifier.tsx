"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, Eye, EyeOff, FileText, Inbox, ListChecks, LoaderCircle, LockKeyhole, Mail, Pause, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, Wallet, X } from "lucide-react";
import type { EmailBalance, EmailBatch, EmailCategory, EmailJob, EmailResultRow, EmailSettings } from "../lib/email/types";
import { parseEmailChunks, previewEmailImport, type EmailImportOptions } from "../lib/email/import";
import { exportEmailResults } from "../lib/email/export";

type Filter = "all" | EmailCategory | "pending";
type Cursor = string | number | null;
type Runner = { enabled: boolean; healthy: boolean; lastHeartbeatAt: number | null; message: string };
type Results = { rows: EmailResultRow[]; nextCursor: number | null; total: number };
type ApiResults = Omit<Results, "nextCursor"> & { nextCursor: string | number | null };
const resultCursor = (value: string | number | null) => { if (value === null) return null; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("The result page returned an invalid continuation. Refresh the list and try again."); return parsed; };
type Preview = Awaited<ReturnType<typeof previewEmailImport>>;
type ApiError = Error & { status?: number; code?: string };
const blankSettings: EmailSettings = { configured: false, configurationAvailable: false, verifiedAt: null, revision: 0, credentialRevision: 0, balance: null };
const blankRunner: Runner = { enabled: false, healthy: false, lastHeartbeatAt: null, message: "Background worker status has not been checked." };
const blankResults: Results = { rows: [], nextCursor: null, total: 0 };
const number = (value = 0) => new Intl.NumberFormat("en-NG").format(value);
const date = (value: number | null) => value ? new Date(value).toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const readable = (value: string) => value.replace(/_/g, " ").replace(/^\w/, letter => letter.toUpperCase());
const categoryLabel = (value: Filter | "processing") => value === "all" ? "All addresses" : value === "processing" ? "Verifying" : readable(value);
const statusTone = (value: string) => ["valid", "completed"].includes(value) ? "active" : value === "invalid" ? "failed" : ["risky", "unknown", "needs_attention", "waiting_credits"].includes(value) ? "attention" : "neutral";
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
async function emailApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/email${path}`, { method: method || (body === undefined ? "GET" : "POST"), headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal });
  let data: any;
  try { data = await response.json(); } catch { throw new Error("The server response was interrupted. Refresh this list before repeating the action."); }
  if (!response.ok) { const error = new Error(typeof data.error === "string" ? data.error : "The email verification request could not be completed.") as ApiError; error.status = response.status; error.code = data.code; throw error; }
  return data as T;
}
function Badge({ value, children }: { value: string; children?: ReactNode }) { return <span className={`badge badge-${statusTone(value)}`}>{children || readable(value)}</span>; }
function Button({ children, busy, className = "secondary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) { return <button type="button" {...props} disabled={props.disabled || busy} className={`button ${className}`}>{busy && <LoaderCircle size={15} className="spin" />}{children}</button>; }
function Dialog({ title, onClose, locked, children }: { title: string; onClose: () => void; locked: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef({ locked, onClose }); current.current = { locked, onClose };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controls = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]') || []).filter(element => element.getClientRects().length);
    (controls()[0] || ref.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !current.current.locked) current.current.onClose();
      if (event.key !== "Tab") return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); ref.current?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); previous?.isConnected && previous.focus(); };
  }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.currentTarget === event.target && !locked) onClose(); }}><div className="modal email-confirm-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-heading"><div><h2>{title}</h2><p>Review the list and provider usage before continuing.</p></div><button type="button" className="icon-button" aria-label="Close review" disabled={locked} onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}

export default function EmailVerifier({ available, onNotify }: { available: boolean; onNotify: (message: string, error?: boolean) => void }) {
  const [settings, setSettings] = useState<EmailSettings>(blankSettings), [runner, setRunner] = useState<Runner>(blankRunner);
  const [loading, setLoading] = useState(true), [pageError, setPageError] = useState(""), [busy, setBusy] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false), [apiKey, setApiKey] = useState(""), [showKey, setShowKey] = useState(false), [removeConnection, setRemoveConnection] = useState(false), [balanceError, setBalanceError] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [jobs, setJobs] = useState<EmailJob[]>([]), [jobsLoading, setJobsLoading] = useState(false), [jobCursors, setJobCursors] = useState<Cursor[]>([null]), [jobPage, setJobPage] = useState(0), [nextJobsCursor, setNextJobsCursor] = useState<Cursor>(null);
  const [job, setJob] = useState<EmailJob | null>(null), [batches, setBatches] = useState<EmailBatch[]>([]), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState("");
  const [filter, setFilter] = useState<Filter>("all"), [results, setResults] = useState<Results>(blankResults), [resultsLoading, setResultsLoading] = useState(false), [resultsError, setResultsError] = useState(""), [resultCursors, setResultCursors] = useState<(number | null)[]>([null]), [resultPage, setResultPage] = useState(0);
  const [showImport, setShowImport] = useState(false), [sourceMode, setSourceMode] = useState<"file" | "paste">("file"), [file, setFile] = useState<File | null>(null), [pastedText, setPastedText] = useState(""), [listName, setListName] = useState("");
  const [format, setFormat] = useState<"csv" | "text">("csv"), [delimiter, setDelimiter] = useState<"," | ";" | "\t">(","), [hasHeader, setHasHeader] = useState(true), [emailColumn, setEmailColumn] = useState(0), [preview, setPreview] = useState<Preview | null>(null), [previewLoading, setPreviewLoading] = useState(false), [previewError, setPreviewError] = useState("");
  const [uploadTarget, setUploadTarget] = useState<EmailJob | null>(null), [uploading, setUploading] = useState(false), [uploadPaused, setUploadPaused] = useState(false), [uploadNotice, setUploadNotice] = useState(""), [uploadProgress, setUploadProgress] = useState({ rows: 0, chunks: 0, savedRows: 0, bytes: 0 });
  const [reviewStart, setReviewStart] = useState(false), [startAcknowledged, setStartAcknowledged] = useState(false), [cancelReview, setCancelReview] = useState(false), [taskIds, setTaskIds] = useState<Record<string, string>>({});
  const [exportCheckpoints, setExportCheckpoints] = useState<Record<string, { cursor: number; count: number; parts: number; version: number }>>({});
  const [advancing, setAdvancing] = useState(false), [browserHalted, setBrowserHalted] = useState(false), [browserError, setBrowserError] = useState(""), [exporting, setExporting] = useState(false), [exportCount, setExportCount] = useState(0), [exportFilter, setExportFilter] = useState<Filter>("all");
  const busyRef = useRef(busy); busyRef.current = busy;
  const mounted = useRef(true), settingsRef = useRef(settings), jobRef = useRef(job), runnerRef = useRef(runner), availableRef = useRef(available);
  const resultQuery = useRef({ filter, cursor: resultCursors[resultPage] }), jobsQuery = useRef({ cursor: jobCursors[jobPage] });
  const balanceInFlight = useRef<number | null>(null);
  const settingsSequence = useRef(0), jobSequence = useRef(0), resultsSequence = useRef(0), jobsSequence = useRef(0), balanceSequence = useRef(0);
  const uploadStop = useRef(false), advanceInFlight = useRef(false), exportAbort = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null);
  const importDetection = useRef({ complete: false, delimiterManual: false, headerManual: false, columnManual: false });
  const resetImportDetection = () => { importDetection.current = { complete: false, delimiterManual: false, headerManual: false, columnManual: false }; setPreview(null); setPreviewError(""); };
  const notifyRef = useRef(onNotify); notifyRef.current = onNotify;
  settingsRef.current = settings; jobRef.current = job; runnerRef.current = runner; availableRef.current = available;
  resultQuery.current = { filter, cursor: resultCursors[resultPage] }; jobsQuery.current = { cursor: jobCursors[jobPage] };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; uploadStop.current = true; exportAbort.current?.abort(); }; }, []);
  const applySettings = useCallback((next: EmailSettings) => {
    if (!mounted.current) return;
    if (next.credentialRevision < settingsRef.current.credentialRevision || next.credentialRevision === settingsRef.current.credentialRevision && next.revision < settingsRef.current.revision) return;
    if (settingsRef.current.credentialRevision !== next.credentialRevision) { balanceSequence.current++; balanceInFlight.current = null; setBalanceLoading(false); setBalanceError(""); }
    settingsRef.current = next; setSettings(next);
  }, []);
  const commitJob = useCallback((next: EmailJob) => {
    if (!mounted.current) return;
    setJobs(previous => previous.map(item => item.id === next.id ? next : item));
    if (jobRef.current?.id === next.id && next.updatedAt >= jobRef.current.updatedAt) { jobRef.current = next; setJob(next); }
  }, []);
  const loadSettings = useCallback(async () => {
    const sequence = ++settingsSequence.current;
    const response = await emailApi<{ settings: EmailSettings }>("/settings");
    if (sequence === settingsSequence.current && availableRef.current) applySettings(response.settings);
    return response.settings;
  }, [applySettings]);
  const loadRunner = useCallback(async () => {
    try { const next = await emailApi<Runner>("/runner"); if (mounted.current && availableRef.current) { setRunner(next); runnerRef.current = next; } }
    catch { if (mounted.current) setRunner({ ...blankRunner, message: "Background worker status is unavailable. Keep this page open while verification runs." }); }
  }, []);
  const loadJobs = useCallback(async () => {
    const sequence = ++jobsSequence.current, cursor = jobsQuery.current.cursor;
    setJobsLoading(true);
    try {
      const response = await emailApi<{ jobs: EmailJob[]; nextCursor: Cursor }>(`/jobs?limit=20${cursor === null ? "" : `&cursor=${encodeURIComponent(String(cursor))}`}`);
      if (mounted.current && sequence === jobsSequence.current) { setJobs(response.jobs); setNextJobsCursor(response.nextCursor); }
    } finally { if (mounted.current && sequence === jobsSequence.current) setJobsLoading(false); }
  }, []);
  const loadJob = useCallback(async (id = jobRef.current?.id) => {
    if (!id) return null;
    const sequence = ++jobSequence.current;
    const response = await emailApi<{ job: EmailJob; batches: EmailBatch[]; attentionBatches?: EmailBatch[] }>(`/jobs/${encodeURIComponent(id)}`);
    if (mounted.current && sequence === jobSequence.current && jobRef.current?.id === id) { commitJob(response.job); setBatches(response.attentionBatches || response.batches || []); setDetailError(""); }
    return response.job;
  }, [commitJob]);
  const loadResults = useCallback(async () => {
    const id = jobRef.current?.id; if (!id) return;
    const sequence = ++resultsSequence.current, query = resultQuery.current;
    setResultsLoading(true);
    try {
      const response = await emailApi<ApiResults>(`/jobs/${encodeURIComponent(id)}/results?limit=100&filter=${query.filter}${query.cursor === null ? "" : `&cursor=${query.cursor}`}`);
      if (mounted.current && sequence === resultsSequence.current && jobRef.current?.id === id) { setResults({ ...response, nextCursor: resultCursor(response.nextCursor) }); setResultsError(""); }
    } catch (error) { if (mounted.current && sequence === resultsSequence.current) setResultsError((error as Error).message); }
    finally { if (mounted.current && sequence === resultsSequence.current) setResultsLoading(false); }
  }, []);
  const refreshBalance = useCallback(async () => {
    const prior = settingsRef.current; if (!prior.configured || busyRef.current || balanceInFlight.current !== null) return;
    const sequence = ++balanceSequence.current, generation = prior.credentialRevision;
    balanceInFlight.current = sequence; setBalanceLoading(true);
    try {
      const response = await emailApi<{ balance: EmailBalance }>("/balance");
      if (!mounted.current || sequence !== balanceSequence.current || generation !== settingsRef.current.credentialRevision) return;
      if (response.balance.credentialRevision !== generation) { await loadSettings(); return; }
      applySettings({ ...settingsRef.current, balance: response.balance }); setBalanceError("");
    } catch (error) {
      if (mounted.current && sequence === balanceSequence.current && generation === settingsRef.current.credentialRevision) { setBalanceError((error as Error).message); if ((error as ApiError).status === 409) await loadSettings().catch(() => undefined); }
    } finally { if (balanceInFlight.current === sequence) { balanceInFlight.current = null; if (mounted.current) setBalanceLoading(false); } }
  }, [applySettings, loadSettings]);
  useEffect(() => {
    if (!available) { setLoading(false); return; }
    let cancelled = false; setLoading(true); setPageError("");
    void Promise.allSettled([loadSettings(), loadJobs(), loadRunner()]).then(outcomes => {
      if (cancelled || !mounted.current) return;
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure?.status === "rejected") setPageError(failure.reason instanceof Error ? failure.reason.message : "The verifier could not load.");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [available, loadJobs, loadRunner, loadSettings]);
  useEffect(() => { if (available && !loading) void loadJobs().catch(error => setPageError(error.message)); }, [jobPage, available]);
  useEffect(() => { if (available && job?.id) void loadResults(); }, [job?.id, filter, resultPage, available, loadResults]);
  useEffect(() => {
    if (!available) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadRunner(); }, 30000);
    return () => window.clearInterval(timer);
  }, [available, loadRunner]);
  useEffect(() => {
    if (!available || !settings.configured) return;
    const refresh = () => { if (document.visibilityState === "visible" && !busyRef.current) void refreshBalance(); };
    refresh(); const timer = window.setInterval(refresh, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [available, settings.configured, settings.credentialRevision, refreshBalance]);
  useEffect(() => {
    if (!available || !job?.id) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void loadJob().catch(error => setDetailError(error.message));
      void loadResults();
    };
    const timer = window.setInterval(poll, 7000);
    document.addEventListener("visibilitychange", poll);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [available, job?.id, loadJob, loadResults]);
  const runnerHealthy = runner.enabled && runner.healthy && !!runner.lastHeartbeatAt;
  useEffect(() => {
    // An open page can advance due work promptly. The same server lease also
    // protects against a simultaneous background-runner request.
    if (!available || !job?.id || !["running", "waiting_credits"].includes(job.status) || browserHalted) return;
    let stopped = false;
    const advance = async () => {
      const current = jobRef.current;
      if (stopped || !mounted.current || document.visibilityState !== "visible" || advanceInFlight.current || !current || !["running", "waiting_credits"].includes(current.status) || (current.nextRunAt && current.nextRunAt > Date.now())) return;
      advanceInFlight.current = true; setAdvancing(true);
      try {
        const response = await emailApi<{ job: EmailJob }>(`/jobs/${encodeURIComponent(current.id)}/advance`, {});
        if (mounted.current && jobRef.current?.id === current.id) { jobSequence.current++; commitJob(response.job); await loadResults(); }
      } catch (error) {
        if (mounted.current && jobRef.current?.id === current.id) { setBrowserHalted(true); setBrowserError((error as Error).message); await loadJob().catch(() => undefined); }
      } finally { advanceInFlight.current = false; if (mounted.current) setAdvancing(false); }
    };
    void advance(); const timer = window.setInterval(() => void advance(), 2500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [available, job?.id, job?.status, browserHalted, commitJob, loadJob, loadResults]);

  const source = sourceMode === "file" ? file : pastedText;
  const importOptions = useMemo<EmailImportOptions>(() => ({ format, delimiter, hasHeader: format === "csv" && hasHeader, emailColumn: format === "csv" ? emailColumn : 0, chunkSize: 500 }), [format, delimiter, hasHeader, emailColumn]);
  useEffect(() => {
    if (!showImport || !source || (typeof source === "string" && !source.trim())) { setPreview(null); setPreviewError(""); setPreviewLoading(false); return; }
    const abort = new AbortController(); setPreviewLoading(true); setPreviewError("");
    const timer = window.setTimeout(() => {
      const detection = importDetection.current;
      // Let a new source declare its separator/header before constructing the
      // upload options. A default checked header must never discard an address.
      const options: Partial<EmailImportOptions> = { format, signal: abort.signal,
        ...(detection.complete || detection.delimiterManual ? { delimiter } : {}),
        ...(detection.complete || detection.headerManual ? { hasHeader } : {}),
      };
      void previewEmailImport(source, options).then(next => {
        if (abort.signal.aborted) return;
        setPreview(next);
        if (!detection.delimiterManual) setDelimiter(next.delimiter);
        if (!detection.headerManual) setHasHeader(next.hasHeader);
        if (!detection.columnManual) setEmailColumn(next.suggestedEmailColumn);
        else setEmailColumn(previous => previous < Math.max(next.columns.length, 1) ? previous : 0);
        detection.complete = true;
      }).catch(error => { if (!isAbort(error) && !abort.signal.aborted) { setPreview(null); setPreviewError(error.message); } }).finally(() => { if (!abort.signal.aborted) setPreviewLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [source, format, delimiter, hasHeader, showImport]);
  const selectJob = async (next: EmailJob) => {
    jobSequence.current++; resultsSequence.current++;
    jobRef.current = next; setJob(next); setBatches([]); setFilter("all"); setResultCursors([null]); setResultPage(0); setResults(blankResults); setDetailError(""); setBrowserError(""); setBrowserHalted(false); setCancelReview(false); setDetailLoading(true);
    try { await loadJob(next.id); } catch (error) { setDetailError((error as Error).message); } finally { setDetailLoading(false); }
  };
  const chooseFile = (next?: File) => {
    if (!next) return;
    resetImportDetection(); setFile(next); setSourceMode("file"); setFormat(/\.txt$/i.test(next.name) ? "text" : "csv"); setEmailColumn(0);
    if (!uploadTarget && !listName.trim()) setListName(next.name.replace(/\.[^.]+$/, "").slice(0, 120));
  };
  const openImport = (resume?: EmailJob) => {
    setShowImport(true); setUploadTarget(resume || null); setUploadNotice(""); setUploadPaused(false);
    if (resume) { setListName(resume.name); setUploadProgress({ rows: 0, chunks: 0, savedRows: resume.totalRows, bytes: 0 }); }
    else { setListName(file?.name.replace(/\.[^.]+$/, "").slice(0, 120) || ""); setUploadProgress({ rows: 0, chunks: 0, savedRows: 0, bytes: 0 }); }
    requestAnimationFrame(() => document.getElementById("email-import-panel")?.scrollIntoView({ block: "start" }));
  };
  const uploadList = async () => {
    if (!source || !preview || previewError || !listName.trim()) return;
    setUploading(true); setUploadPaused(false); setUploadNotice(""); uploadStop.current = false;
    let target = uploadTarget, rows = 0, chunks = 0;
    try {
      if (!target) {
        const response = await emailApi<{ job: EmailJob }>("/jobs", { name: listName.trim(), sourceName: sourceMode === "file" ? (file?.name || "Uploaded file").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : "Pasted addresses" });
        target = response.job; setUploadTarget(target); jobRef.current = target; setJob(target); setJobs(previous => [target!, ...previous.filter(item => item.id !== target!.id)].slice(0, 20)); setFilter("all"); setResultCursors([null]); setResultPage(0); setResults(blankResults);
      } else { jobRef.current = target; setJob(target); }
      if (!target) throw new Error("The upload checkpoint could not be created. Reload your lists and try again.");
      const targetId = target.id;
      for await (const chunk of parseEmailChunks(source, importOptions)) {
        if (uploadStop.current || !mounted.current) break;
        const response: { job: EmailJob; duplicate: boolean } = await emailApi(`/jobs/${encodeURIComponent(targetId)}/chunks`, { index: chunk.index, rows: chunk.rows });
        rows += chunk.rows.length; chunks = chunk.index + 1; target = response.job;
        if (!mounted.current) break;
        setUploadTarget(response.job); jobSequence.current++; commitJob(response.job); setUploadProgress({ rows, chunks, savedRows: response.job.totalRows, bytes: chunk.processedBytes });
      }
      if (uploadStop.current || !mounted.current) {
        if (mounted.current) { setUploadPaused(true); setUploadNotice("Upload paused after the last saved chunk. Resume with the same source and column settings; saved chunks will be checked and reused."); }
        return;
      }
      const response = await emailApi<{ job: EmailJob }>(`/jobs/${encodeURIComponent(targetId)}/seal`, { expectedChunks: chunks, expectedRows: rows });
      jobSequence.current++; commitJob(response.job); setUploadTarget(null); setShowImport(false); setFile(null); setPastedText(""); resetImportDetection(); setUploadNotice(""); await loadJobs(); await loadResults();
      notifyRef.current(`${number(response.job.totalRows)} rows imported. Review the list before starting provider verification.`);
    } catch (error) {
      if (mounted.current) { setUploadPaused(true); setUploadNotice(`${(error as Error).message} Previously saved chunks remain in this list. Resume with the exact same source; use a new list if the source changed.`); if (target) await loadJob(target.id).catch(() => undefined); }
    } finally { if (mounted.current) setUploading(false); }
  };
  const accountFailure = async (error: unknown, prefix = "", refreshSettings = false, testedGeneration = settingsRef.current.credentialRevision) => {
    const message = `${prefix}${(error as Error).message}`;
    if (testedGeneration === settingsRef.current.credentialRevision) setBalanceError(message);
    notifyRef.current(message, true);
    if (refreshSettings || (error as ApiError).status === 409) {
      await loadSettings().catch(() => undefined);
      // Keep the explicit check's error for the tested account, while allowing
      // a newer connection's metadata to replace an older request safely.
      if (mounted.current && testedGeneration === settingsRef.current.credentialRevision) setBalanceError(message);
    }
    if ((error as ApiError).status === 409) { setApiKey(""); setShowKey(false); }
  };
  const saveConnection = async (test: boolean) => {
    setBusy("email-settings"); setBalanceError(""); let saved = false; let testedGeneration = settingsRef.current.credentialRevision;
    try {
      if (!settings.configurationAvailable) throw new Error("Secure credential storage is unavailable. Try again after the workspace connection is restored.");
      if (!apiKey.trim() && !settings.configured) throw new Error("Enter your Reoon API key.");
      const response = await emailApi<{ settings: EmailSettings }>("/settings", { revision: settings.revision, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      saved = true; setApiKey(""); setShowKey(false); applySettings(response.settings);
      if (test) { testedGeneration = response.settings.credentialRevision; const checked = await emailApi<{ settings: EmailSettings; balance: EmailBalance }>("/settings/check", {}); applySettings(checked.settings); }
      notifyRef.current(test ? "Reoon connection verified. No email addresses were submitted." : "Reoon settings saved securely. Test the connection before starting verification.");
    } catch (error) { await accountFailure(error, saved && test ? "Settings saved, but the connection test failed: " : "", saved && test, testedGeneration); }
    finally { setBusy(""); }
  };
  const testConnection = async () => {
    const testedGeneration = settingsRef.current.credentialRevision;
    setBusy("email-check");
    try { const response = await emailApi<{ settings: EmailSettings; balance: EmailBalance }>("/settings/check", {}); applySettings(response.settings); setBalanceError(""); notifyRef.current("Reoon connection verified using your credit balance. No addresses were submitted."); }
    catch (error) { await accountFailure(error, "", true, testedGeneration); } finally { setBusy(""); }
  };
  const disconnect = async () => {
    setBusy("email-remove");
    try { const response = await emailApi<{ settings: EmailSettings }>("/settings", { revision: settings.revision }, "DELETE"); applySettings(response.settings); setApiKey(""); setShowKey(false); setRemoveConnection(false); setBalanceError(""); notifyRef.current("Reoon credentials removed. Imported lists and saved results are retained."); }
    catch (error) { await accountFailure(error); } finally { setBusy(""); }
  };
  const startJob = async () => {
    if (!job || !startAcknowledged) return;
    setBusy("email-start");
    try { const response = await emailApi<{ job: EmailJob }>(`/jobs/${encodeURIComponent(job.id)}/start`, { acknowledgeProvider: true }); jobSequence.current++; commitJob(response.job); setReviewStart(false); setStartAcknowledged(false); setBrowserHalted(false); setBrowserError(""); await loadJobs(); notifyRef.current("Verification started. Results will appear as each provider task completes."); }
    catch (error) { setDetailError((error as Error).message); notifyRef.current((error as Error).message, true); await loadJob().catch(() => undefined); }
    finally { setBusy(""); }
  };
  const jobAction = async (action: "pause" | "resume" | "cancel") => {
    if (!job) return; setBusy(`email-${action}`);
    try { const response = await emailApi<{ job: EmailJob }>(`/jobs/${encodeURIComponent(job.id)}/action`, { action }); jobSequence.current++; commitJob(response.job); setCancelReview(false); setBrowserHalted(false); setBrowserError(""); await loadJobs(); await loadJob(); notifyRef.current(action === "pause" ? "New verification submissions paused. Already submitted provider tasks may still finish." : action === "resume" ? "Verification resumed for this list." : "Pending verification work cancelled. Existing provider tasks and saved results are retained."); }
    catch (error) { setDetailError((error as Error).message); notifyRef.current((error as Error).message, true); }
    finally { setBusy(""); }
  };
  const refreshJob = async () => {
    setBusy("email-refresh");
    try { await loadJob(); await loadResults(); await loadRunner(); setBrowserHalted(false); setBrowserError(""); }
    catch (error) { setDetailError((error as Error).message); } finally { setBusy(""); }
  };
  const reconcile = async (batch: EmailBatch) => {
    if (!job || !taskIds[batch.id]?.trim()) return; setBusy(`email-reconcile:${batch.id}`);
    try { const response = await emailApi<{ job: EmailJob }>(`/jobs/${encodeURIComponent(job.id)}/reconcile`, { batchId: batch.id, taskId: taskIds[batch.id].trim() }); jobSequence.current++; commitJob(response.job); await loadJob(); setTaskIds(previous => ({ ...previous, [batch.id]: "" })); setBrowserHalted(false); setBrowserError(""); notifyRef.current("Existing Reoon task linked. No addresses were submitted again."); }
    catch (error) { setDetailError((error as Error).message); notifyRef.current((error as Error).message, true); } finally { setBusy(""); }
  };
  const exportResults = async () => {
    if (!job) return;
    const selected = job, selectedFilter = exportFilter, checkpointKey = `${job.id}:${exportFilter}`;
    const prior = exportCheckpoints[checkpointKey]?.version === job.updatedAt ? exportCheckpoints[checkpointKey] : undefined;
    const abort = new AbortController(); exportAbort.current = abort; setExporting(true); setExportCount(prior?.count || 0);
    try {
      const result = await exportEmailResults({ fileName: `trezad-email-${selected.name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}-${selectedFilter}${prior ? `-part-${prior.parts + 1}` : ""}.csv`, ...(prior ? { cursor: prior.cursor } : {}), signal: abort.signal, onProgress: count => mounted.current && setExportCount((prior?.count || 0) + count), fetchPage: async cursor => {
        const page = await emailApi<ApiResults>(`/jobs/${encodeURIComponent(selected.id)}/results?filter=${selectedFilter}&limit=1000${cursor === undefined ? "" : `&cursor=${cursor}`}`, undefined, undefined, abort.signal);
        return { nextCursor: resultCursor(page.nextCursor), rows: page.rows.map(row => ({ email: row.normalizedEmail || row.email, originalEmail: row.email, sourceRow: row.sourceRow, status: row.category || row.status, reason: row.reason, checkedAt: row.checkedAt ?? null })) };
      } });
      const count = (prior?.count || 0) + result.count, parts = (prior?.parts || 0) + result.parts;
      setExportCheckpoints(previous => { const next = { ...previous }; if (result.nextCursor !== null) next[checkpointKey] = { cursor: result.nextCursor, count, parts, version: selected.updatedAt }; else delete next[checkpointKey]; return next; });
      notifyRef.current(result.nextCursor !== null ? `${number(result.count)} rows downloaded in this CSV part. Choose Download next CSV part to continue.` : `${number(count)} rows exported${parts > 1 ? ` in ${number(parts)} CSV parts` : ""}.`);
    } catch (error) { if (!isAbort(error)) notifyRef.current((error as Error).message, true); }
    finally { exportAbort.current = null; if (mounted.current) setExporting(false); }
  };
  const exportCheckpoint = job && exportCheckpoints[`${job.id}:${exportFilter}`]?.version === job.updatedAt ? exportCheckpoints[`${job.id}:${exportFilter}`] : null;
  const validBalance = settings.balance?.credentialRevision === settings.credentialRevision ? settings.balance : null;
  const balanceStale = !!validBalance && (!!balanceError || Date.now() - validBalance.checkedAt > 5 * 60 * 1000);
  const importReady = available && !!source && !!preview && !previewLoading && !previewError && !!listName.trim();
  const listReady = !!job && job.status === "ready" && job.sealed;
  const canStart = available && listReady && settings.configured && !!settings.verifiedAt && !apiKey.trim();
  const uploadPercent = preview?.byteLength ? Math.min(99, Math.max(0, Math.round(uploadProgress.bytes / preview.byteLength * 100))) : 0;
  const pendingCount = job ? job.counts.pending + job.counts.processing : 0;
  const unknownBatches = batches.filter(batch => batch.status === "unknown");

  return <div className="email-verifier">
    <div className="page-heading"><div><h1>Email verifier</h1><p>Check your email lists, review uncertain addresses and export the results.</p></div><div className="heading-actions"><Button disabled={!available || uploading || !!busy} onClick={() => setSettingsOpen(previous => !previous)}><LockKeyhole size={16} />Reoon settings</Button><Button className="primary" disabled={!available || uploading} onClick={() => openImport()}><Plus size={17} />Import email list</Button></div></div>
    {pageError && <div className="notice notice-error" role="alert"><AlertCircle size={17} /><span>{pageError}</span><button type="button" className="text-link" onClick={() => { setPageError(""); void Promise.allSettled([loadSettings(), loadJobs(), loadRunner()]).then(outcomes => { const failure = outcomes.find(outcome => outcome.status === "rejected"); if (failure?.status === "rejected") setPageError(failure.reason.message); }); }}>Retry<RefreshCw size={14} /></button></div>}
    {!available && <div className="notice notice-soft"><LockKeyhole size={18} /><span>Sign in or reconnect your workspace to manage email lists and provider settings.</span></div>}
    {loading && <div className="loading-strip" role="status"><LoaderCircle size={17} className="spin" />Loading email verification workspace…</div>}

    <section className="panel email-account-bar" aria-label="Email verification provider">
      <div className="email-provider-identity"><span className="email-provider-mark"><Mail size={23} /></span><div><h2>Reoon Email Verifier</h2><p>{settings.verifiedAt ? `Connection verified ${date(settings.verifiedAt)} WAT` : settings.configured ? "Credentials saved. Test your connection to continue." : "Connect your account to verify addresses after import."}</p></div><Badge value={settings.verifiedAt ? "valid" : settings.configured ? "ready" : "pending"}>{settings.verifiedAt ? "Connected" : settings.configured ? "Test needed" : "Not connected"}</Badge></div>
      <div className="email-credit-summary"><span><Wallet size={15} />Available credits{balanceStale && <Badge value="risky">Last known</Badge>}</span><strong>{validBalance ? number(validBalance.availableCredits) : "—"}</strong><small>{validBalance ? `${number(validBalance.dailyCredits)} daily · ${number(validBalance.instantCredits)} instant · Checked ${date(validBalance.checkedAt)} WAT` : "Balance appears after a successful check."}</small></div>
      <Button className="secondary small" busy={balanceLoading} disabled={!available || !settings.configured || !!busy} onClick={() => void refreshBalance()}><RefreshCw size={14} />Refresh balance</Button>
      {balanceError && <div className="account-inline-error email-account-error" role="status"><AlertCircle size={15} /><span>{balanceError}{validBalance ? " The displayed balance is the last successful result." : ""}</span></div>}
    </section>

    {settingsOpen && <section className="panel email-connection-settings" aria-label="Reoon API settings"><div className="section-title"><span className="section-icon"><LockKeyhole size={19} /></span><div><h2>Reoon API connection</h2><p>Keep your provider account separate from SMS and WhatsApp settings.</p></div><button type="button" className="icon-button" aria-label="Close Reoon settings" disabled={!!busy} onClick={() => { setSettingsOpen(false); setApiKey(""); setShowKey(false); }}><X size={19} /></button></div>
      {!settings.configurationAvailable && available && <div className="notice notice-warning"><AlertCircle size={17} /><span>Secure credential storage is currently unavailable. API settings are disabled until it is restored.</span></div>}
      <div className="field"><label htmlFor="email-reoon-api-key">API key</label><div className="api-key-input"><input id="email-reoon-api-key" name="new-email-verifier-api-key" type={showKey ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={apiKey} placeholder={settings.configured ? "Saved securely; leave blank to keep" : "Paste your Reoon API key"} disabled={!available || !settings.configurationAvailable || !!busy} onChange={event => setApiKey(event.target.value)} /><button type="button" className="icon-button" aria-label={showKey ? "Hide entered API key" : "Show entered API key"} aria-pressed={showKey} disabled={!apiKey || !!busy} onClick={() => setShowKey(previous => !previous)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><small>Encrypted on the server. Saved keys are never displayed. Replacing a key requires a new connection test.</small></div>
      <div className="email-settings-actions"><Button disabled={!available || !settings.configurationAvailable || !!busy} onClick={() => void saveConnection(false)}>Save settings</Button><Button className="primary" busy={busy === "email-settings"} disabled={!available || !settings.configurationAvailable || !!busy} onClick={() => void saveConnection(true)}><ShieldCheck size={16} />Save & test connection</Button><button type="button" className="text-link" disabled={!settings.configured || !!apiKey.trim() || !!busy} onClick={() => void testConnection()}>{busy === "email-check" ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Test saved connection</button></div>
      <div className="email-settings-foot"><p><LockKeyhole size={14} />Connection tests read credits. They never submit an email list for verification.</p><a className="text-link" href="https://emailverifier.reoon.com/" target="_blank" rel="noreferrer">Open Reoon<ArrowUpRight size={13} /></a>{settings.configured && <button type="button" className="text-link remove-credentials-link" disabled={!!busy} onClick={() => setRemoveConnection(true)}><Trash2 size={13} />Remove credentials</button>}</div>
      {removeConnection && <div className="email-inline-confirm"><p>Remove the saved Reoon connection? Imported lists and results stay in the workspace.</p><div><Button className="secondary small" disabled={!!busy} onClick={() => setRemoveConnection(false)}>Keep connection</Button><Button className="danger small" busy={busy === "email-remove"} disabled={!!busy} onClick={() => void disconnect()}>Remove credentials</Button></div></div>}
    </section>}

    <div className={`email-runner-status ${runnerHealthy ? "is-healthy" : ""}`} role="status"><span className={`status-dot ${runnerHealthy ? "green" : "amber"}`} /><div><strong>{runnerHealthy ? "Background verification is active" : "Keep this page open while verifying"}</strong><span>{runnerHealthy ? `Worker checked in ${date(runner.lastHeartbeatAt)} WAT. You can leave this page while a started list is processed.` : `${runner.message || "Background processing is unavailable."} This tab advances the selected running list while it stays visible.`}</span></div>{advancing && <span className="email-working"><LoaderCircle size={14} className="spin" />Processing</span>}</div>

    {showImport && <section className="panel email-import-panel" id="email-import-panel"><div className="panel-heading"><div><h2>{uploadTarget ? "Resume list upload" : "Import an email list"}</h2><p>Upload a CSV or text file, or paste addresses. Importing does not use verification credits.</p></div><button type="button" className="icon-button" aria-label="Close email import" disabled={uploading} onClick={() => setShowImport(false)}><X size={20} /></button></div>
      <div className="email-import-body">{uploadTarget && <div className="notice notice-soft"><FileText size={17} /><span><strong>{uploadTarget.name}</strong> · {number(uploadTarget.totalRows)} rows saved in {number(uploadTarget.importedChunks)} chunks. Choose the exact same source, header and email column. Saved chunks are checked before the upload continues.</span></div>}
        <div className="email-import-layout"><div><label className="field">List name<input maxLength={120} value={listName} disabled={uploading || !!uploadTarget} onChange={event => setListName(event.target.value)} placeholder="e.g. October community contacts" /></label><div className="segmented email-source-tabs" role="group" aria-label="Email list source"><button type="button" className={sourceMode === "file" ? "selected" : ""} aria-pressed={sourceMode === "file"} disabled={uploading} onClick={() => { if (sourceMode !== "file") { resetImportDetection(); setSourceMode("file"); } }}><Upload size={15} />Upload file</button><button type="button" className={sourceMode === "paste" ? "selected" : ""} aria-pressed={sourceMode === "paste"} disabled={uploading} onClick={() => { if (sourceMode !== "paste") { resetImportDetection(); setSourceMode("paste"); } }}><FileText size={15} />Paste addresses</button></div>
          {sourceMode === "file" ? <><input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" className="sr-only" disabled={uploading} onChange={event => chooseFile(event.target.files?.[0])} /><button type="button" className="upload-zone email-upload-zone" disabled={uploading} onClick={() => fileInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!uploading) chooseFile(event.dataTransfer.files?.[0]); }}><span><Upload size={24} /></span><strong>{file?.name || "Choose a CSV, TSV or text file"}</strong><small>{file ? `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(file.size / 1024)} KB · Click to choose another file` : "Or drop it here. Large files are read and saved in small chunks."}</small></button></> : <label className="field email-paste-field">Email addresses or CSV<textarea rows={7} value={pastedText} disabled={uploading} onPaste={event => { if (event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === event.currentTarget.value.length) resetImportDetection(); }} onChange={event => { if (!event.target.value) resetImportDetection(); else { importDetection.current.complete = false; setPreview(null); } setPastedText(event.target.value); }} placeholder={"name@example.com\nanother@example.org"} /><small>Use Text for one address per line. Choose CSV for data with columns.</small></label>}
          <div className="field-row"><label className="field">Source format<select value={format} disabled={uploading} onChange={event => { importDetection.current.complete = false; setPreview(null); setFormat(event.target.value as "csv" | "text"); }}><option value="csv">CSV with columns</option><option value="text">Text / email addresses</option></select></label>{format === "csv" && <label className="field">Separator<select value={delimiter} disabled={uploading} onChange={event => { importDetection.current.delimiterManual = true; importDetection.current.complete = false; setPreview(null); setDelimiter(event.target.value as "," | ";" | "\t"); }}><option value=",">Comma</option><option value=";">Semicolon</option><option value={"\t"}>Tab</option></select></label>}</div>
          {format === "csv" && <><label className="checkbox-label email-header-checkbox"><input type="checkbox" checked={hasHeader} disabled={uploading} onChange={event => { importDetection.current.headerManual = true; setPreview(null); setHasHeader(event.target.checked); }} /><span>The first row contains column names</span></label><label className="field">Email column<select value={emailColumn} disabled={uploading || !preview?.columns.length} onChange={event => { importDetection.current.columnManual = true; setEmailColumn(Number(event.target.value)); }}>{(preview?.columns.length ? preview.columns : ["Choose a source first"]).map((column, index) => <option value={index} key={`${index}:${column}`}>{column || `Column ${index + 1}`} · column {index + 1}</option>)}</select><small>Only this column is checked. Original row numbers are kept with each result.</small></label></>}
        </div><aside className="email-import-preview"><div className="email-preview-heading"><Eye size={17} /><h3>Preview selected addresses</h3></div>{previewLoading ? <p className="email-preview-empty"><LoaderCircle size={17} className="spin" />Reading the first few rows…</p> : previewError ? <div className="notice notice-error"><AlertCircle size={16} /><span>{previewError}</span></div> : preview ? <><ol>{preview.sampleRows.slice(0, 5).map((row, index) => <li key={index}><span>{index + (format === "csv" && hasHeader ? 2 : 1)}</span><code>{row[format === "csv" ? emailColumn : 0] || "(empty value)"}</code></li>)}</ol><p>Preview only. Every row is validated during import. Duplicate addresses keep their original rows and share one verification result.</p></> : <div className="email-preview-placeholder"><Mail size={27} /><strong>Your email column appears here</strong><p>Choose a source and confirm the column before importing.</p></div>}<div className="email-import-facts"><span><Check size={14} />500 rows per saved chunk</span><span><Check size={14} />Resume from saved upload checkpoints</span><span><Check size={14} />No provider charge on import</span></div></aside></div>
        {(uploading || uploadPaused || uploadProgress.chunks > 0) && <div className="email-upload-progress" role="status"><div><strong>{uploading ? "Saving your list…" : "Upload checkpoint saved"}</strong><span>{number(uploadProgress.rows)} source rows checked · {number(uploadProgress.savedRows)} saved</span></div><progress max={100} value={uploadPercent} aria-label="File upload progress" /><p>{number(uploadProgress.chunks)} chunks checked in this pass. The list is ready only after the complete source has been confirmed.</p></div>}
        {uploadNotice && <div className="notice notice-warning" role="status"><AlertCircle size={16} /><span>{uploadNotice}</span></div>}
        <div className="email-import-footer"><p><LockKeyhole size={15} />Addresses stay in this workspace until you explicitly start Reoon verification.</p>{uploading ? <Button onClick={() => { uploadStop.current = true; setUploadNotice("Pausing after the current chunk is saved…"); }}><Pause size={15} />Pause upload</Button> : <Button className="primary" disabled={!importReady || !!busy} onClick={() => void uploadList()}><Upload size={16} />{uploadTarget ? "Resume upload" : "Import list"}</Button>}</div>
      </div>
    </section>}

    <div className="email-workspace-grid"><aside className="panel email-jobs-panel"><div className="panel-heading"><div><h2>Your lists</h2><p>Uploads and verification jobs.</p></div><button type="button" className="icon-button" aria-label="Refresh email lists" disabled={!available || jobsLoading || uploading} onClick={() => void loadJobs().catch(error => setPageError(error.message))}><RefreshCw size={16} className={jobsLoading ? "spin" : ""} /></button></div>
      {jobs.length ? <ul className="email-job-list">{jobs.map(item => <li key={item.id}><button type="button" className={job?.id === item.id ? "is-selected" : ""} aria-current={job?.id === item.id ? "true" : undefined} disabled={uploading || exporting} onClick={() => { setShowImport(false); void selectJob(item); }}><div><strong>{item.name}</strong><Badge value={item.status}>{readable(item.status)}</Badge></div><span>{number(item.totalRows)} rows · {date(item.updatedAt)}</span><div className="email-job-mini-progress"><span style={{ width: `${Math.max(0, Math.min(item.progressPercent, 100))}%` }} /></div></button></li>)}</ul> : <div className="email-jobs-empty"><Inbox size={25} /><strong>{jobsLoading ? "Loading lists…" : "No email lists yet"}</strong><p>Import a list to check formats and prepare verification.</p></div>}
      <div className="email-jobs-pagination"><button type="button" className="icon-button" aria-label="Previous lists page" disabled={jobPage === 0 || jobsLoading || uploading} onClick={() => setJobPage(previous => previous - 1)}><ArrowLeft size={15} /></button><span>Page {jobPage + 1}</span><button type="button" className="icon-button" aria-label="Next lists page" disabled={nextJobsCursor === null || jobsLoading || uploading} onClick={() => { if (nextJobsCursor === null) return; setJobCursors(previous => [...previous.slice(0, jobPage + 1), nextJobsCursor]); setJobPage(previous => previous + 1); }}><ArrowRight size={15} /></button></div>
    </aside><section className="email-job-workspace" aria-label="Selected email list">
      {!job ? <div className="panel email-welcome"><div className="email-welcome-icon"><ListChecks size={29} /></div><h2>Make your list ready for a campaign</h2><p>Import your addresses, review the local checks, then choose when to use Reoon verification credits.</p><div className="email-welcome-steps"><div><span>1</span><strong>Import</strong><p>Read large CSV or text lists in manageable chunks.</p></div><div><span>2</span><strong>Verify</strong><p>Approve provider sharing and credit use for each list.</p></div><div><span>3</span><strong>Export</strong><p>Download all results or a specific category.</p></div></div><Button className="primary" disabled={!available || uploading} onClick={() => openImport()}><Upload size={16} />Import your first list</Button></div> : <>
        <section className="panel email-job-detail"><div className="panel-heading"><div><div className="email-job-title"><h2>{job.name}</h2><Badge value={job.status} /></div><p>{job.sourceName || "Imported list"} · Created {date(job.createdAt)} WAT</p></div><Button className="secondary small" busy={busy === "email-refresh" || detailLoading} disabled={!!busy || uploading} onClick={() => void refreshJob()}><RefreshCw size={14} />Refresh</Button></div>
          {detailError && <div className="notice notice-error email-detail-notice" role="alert"><AlertCircle size={16} /><span>{detailError}</span></div>}
          <div className="email-job-progress"><div><strong>{number(job.processedRows)} of {number(job.totalRows)} rows resolved</strong><span>{Math.round(job.progressPercent)}%</span></div><progress max={100} value={Math.min(100, Math.max(0, job.progressPercent))} aria-label="Verification progress" /><p>{job.status === "uploading" ? "Upload is incomplete. Provider verification has not started." : job.status === "ready" ? `${number(job.eligibleCount)} unique addresses are eligible for provider verification.` : job.status === "completed" ? "Verification finished. Review risky and unknown results separately." : job.status === "paused" ? "New submissions are paused. Provider tasks already submitted may still complete." : job.status === "waiting_credits" ? "Processing is waiting for provider credits. Refresh your balance after funding the account." : job.status === "needs_attention" ? "A provider outcome needs review before further submissions." : job.status === "cancelled" ? "Pending work was cancelled. Existing results remain available." : `${number(job.counts.processing)} rows are currently being checked.${job.nextRunAt && job.nextRunAt > Date.now() ? ` Next provider check after ${date(job.nextRunAt)} WAT.` : ""}`}</p></div>
          <div className="email-result-categories" role="group" aria-label="Filter results by category">{(["all", "valid", "invalid", "risky", "unknown", "pending"] as Filter[]).map(category => <button type="button" key={category} className={`${filter === category ? "is-selected" : ""} email-category-${category}`} aria-pressed={filter === category} onClick={() => { setFilter(category); setResultCursors([null]); setResultPage(0); setResults(blankResults); setResultsError(""); }}><span>{category === "all" ? "All" : categoryLabel(category)}</span><strong>{number(category === "all" ? job.totalRows : category === "pending" ? pendingCount : job.counts[category])}</strong></button>)}</div>
          <div className="email-list-facts"><span><CopyIcon />{number(job.counts.duplicates)} duplicate rows</span><span><ShieldCheck size={14} />{number(job.invalidSyntaxCount)} local format failures</span><span><Clock3 size={14} />Updated {date(job.updatedAt)} WAT</span></div>
          {job.error && <div className="notice notice-warning email-detail-notice"><AlertCircle size={16} /><span>{job.error}</span></div>}
          {browserError && <div className="notice notice-warning email-detail-notice"><AlertCircle size={16} /><span>{browserError} Browser processing has stopped. Refresh the saved job state before continuing; uncertain submissions are not retried automatically.</span></div>}
          <div className="email-job-actions">{job.status === "uploading" && <Button className="primary" disabled={uploading || !!busy} onClick={() => openImport(job)}><Upload size={15} />Resume upload</Button>}{job.status === "ready" && <><Button className="primary" disabled={!canStart || !!busy || uploading} onClick={() => { setStartAcknowledged(false); setReviewStart(true); }}><Play size={15} />Review & start verification</Button>{!settings.configured || !settings.verifiedAt ? <button type="button" className="text-link" onClick={() => setSettingsOpen(true)}>Connect and test Reoon first<ArrowRight size={13} /></button> : null}</>}{["running", "waiting_credits"].includes(job.status) && <Button disabled={!!busy} busy={busy === "email-pause"} onClick={() => void jobAction("pause")}><Pause size={15} />Pause verification</Button>}{["paused", "waiting_credits"].includes(job.status) && <Button className="primary" disabled={!!busy || !settings.configured || !settings.verifiedAt} busy={busy === "email-resume"} onClick={() => void jobAction("resume")}><Play size={15} />{job.status === "waiting_credits" ? "Check credits & resume" : "Resume verification"}</Button>}{!["completed", "cancelled"].includes(job.status) && <button type="button" className="text-link remove-credentials-link" disabled={!!busy || uploading} onClick={() => setCancelReview(true)}>Cancel remaining work</button>}</div>
          {cancelReview && <div className="email-inline-confirm email-detail-notice"><p>Cancel work that has not been submitted? Provider tasks already running cannot be recalled. Saved results remain available.</p><div><Button className="secondary small" disabled={!!busy} onClick={() => setCancelReview(false)}>Keep job</Button><Button className="danger small" busy={busy === "email-cancel"} disabled={!!busy} onClick={() => void jobAction("cancel")}>Cancel remaining work</Button></div></div>}
        </section>
        {unknownBatches.length > 0 && <section className="panel email-reconcile-panel"><div className="panel-heading"><div><h2>Review unconfirmed provider tasks</h2><p>Check your Reoon account before linking or repeating any submission.</p></div><AlertCircle size={21} /></div>{unknownBatches.map(batch => <div className="email-reconcile-batch" key={batch.id}><div><strong>Batch {batch.index + 1} · {number(batch.count)} addresses</strong><Badge value="unknown">Unconfirmed</Badge></div><p>{batch.error || "The provider did not confirm whether this task was accepted."}</p>{batch.mode === "bulk" ? <><label className="field">Confirmed Reoon task ID<input value={taskIds[batch.id] || ""} maxLength={128} autoComplete="off" disabled={!!busy} onChange={event => setTaskIds(previous => ({ ...previous, [batch.id]: event.target.value }))} placeholder="Task ID from the same Reoon account" /><small>Only enter an existing task that contains this batch. Linking retrieves its results without submitting addresses again.</small></label><Button className="secondary small" busy={busy === `email-reconcile:${batch.id}`} disabled={!!busy || !taskIds[batch.id]?.trim()} onClick={() => void reconcile(batch)}><RefreshCw size={14} />Link existing task</Button></> : <p className="field-hint">This single-address outcome cannot be linked to a bulk task. Review it in Reoon; it is not automatically retried.</p>}</div>)}</section>}
        <section className="panel email-results-panel"><div className="panel-heading"><div><h2>{categoryLabel(filter)}</h2><p>{number(results.total)} rows in this view. Results are shown in pages of 100.</p></div><div className="email-export-controls"><select value={exportFilter} aria-label="Export category" disabled={exporting} onChange={event => setExportFilter(event.target.value as Filter)}>{(["all", "valid", "invalid", "risky", "unknown", "pending"] as Filter[]).map(category => <option value={category} key={category}>{category === "all" ? "Export all categories" : `Export ${category}`}</option>)}</select><Button className="secondary small" busy={exporting} disabled={!job.totalRows || uploading} onClick={() => void exportResults()}><ArrowDownToLine size={14} />{exportCheckpoint ? "Download next CSV part" : "Export CSV"}</Button></div></div>
          {exportCheckpoint && !exporting && <div className="email-export-progress"><Check size={15} /><span>{number(exportCheckpoint.count)} rows downloaded in {number(exportCheckpoint.parts)} part{exportCheckpoint.parts === 1 ? "" : "s"}. More rows are available in the next CSV part.</span></div>}
          {exporting && <div className="email-export-progress" role="status"><LoaderCircle size={15} className="spin" /><span>{number(exportCount)} rows exported. Keep this page open until the download finishes.</span><button type="button" className="text-link" onClick={() => exportAbort.current?.abort()}>Stop export</button></div>}
          {resultsError && <div className="notice notice-error email-detail-notice"><AlertCircle size={15} /><span>{resultsError}</span></div>}
          {resultsLoading && !results.rows.length ? <div className="email-results-empty"><LoaderCircle size={21} className="spin" /><p>Loading this page of results…</p></div> : results.rows.length ? <div className="table-scroll email-results-table" aria-busy={resultsLoading}><table><thead><tr><th>Email address</th><th>Result</th><th>Details</th><th>Source row</th></tr></thead><tbody>{results.rows.map(row => <tr key={row.position}><td><strong>{row.normalizedEmail || row.email || "Empty value"}</strong>{row.normalizedEmail && row.normalizedEmail !== row.email && <small className="cell-sub">Original: {row.email}</small>}{row.duplicateOf !== null && <small className="email-duplicate-note">Duplicate · shared result</small>}</td><td><Badge value={row.category || row.status}>{categoryLabel(row.category || row.status)}</Badge></td><td><span>{row.reason || (row.status === "pending" ? "Not yet verified" : row.status === "processing" ? "Provider verification in progress" : "No additional detail")}</span>{row.providerStatus && <small className="cell-sub">Provider: {readable(row.providerStatus)}</small>}</td><td>{row.sourceRow ?? row.position}</td></tr>)}</tbody></table></div> : <div className="email-results-empty"><Search size={23} /><strong>No {filter === "all" ? "saved rows" : `${filter} results`} in this view</strong><p>{job.status === "uploading" ? "Complete the upload to prepare this list." : "Choose another category or refresh as verification progresses."}</p></div>}
          <div className="email-results-pagination"><span>Page {resultPage + 1} · {number(results.rows.length)} rows shown{resultsLoading ? " · Refreshing…" : ""}</span><div><Button className="secondary small" disabled={!resultPage || resultsLoading} onClick={() => { setResultPage(previous => previous - 1); setResults(blankResults); }}><ArrowLeft size={14} />Previous</Button><Button className="secondary small" disabled={results.nextCursor === null || resultsLoading} onClick={() => { if (results.nextCursor === null) return; setResultCursors(previous => [...previous.slice(0, resultPage + 1), results.nextCursor]); setResultPage(previous => previous + 1); setResults(blankResults); }}>Next<ArrowRight size={14} /></Button></div></div>
          <p className="email-results-footnote">Valid reflects the provider’s result at check time and does not establish permission to send email. Risky, unknown and pending addresses are kept separate. Exports reflect the currently saved results. For a final export, wait for verification to finish. When direct file streaming is unavailable, use Download next CSV part until all rows are downloaded.</p>
        </section>
      </>}
    </section></div>
    {reviewStart && job && <Dialog title="Start email verification?" onClose={() => setReviewStart(false)} locked={busy === "email-start"}><div className="modal-body"><div className="email-confirm-provider"><span className="email-provider-mark"><ShieldCheck size={24} /></span><div><strong>{job.name}</strong><p>Reoon Email Verifier</p></div></div><div className="confirm-summary"><div><span>Imported rows</span><strong>{number(job.totalRows)}</strong></div><div><span>Unique eligible addresses</span><strong>{number(job.eligibleCount)}</strong></div><div><span>Duplicate rows</span><strong>{number(job.counts.duplicates)}</strong></div><div><span>Maximum verification usage</span><strong>Up to {number(job.eligibleCount)} credits</strong></div><div><span>Last known available credits</span><strong>{validBalance ? number(validBalance.availableCredits) : "Check provider balance"}</strong></div></div><p className="email-confirm-explanation">Eligible email addresses will be sent to Reoon for verification. Duplicate rows are verified once and share the result. Import checks do not use provider credits. Your Reoon plan controls available credits and provider billing.</p>{validBalance && validBalance.availableCredits < job.eligibleCount && <div className="notice notice-warning"><Wallet size={16} /><span>The last known balance is below the list’s maximum usage. Processing may wait for more credits before the list is complete.</span></div>}<label className="checkbox-label checkbox-card"><input type="checkbox" checked={startAcknowledged} disabled={!!busy} onChange={event => setStartAcknowledged(event.target.checked)} /><span><strong>I authorise Reoon verification for this list</strong><small>I am permitted to share these addresses with Reoon and approve use of up to {number(job.eligibleCount)} verification credits. This checks addresses; it does not send campaign emails.</small></span></label><div className="inline-note"><CircleHelp size={15} /><span>{runnerHealthy ? "The background worker can continue after you leave this page." : "Keep this page open and visible while verification runs. You can pause new submissions at any time."}</span></div></div><div className="modal-footer"><Button disabled={!!busy} onClick={() => setReviewStart(false)}>Back</Button><Button className="primary" busy={busy === "email-start"} disabled={!startAcknowledged || !canStart || !!busy} onClick={() => void startJob()}><Play size={15} />Start verification</Button></div></Dialog>}
  </div>;
}

function CopyIcon() { return <CheckCheck size={14} />; }
