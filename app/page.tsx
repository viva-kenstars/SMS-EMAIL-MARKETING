"use client";

import { normalizePhone, segmentInfo, validateSenderId } from "./lib/sms";
import { parseDirectNumbers, MAX_DIRECT_RECIPIENTS } from "./lib/direct-numbers";
import { whatsappTemplateKeys, renderWhatsAppTemplate } from "./lib/whatsapp";
import { getSmsProviderDefinition, validSmsSender, type SmsProviderId, type SmsProviderState } from "./lib/sms-provider-catalog";
import EmailVerifier from "./components/email-verifier";
import EmailMarketing from "./components/email-marketing";
import { SmsProviderBalances, SmsProviderDirectory, useSmsProviderBalances, type SmsProviderDirectoryState } from "./components/sms-providers";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleCheck, CircleHelp, Clock3, Copy, FileText, Filter, Inbox, LayoutDashboard, LoaderCircle, LockKeyhole, Menu, MessageCircle, MessageSquare, MoreHorizontal, Plus, Radio, RefreshCw, Search, Send, Settings2, ShieldCheck, Smartphone, Sparkles, Upload, Users, X, Ban, Trash2, ExternalLink, AlertCircle, Eye, EyeOff, Wallet, Zap, Pause, Mail } from "lucide-react";

type View = "overview" | "compose" | "contacts" | "campaigns" | "templates" | "email" | "marketing" | "settings";
type Contact = { id: string; name: string; phone: string; group: string; consent: boolean; suppressed: boolean; createdAt: string | number };
type Summary = { pending: number; sending: number; accepted: number; delivered: number; failed: number; unknown: number; skipped: number; validated: number };
type WhatsAppSettings = { deviceId: string; businessName: string; templateId: string; templateBody: string; category: "marketing" | "utility"; accountApproved: boolean; templateApproved: boolean; liveEnabled: boolean; ratePerMessage: number | null; revision: number; configured: boolean; readiness: string[]; providerRevision: number; templateKeys: string[] };
type WhatsAppSnapshot = { deviceId: string; templateId: string; templateBody: string; businessName: string; category: "marketing" | "utility"; data: Record<string, string> };
type Campaign = { smsProviderId: SmsProviderId; smsProviderName: string; smsCredentialRevision: number; whatsapp: WhatsAppSnapshot | null; audienceSource: "contacts" | "direct"; id: string; name: string; message: string; senderId: string; channel: "generic" | "dnd" | "whatsapp"; mode: "draft" | "preview" | "live"; status: string; recipientCount: number; segments: number; encoding: string; createdAt: string | number; updatedAt: string | number; estimatedCost: number | null; summary: Summary };
type Settings = { senderId: string; ratePerSegment: number | null; senderApproved: boolean; transactionalEnabled: boolean; senderApprovalSource?: "termii" | "manual" | null; senderVerifiedAt?: number | null };
type Provider = { name: string; configured: boolean; apiKeyConfigured: boolean; baseUrlConfigured: boolean; liveEnabled: boolean; readiness: string[]; baseUrl: string; configurationAvailable: boolean; verifiedAt: number | null; revision: number; credentialRevision: number; source: "app" | "environment" | "none"; updatedAt: number | null };
type ProviderBalance = { balance: number; currency: string; fetchedAt: number; credentialRevision: number };
type SenderIdRecord = { senderId: string; country: string; status: "active" | "pending" | "blocked" | "unknown"; createdAt: string | null };
type SenderIdRequest = { senderId: string; status: "submitting" | "pending" | "unknown" | "rejected"; requestedAt: number; reason: string | null };
type SenderIdsResult = { senderIds: SenderIdRecord[]; complete: boolean; total: number | null; fetchedAt: number; credentialRevision: number; requests: SenderIdRequest[]; senderApprovalRevoked?: boolean };
type SenderIdsSnapshot = SenderIdsResult & { connectionKey: string };
type ProviderCheck = ProviderBalance & { connected: boolean; provider: Provider };
type ApiError = Error & { status?: number; code?: string; outcome?: "unknown" | "rejected" };
type AppState = { smsProviders: SmsProviderState[]; activeSmsProviderId: SmsProviderId | null; smsRoutingRevision: number; contacts: Contact[]; campaigns: Campaign[]; settings: Settings; provider: Provider; whatsapp: WhatsAppSettings; preview: boolean };
type Recipient = { id: string; name: string; phone: string; status: string; providerId?: string; reason?: string; updatedAt: string | number };
type CampaignDetail = { campaign: Campaign; recipients: Recipient[]; batches: { id: string; status: string; providerId?: string; error?: string; createdAt: string | number }[] };
type ImportContact = { name: string; phone: string; group: string; consent: boolean };
const blankWhatsApp: WhatsAppSettings = { deviceId: "", businessName: "", templateId: "", templateBody: "", category: "marketing", accountApproved: false, templateApproved: false, liveEnabled: false, ratePerMessage: null, revision: 0, configured: false, readiness: [], providerRevision: 0, templateKeys: [] };
const blankState: AppState = { smsProviders: [], activeSmsProviderId: null, smsRoutingRevision: 0, contacts: [], campaigns: [], settings: { senderId: "Trezad", ratePerSegment: null, senderApproved: false, transactionalEnabled: false }, provider: { name: "Termii", configured: false, apiKeyConfigured: false, baseUrlConfigured: false, liveEnabled: false, baseUrl: "", configurationAvailable: false, verifiedAt: null, revision: 0, credentialRevision: 0, source: "none", updatedAt: null, readiness: ["Connect your Termii account", "Confirm your approved sender ID", "Enable live sending"] }, whatsapp: blankWhatsApp, preview: false };
const navItems: { id: View; label: string; icon: typeof Send }[] = [{ id: "overview", label: "Overview", icon: LayoutDashboard }, { id: "compose", label: "Send messages", icon: Send }, { id: "contacts", label: "SMS contacts", icon: Users }, { id: "campaigns", label: "SMS & WhatsApp campaigns", icon: MessageSquare }, { id: "templates", label: "SMS templates", icon: FileText }, { id: "marketing", label: "Email marketing", icon: Mail }, { id: "email", label: "Email verifier", icon: ShieldCheck }];
const ACCOUNT_REFRESH_MS = 5 * 60 * 1000;
const providerConnectionKey = (provider: Provider) => provider.configured ? `${provider.credentialRevision}:${provider.baseUrl}` : "";
const senderKey = (value: string) => value.trim().toLowerCase();
const usableSenderId = (sender: SenderIdRecord) => sender.status === "active" && sender.country.trim().toLowerCase() === "nigeria";
const templates = [
  { name: "Promotional offer", type: "Promotion", channel: "generic" as const, icon: Sparkles, color: "sand", body: "A little thank-you from {business}: enjoy {offer} until {date}. Shop at {website}. To opt out, contact {opt_out_contact}.", description: "Share an offer with customers who want to hear from you." },
  { name: "Event invitation", type: "Invitation", channel: "generic" as const, icon: Users, color: "mint", body: "You're invited! Join {business} for {event} on {date} at {venue}. Details: {website}. To opt out, contact {opt_out_contact}.", description: "Share the date, location and details of your event." },
  { name: "Service update", type: "Transactional", channel: "dnd" as const, icon: Radio, color: "lavender", body: "{business} service update: {service} will be unavailable on {date} from {start_time} to {end_time}. Need help? Contact {support_contact}.", description: "Keep existing customers informed about their service." },
  { name: "Appointment reminder", type: "Transactional", channel: "dnd" as const, icon: Clock3, color: "peach", body: "Reminder from {business}: your appointment is on {date} at {time}, {location}. To reschedule, contact {support_contact}.", description: "Give customers a timely reminder of their appointment." },
  { name: "Welcome message", type: "Welcome", channel: "generic" as const, icon: MessageCircle, color: "mint", body: "Welcome to {business}! Thanks for subscribing to our updates. Find out more at {website}. To opt out at any time, contact {opt_out_contact}.", description: "Welcome new subscribers and share useful information." },
  { name: "Account notice", type: "Transactional", channel: "dnd" as const, icon: ShieldCheck, color: "sand", body: "{business}: {account_notice}. If you have any questions, contact {support_contact}. We will never ask for your password or PIN by SMS.", description: "Deliver a clear, relevant update to account holders." },
];
function number(n: number = 0) { return new Intl.NumberFormat("en-NG").format(n); }
function money(n: number | null | undefined) { return n == null ? "Rate not set" : new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 }).format(n); }
function date(value: string | number) { const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function label(value: string) { return value.replace(/[_-]/g, " ").replace(/^\w/, (s) => s.toUpperCase()); }
function csvCell(value: unknown) { let s = String(value ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }
function downloadCsv(filename: string, rows: unknown[][]) { const blob = new Blob(["\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function parseCsv(text: string) { const rows: string[][] = []; let row: string[] = [], cell = "", quote = false; const input = text.replace(/^\uFEFF/, ""); for (let i = 0; i < input.length; i++) { const ch = input[i]; if (ch === '"') { if (quote && input[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; } else if (ch === "," && !quote) { row.push(cell.trim()); cell = ""; } else if ((ch === "\n" || ch === "\r") && !quote) { if (ch === "\r" && input[i + 1] === "\n") i++; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; } else cell += ch; } if (quote) throw new Error("There is an unclosed quote in the CSV file. Please check the file and try again."); row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); return rows; }
function parseImport(text: string, consent: boolean, group: string): ImportContact[] { const rows = parseCsv(text); if (!rows.length) return []; const headers = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, "_")); const p = headers.findIndex((h) => ["phone", "phone_number", "mobile", "number"].includes(h)); if (p === -1) return rows.map((r) => ({ phone: r[0].replace(/^'(?=\+?\d)/, ""), name: r[1] || "", group: r[2] || group, consent })); const ni = headers.indexOf("name"), gi = headers.indexOf("group"), ci = headers.indexOf("consent"); return rows.slice(1).map((r) => ({ phone: (r[p] || "").replace(/^'(?=\+?\d)/, ""), name: ni >= 0 ? r[ni] || "" : "", group: gi >= 0 ? r[gi] || group : group, consent: ci >= 0 ? consent && ["true", "yes", "1"].includes((r[ci] || "").toLowerCase()) : consent })); }
async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> { const res = await fetch(path, { method: method || (body === undefined ? "GET" : "POST"), headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" }); let data: any; try { data = await res.json(); } catch { throw new Error("The server did not return a valid response. Please try again."); } if (!res.ok) { const error = new Error(typeof data.error === "string" ? data.error : data.message || "The request could not be completed.") as ApiError; error.status = res.status; if (typeof data.code === "string") error.code = data.code; if (data.outcome === "unknown" || data.outcome === "rejected") error.outcome = data.outcome; throw error; } return data as T; }
function Badge({ value, children }: { value?: string; children?: ReactNode }) { return <span className={`badge badge-${value || "neutral"}`}>{children || label(value || "")}</span>; }
function PhoneFormatHelp({ compact = false }: { compact?: boolean }) {
  return <section className={`phone-format-help ${compact ? "phone-format-compact" : ""}`} aria-label="Nigerian phone number formats">
    <div className="phone-format-heading"><span><Smartphone size={17} /></span><div><h3>Which phone format?</h3><p>All four formats below are accepted. Use a complete Nigerian mobile number.</p></div><Badge value="neutral">Nigeria</Badge></div>
    <div className="phone-format-examples"><div><code>+2347061234567</code><span>Recommended</span></div><div><code>2347061234567</code><span>Country code</span></div><div><code>07061234567</code><span>Local format</span></div><div><code>7061234567</code><span>Without the leading 0</span></div></div>
    <div className="phone-format-notes"><p><Check size={13} /><span>We save <code>+2347061234567</code> and convert it to the format required by your selected provider automatically.</span></p><p><AlertCircle size={13} /><span>Do not add a 0 after 234: <code>+23407061234567</code> is invalid.</span></p><p><FileText size={13} /><span>For CSV files, format the phone column as <strong>Text</strong> to preserve the + sign and leading zero.</span></p></div>
  </section>;
}
function Empty({ icon: Icon = Inbox, title, text, action }: { icon?: typeof Send; title: string; text: string; action?: ReactNode }) { return <div className="empty"><div className="empty-icon"><Icon size={24} strokeWidth={1.6} /></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Button({ children, className = "", busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) { return <button type="button" {...props} className={`button ${className}`} disabled={props.disabled || busy}>{busy ? <LoaderCircle size={16} className="spin" /> : null}{children}</button>; }
function ProviderBalanceCard({ snapshot, fetching, error, configured, available, onRefresh, onConfigure, compact = false }: { snapshot: ProviderBalance | null; fetching: boolean; error: string; configured: boolean; available: boolean; onRefresh: () => void; onConfigure: () => void; compact?: boolean }) {
  const stale = !!snapshot && (!!error || Date.now() - snapshot.fetchedAt >= ACCOUNT_REFRESH_MS);
  const amount = snapshot ? new Intl.NumberFormat("en-NG", { style: "currency", currency: snapshot.currency, maximumFractionDigits: 2 }).format(snapshot.balance) : "—";
  return <section className={`provider-balance-card ${compact ? "balance-card-compact" : "panel"}`} aria-label="Termii account balance" aria-busy={fetching}>
    <div className="balance-card-heading"><span className="section-icon"><Wallet size={20} /></span><div><h2>Termii balance</h2><p>Your provider account balance.</p></div>{snapshot && <Badge value={stale ? "pending" : "neutral"}>{stale ? "Last known" : "From Termii"}</Badge>}</div>
    <div className="balance-card-main"><div><strong className="balance-amount">{amount}</strong><p className="balance-updated">{!available ? "Sign in or reconnect your workspace to view your balance." : !configured ? "Connect your Termii account to load its balance." : snapshot ? `Fetched ${date(snapshot.fetchedAt)} WAT` : fetching ? "Loading your account balance…" : error ? "The current balance is unavailable." : "Your balance has not been loaded yet."}</p></div><div className="balance-card-actions">{available && !configured ? <Button className="secondary small" onClick={onConfigure}>Connect Termii<ArrowRight size={14} /></Button> : <Button className="secondary small" onClick={onRefresh} busy={fetching} disabled={!available || !configured}>{!fetching && <RefreshCw size={14} />}Refresh balance</Button>}</div></div>
    {available && configured && error && <div className="account-inline-error" role="status"><AlertCircle size={15} /><span>{error}{snapshot ? " The amount above is the last successful balance, not a current confirmation." : ""}</span></div>}
    {available && configured && <p className="balance-card-note">{fetching && snapshot ? "Refreshing… " : ""}Updates every 5 minutes while this tab is visible. Balance checks do not send messages.</p>}
  </section>;
}
function Modal({ title, subtitle, children, onClose, wide = false, locked = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; locked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const controls = useRef({ onClose, locked });
  controls.current = { onClose, locked };
  const focusable = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')).filter(node => node.getClientRects().length > 0);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    if (el) (focusable(el)[0] || el).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !controls.current.locked) controls.current.onClose();
      if (event.key !== "Tab" || !el) return;
      const nodes = focusable(el), first = nodes[0], last = nodes.at(-1);
      if (!first || !last) { event.preventDefault(); el.focus(); return; }
      if (!el.contains(document.activeElement) || document.activeElement === el) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); if (prior?.isConnected && prior !== document.body) prior.focus(); else document.getElementById("workspace-content")?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const el = ref.current, active = document.activeElement;
    if (el && (!el.contains(active) || (active instanceof HTMLButtonElement && active.disabled))) (focusable(el)[0] || el).focus();
  }, [locked]);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !locked) onClose(); }}><div className={`modal ${wide ? "modal-wide" : ""}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={locked}><X size={21} /></button></div>{children}</div></div>;
}

export default function Home() {
  const [state, setState] = useState<AppState>(blankState), [view, setView] = useState<View>("overview"), [loading, setLoading] = useState(true), [authNeeded, setAuthNeeded] = useState(false), [loadError, setLoadError] = useState("");
  const [termiiSetupOpen, setTermiiSetupOpen] = useState(false);
  const [sidebar, setSidebar] = useState(false), [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null), [busy, setBusy] = useState("");
  const [search, setSearch] = useState(""), [contactGroup, setContactGroup] = useState("all"), [selectedContacts, setSelectedContacts] = useState<string[]>([]), [importOpen, setImportOpen] = useState(false), [deleteOpen, setDeleteOpen] = useState(false);
  const [importTab, setImportTab] = useState("manual"), [importText, setImportText] = useState(""), [importName, setImportName] = useState(""), [importPhone, setImportPhone] = useState(""), [importGroup, setImportGroup] = useState("General"), [importConsent, setImportConsent] = useState(false), [importFileName, setImportFileName] = useState(""), [importResults, setImportResults] = useState<{ inserted: number; duplicates: number; invalid: number; errors: string[] } | null>(null);
  const [campaignName, setCampaignName] = useState(""), [message, setMessage] = useState(""), [senderId, setSenderId] = useState("Trezad"), [channel, setChannel] = useState<"generic" | "dnd" | "whatsapp">("generic"), [recipientGroup, setRecipientGroup] = useState("all"), [recipientIds, setRecipientIds] = useState<string[]>([]), [recipientSearch, setRecipientSearch] = useState("");
  const [audienceSource, setAudienceSource] = useState<"contacts" | "direct">("contacts"), [directNumbers, setDirectNumbers] = useState(""), [directConsent, setDirectConsent] = useState(false);
  const [confirmRecipients, setConfirmRecipients] = useState<Recipient[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null), [confirmCampaign, setConfirmCampaign] = useState<Campaign | null>(null), [sendPermission, setSendPermission] = useState(false), [campaignFilter, setCampaignFilter] = useState("all"), [campaignSearch, setCampaignSearch] = useState("");
  const [formSettings, setFormSettings] = useState<Settings>(blankState.settings), [dispatchProgress, setDispatchProgress] = useState("");
  const [senderIds, setSenderIds] = useState<SenderIdsSnapshot | null>(null), [senderIdsLoading, setSenderIdsLoading] = useState(false), [senderIdsError, setSenderIdsError] = useState("");
  const [senderRequestForm, setSenderRequestForm] = useState({ senderId: "", company: "", useCase: "" });
  const [senderRequestNotice, setSenderRequestNotice] = useState<{ text: string; error: boolean } | null>(null), [localSenderRequests, setLocalSenderRequests] = useState<SenderIdRequest[]>([]);
  const smsSelectionIdentity = useRef("");
  const stateRequestSequence = useRef(0);
  const stateValue = useRef(state);
  stateValue.current = state;
  const providerIdentity = useRef({ key: "", provider: blankState.provider });
  const providerReadsAllowed = useRef(false);
  const senderIdsSequence = useRef(0);
  const senderIdsInFlight = useRef<{ key: string; id: number; task: Promise<void> } | null>(null);
  const [lastSmsChannel, setLastSmsChannel] = useState<"generic" | "dnd">("generic"), [formWhatsApp, setFormWhatsApp] = useState<WhatsAppSettings>(blankWhatsApp), [whatsappData, setWhatsAppData] = useState<Record<string, string>>({}), [whatsappPermission, setWhatsAppPermission] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const pauseAfterBatch = useRef(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(""), [apiKey, setApiKey] = useState(""), [showApiKey, setShowApiKey] = useState(false), [removeCredentialsOpen, setRemoveCredentialsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const notify = (text: string, error = false) => setToast({ text, error });
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), toast.error ? 11000 : 7000); return () => clearTimeout(t); } }, [toast]);
  const applySavedSenderFields = useCallback((settings: Settings) => {
    setFormSettings(previous => ({ ...previous, senderId: settings.senderId, senderApproved: settings.senderApproved, senderApprovalSource: settings.senderApprovalSource ?? null, senderVerifiedAt: settings.senderVerifiedAt ?? null }));
  }, []);
  const syncProviderIdentity = useCallback((provider: Provider) => {
    const key = providerConnectionKey(provider);
    const changed = key !== providerIdentity.current.key;
    providerIdentity.current = { key, provider };
    if (changed) {
      // Invalidate in-flight reads before rendering a different account's data.
      senderIdsSequence.current++;
      senderIdsInFlight.current = null;
      setSenderIds(null); setSenderIdsError(""); setSenderIdsLoading(false);
      setLocalSenderRequests([]); setSenderRequestNotice(null);
      setFormSettings(previous => ({ ...previous, senderApproved: false, senderApprovalSource: null, senderVerifiedAt: null }));
    }
    return changed;
  }, []);
  const load = useCallback(async (initial = false) => {
    const requestId = ++stateRequestSequence.current;
    if (initial) setLoading(true);
    try {
      const response = await api<AppState>("/api/state");
      const next = { ...response, smsProviders: response.smsProviders || [], activeSmsProviderId: response.activeSmsProviderId || null, smsRoutingRevision: response.smsRoutingRevision || 0, whatsapp: response.whatsapp || blankWhatsApp };
      if (requestId !== stateRequestSequence.current) return next;
      const connectionChanged = syncProviderIdentity(next.provider);
      setState(next); setAuthNeeded(false); setLoadError("");
      const selected = next.smsProviders.find(provider => provider.id === next.activeSmsProviderId) || next.smsProviders.find(provider => provider.id === "termii");
      const selectionKey = `${next.activeSmsProviderId || "paused"}:${selected?.credentialRevision || 0}:${selected?.senderId || next.settings.senderId}`;
      if (initial || selectionKey !== smsSelectionIdentity.current) {
        setSenderId(selected?.senderId || next.settings.senderId);
        if (selected && !selected.supportsDnd) { setChannel(previous => previous === "dnd" ? "generic" : previous); setLastSmsChannel("generic"); }
        smsSelectionIdentity.current = selectionKey;
      }
      if (initial) { setFormSettings(next.settings); setFormWhatsApp(next.whatsapp); setApiBaseUrl(next.provider.baseUrl || ""); }
      else if (connectionChanged) { applySavedSenderFields(next.settings); setApiBaseUrl(next.provider.baseUrl || ""); }
      return next;
    } catch (e) { const error = e as ApiError; if (requestId === stateRequestSequence.current) { if (error.status === 401) setAuthNeeded(true); else setLoadError(error.message); } if (!initial) throw e; }
    finally { if (requestId === stateRequestSequence.current) setLoading(false); }
  }, [applySavedSenderFields, syncProviderIdentity]);
  const reloadProviders = useCallback(async (): Promise<SmsProviderDirectoryState> => {
    const requestId = ++stateRequestSequence.current;
    const directory = await api<SmsProviderDirectoryState>("/api/sms/providers");
    if (requestId !== stateRequestSequence.current) return directory;
    const termii = directory.smsProviders.find(provider => provider.id === "termii");
    const current = stateValue.current;
    // Most provider actions only change routing or one account. Reload the full
    // workspace only when the shared Termii sender / WhatsApp state also changed.
    if (termii && (termii.revision !== current.provider.revision || termii.credentialRevision !== current.provider.credentialRevision || termii.verifiedAt !== current.provider.verifiedAt || termii.senderId !== current.settings.senderId || termii.senderApproved !== current.settings.senderApproved)) {
      const next = await load();
      if (!next) throw new Error("The current provider settings could not be reloaded. Refresh the page before activating an account.");
      return next;
    }
    setState(previous => ({ ...previous, ...directory }));
    const selected = directory.smsProviders.find(provider => provider.id === directory.activeSmsProviderId) || termii;
    const selectionKey = `${directory.activeSmsProviderId || "paused"}:${selected?.credentialRevision || 0}:${selected?.senderId || current.settings.senderId}`;
    if (selectionKey !== smsSelectionIdentity.current) {
      setSenderId(selected?.senderId || current.settings.senderId);
      if (selected && !selected.supportsDnd) { setChannel(previous => previous === "dnd" ? "generic" : previous); setLastSmsChannel("generic"); }
      smsSelectionIdentity.current = selectionKey;
    }
    return directory;
  }, [load]);
  const smsBalances = useSmsProviderBalances(state.smsProviders, !loading && !authNeeded && !loadError, reloadProviders);
  const activeSmsProvider = state.smsProviders.find(provider => provider.id === state.activeSmsProviderId) || null;
  const composerSmsProvider = activeSmsProvider || state.smsProviders.find(provider => provider.id === "termii") || null;
  const smsDefinition = getSmsProviderDefinition(composerSmsProvider?.id || "termii")!;
  const campaignProviderName = (campaign: Campaign) => campaign.channel === "whatsapp" ? "Termii" : campaign.smsProviderName || getSmsProviderDefinition(campaign.smsProviderId || "termii")?.name || "Termii";
  const campaignProviderDefinition = (campaign: Campaign) => getSmsProviderDefinition(campaign.channel === "whatsapp" ? "termii" : campaign.smsProviderId || "termii")!;
  const refreshSenderIds = useCallback((force = false): Promise<void> => {
    const { key, provider } = providerIdentity.current;
    if (!key || !providerReadsAllowed.current) return Promise.resolve();
    if (!force && senderIdsInFlight.current?.key === key) return senderIdsInFlight.current.task;
    const id = ++senderIdsSequence.current;
    setSenderIdsLoading(true);
    const task = (async () => {
      try {
        const result = await api<SenderIdsResult>("/api/provider/sender-ids");
        if (id !== senderIdsSequence.current || key !== providerIdentity.current.key) return;
        if (result.credentialRevision !== provider.credentialRevision) {
          setSenderIds(null); setSenderIdsError("The saved connection changed. Reloading account details…");
          await load().catch(() => undefined); return;
        }
        setSenderIds({ ...result, connectionKey: key }); setSenderIdsError("");
        setLocalSenderRequests(previous => previous.filter(request => request.status === "submitting" || (!result.requests.some(saved => senderKey(saved.senderId) === senderKey(request.senderId)) && !result.senderIds.some(saved => usableSenderId(saved) && senderKey(saved.senderId) === senderKey(request.senderId)))));
        if (result.senderApprovalRevoked) {
          const next = await load().catch(() => undefined);
          if (next && key === providerIdentity.current.key) applySavedSenderFields(next.settings);
        }
      } catch (error) {
        if (id === senderIdsSequence.current && key === providerIdentity.current.key) {
          setSenderIdsError((error as Error).message);
          if ((error as ApiError).status === 409 && (error as ApiError).code === "provider_revision_conflict") {
            setSenderIds(null);
            await load().catch(() => undefined);
          }
        }
      } finally {
        if (id === senderIdsSequence.current && key === providerIdentity.current.key) setSenderIdsLoading(false);
        if (senderIdsInFlight.current?.id === id) senderIdsInFlight.current = null;
      }
    })();
    senderIdsInFlight.current = { key, id, task };
    return task;
  }, [applySavedSenderFields, load]);
  const accountReadable = !loading && !authNeeded && !loadError && state.provider.configured;
  const accountKey = providerConnectionKey(state.provider);
  providerReadsAllowed.current = accountReadable;
  useEffect(() => { if (accountReadable && accountKey) void refreshSenderIds(); }, [accountReadable, accountKey, refreshSenderIds]);
  useEffect(() => {
    if (view !== "settings" || !accountReadable || !accountKey) return;
    const refreshVisible = () => { if (document.visibilityState === "visible") void refreshSenderIds(); };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, ACCOUNT_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [view, accountReadable, accountKey, refreshSenderIds]);
  useEffect(() => { void load(true); const read = () => { const hash = location.hash.slice(1); if (["overview", "compose", "contacts", "campaigns", "templates", "email", "marketing", "settings"].includes(hash)) setView(hash as View); }; read(); window.addEventListener("hashchange", read); return () => window.removeEventListener("hashchange", read); }, [load]);
  const go = (next: View) => { if (next === "settings" && channel === "whatsapp") setTermiiSetupOpen(true); setView(next); setSidebar(false); location.hash = next; window.scrollTo({ top: 0 }); requestAnimationFrame(() => { if (!document.querySelector('[role="dialog"]')) document.getElementById("workspace-content")?.focus({ preventScroll: true }); }); };
  useEffect(() => { if (view !== "settings") { setApiKey(""); setShowApiKey(false); } }, [view]);
  useEffect(() => {
    if (!sidebar) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = sidebarRef.current;
    const frame = requestAnimationFrame(() => panel?.querySelector<HTMLElement>("button, a[href]")?.focus());
    const breakpoint = window.matchMedia("(max-width: 900px)");
    const closeOnDesktop = () => { if (!breakpoint.matches) setSidebar(false); };
    breakpoint.addEventListener("change", closeOnDesktop);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
      if (event.key !== "Tab" || !panel) return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!panel.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); breakpoint.removeEventListener("change", closeOnDesktop); document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [sidebar]);
  const apiDirty = apiBaseUrl.trim() !== (state.provider.baseUrl || "") || apiKey.length > 0;
  const senderSettingsDirty = formSettings.senderId !== state.settings.senderId || formSettings.senderApproved !== state.settings.senderApproved;
  const providerActionsAvailable = state.provider.configurationAvailable && !authNeeded && !loading;
  const termiiBalance = smsBalances.balances.termii?.key === `termii:${state.provider.credentialRevision}` ? smsBalances.balances.termii : undefined;
  const currentBalance = state.provider.configured ? termiiBalance?.snapshot || null : null;
  const balanceLoading = !!termiiBalance?.loading, balanceError = termiiBalance?.error || "";
  const currentSenderIds = senderIds?.connectionKey === accountKey ? senderIds : null;
  const senderRequestHistory = useMemo(() => {
    const requests = new Map<string, SenderIdRequest>();
    [...(currentSenderIds?.requests || [])].sort((a, b) => b.requestedAt - a.requestedAt).forEach(request => { if (!requests.has(senderKey(request.senderId))) requests.set(senderKey(request.senderId), request); });
    localSenderRequests.forEach(request => { if (request.status === "submitting" || !requests.has(senderKey(request.senderId))) requests.set(senderKey(request.senderId), request); });
    return [...requests.values()].sort((a, b) => b.requestedAt - a.requestedAt);
  }, [currentSenderIds, localSenderRequests]);
  const requestedSender = senderRequestForm.senderId.trim();
  const existingSenderRequest = senderRequestHistory.find(request => senderKey(request.senderId) === senderKey(requestedSender) && ["submitting", "pending", "unknown"].includes(request.status));
  const registeredRequestedSender = currentSenderIds?.senderIds.find(sender => senderKey(sender.senderId) === senderKey(requestedSender) && sender.country.trim().toLowerCase() === "nigeria");
  const senderRequestValid = validateSenderId(requestedSender) && /^[A-Za-z0-9]{3,11}$/.test(requestedSender) && senderRequestForm.company.trim().length >= 2 && senderRequestForm.company.trim().length <= 200 && senderRequestForm.useCase.trim().length >= 10 && senderRequestForm.useCase.trim().length <= 2000;
  const canManageSenderIds = accountReadable && providerActionsAvailable && !apiDirty;
  const savedSenderVerified = state.settings.senderApproved && state.settings.senderApprovalSource === "termii";
  const formSenderVerified = formSettings.senderApproved && formSettings.senderApprovalSource === "termii" && formSettings.senderId === state.settings.senderId && savedSenderVerified;
  const isWhatsApp = channel === "whatsapp";
  const whatsappSettingsDirty = ["deviceId", "businessName", "templateId", "templateBody", "category", "accountApproved", "templateApproved", "ratePerMessage"].some((key) => formWhatsApp[key as keyof WhatsAppSettings] !== state.whatsapp[key as keyof WhatsAppSettings]);
  const whatsappLiveActive = state.whatsapp.liveEnabled && state.whatsapp.providerRevision === state.provider.credentialRevision;
  const canEnableWhatsApp = state.provider.configured && !!state.provider.verifiedAt && state.whatsapp.configured && state.whatsapp.accountApproved && state.whatsapp.templateApproved && !whatsappSettingsDirty && !apiDirty;
  const whatsappValues = useMemo(() => Object.fromEntries(state.whatsapp.templateKeys.map((key) => [key, whatsappData[key] || ""])), [state.whatsapp.templateKeys, whatsappData]);
  const whatsappPreview = useMemo(() => {
    if (!state.whatsapp.templateBody) return { text: "", ready: false, error: "Add your approved WhatsApp text template in Provider settings." };
    try { return { text: renderWhatsAppTemplate(state.whatsapp.templateBody, whatsappValues), ready: true, error: "" }; }
    catch (e) { return { text: state.whatsapp.templateBody, ready: false, error: (e as Error).message }; }
  }, [state.whatsapp.templateBody, whatsappValues]);
  const whatsappFormKeys = useMemo(() => {
    if (!formWhatsApp.templateBody.trim()) return { keys: [] as string[], error: "" };
    try { return { keys: whatsappTemplateKeys(formWhatsApp.templateBody), error: "" }; }
    catch (e) { return { keys: [] as string[], error: (e as Error).message }; }
  }, [formWhatsApp.templateBody]);
  const displayMessage = isWhatsApp ? whatsappPreview.text : message;
  const displaySender = isWhatsApp ? state.whatsapp.businessName || "Your business" : senderId || "Your sender";
  const deliveryReady = !isWhatsApp || (state.whatsapp.configured && whatsappPreview.ready && whatsappPermission);
  const selectDelivery = (next: "sms" | "whatsapp") => {
    if (next === "whatsapp") { if (channel !== "whatsapp") setLastSmsChannel(channel); setChannel("whatsapp"); }
    else setChannel(lastSmsChannel);
    setWhatsAppPermission(false);
  };
  const launchComposer = (delivery: "sms" | "whatsapp", direct = false) => {
    selectDelivery(delivery);
    if (direct) { setAudienceSource("direct"); setDirectNumbers(""); setDirectConsent(false); notify("Add your own number to test your message. Your message text is kept in the composer."); }
    go("compose");
  };
  const groups = useMemo(() => Array.from(new Set(state.contacts.map((c) => c.group || "General"))).sort(), [state.contacts]);
  const eligible = state.contacts.filter((c) => c.consent && !c.suppressed);
  const visibleContacts = state.contacts.filter((c) => (contactGroup === "all" || c.group === contactGroup) && `${c.name} ${c.phone} ${c.group}`.toLowerCase().includes(search.toLowerCase()));
  const potentialRecipients = eligible.filter((c) => (recipientGroup === "all" || c.group === recipientGroup) && `${c.name} ${c.phone}`.toLowerCase().includes(recipientSearch.toLowerCase()));
  const eligibleContactIds = new Set(eligible.map((c) => c.id));
  const activeRecipientIds = recipientIds.filter((id) => eligibleContactIds.has(id));
  const directParsed = useMemo(() => parseDirectNumbers(directNumbers), [directNumbers]);
  const blockedContactPhones = useMemo(() => new Map(state.contacts.filter((c) => c.suppressed || !c.consent).map((c) => [c.phone, c])), [state.contacts]);
  const blockedDirectPhones = directParsed.phones.filter((phone) => blockedContactPhones.has(phone));
  const eligibleDirectPhones = directParsed.phones.filter((phone) => !blockedContactPhones.has(phone));
  const activeRecipientCount = audienceSource === "direct" ? eligibleDirectPhones.length : activeRecipientIds.length;
  const audienceReady = activeRecipientCount > 0 && activeRecipientCount <= MAX_DIRECT_RECIPIENTS && (audienceSource === "contacts" || (!directParsed.error && directParsed.invalid.length === 0 && blockedDirectPhones.length === 0 && directConsent));
  const info = segmentInfo(message);
  const unitRate = isWhatsApp ? state.whatsapp.ratePerMessage : composerSmsProvider?.ratePerSegment ?? null;
  const unitsPerRecipient = isWhatsApp ? 1 : info.segments;
  const estimate = unitRate == null ? null : unitRate * unitsPerRecipient * activeRecipientCount;
  const submitted = state.campaigns.filter((c) => c.mode === "live").reduce((n, c) => n + (c.summary.accepted || 0) + (c.summary.delivered || 0), 0);
  const delivered = state.campaigns.filter((c) => c.mode === "live").reduce((n, c) => n + (c.summary.delivered || 0), 0);
  const connectionSetupReady = !!(activeSmsProvider?.verifiedAt && activeSmsProvider.senderApproved) || (!!state.provider.verifiedAt && state.whatsapp.configured && state.whatsapp.accountApproved && state.whatsapp.templateApproved);
  const stepsDone = [connectionSetupReady, state.contacts.length > 0, state.campaigns.length > 0].filter(Boolean).length;
  const whatsappReadyToSend = state.provider.configured && !!state.provider.verifiedAt && whatsappLiveActive && state.whatsapp.configured && state.whatsapp.accountApproved && state.whatsapp.templateApproved;
  const dataAvailable = !loading && !authNeeded && !loadError;
  const smsLiveActive = !!(activeSmsProvider?.configured && activeSmsProvider.verifiedAt && activeSmsProvider.senderApproved && activeSmsProvider.isActive);
  const connectionLabel = !dataAvailable ? loading ? "Loading workspace" : authNeeded ? "Sign in to connect" : "Connection unavailable" : smsLiveActive ? `${activeSmsProvider?.name} · SMS active` : whatsappReadyToSend ? "WhatsApp active · SMS paused" : "Sending paused";
  const metricValue = (value: number) => dataAvailable ? number(value) : "—";
  const canLive = isWhatsApp ? whatsappReadyToSend : smsLiveActive && senderId.trim() === activeSmsProvider?.senderId && (channel !== "dnd" || (activeSmsProvider?.supportsDnd && activeSmsProvider.transactionalEnabled));
  const channelBlocker = (delivery: "generic" | "dnd" | "whatsapp", sender: string, snapshot?: WhatsAppSnapshot | null): string => {
    if (authNeeded) return "Sign in to your private workspace to prepare and send campaigns.";
    if (loadError) return "Reconnect your workspace before sending. Use Retry in the connection notice.";
    if (delivery === "whatsapp") {
      if (!state.provider.configured) return "Connect and verify your Termii account in Provider settings for WhatsApp.";
      if (!state.provider.verifiedAt) return "Test your Termii connection before sending WhatsApp messages.";
      if (!state.whatsapp.configured) return "Save your WhatsApp business, device and approved text template in settings.";
      if (!state.whatsapp.accountApproved || !state.whatsapp.templateApproved) return "Confirm your activated WhatsApp device and approved template in settings.";
      if (state.whatsapp.providerRevision !== state.provider.credentialRevision) return "Your Termii connection changed. Re-enable WhatsApp with the current connection in settings.";
      if (!whatsappLiveActive) return "Turn on WhatsApp live sending in Provider settings when you are ready.";
      if (snapshot && (snapshot.deviceId !== state.whatsapp.deviceId || snapshot.businessName !== state.whatsapp.businessName || snapshot.templateId !== state.whatsapp.templateId || snapshot.templateBody !== state.whatsapp.templateBody || snapshot.category !== state.whatsapp.category)) return "The WhatsApp settings changed after this campaign was saved. Duplicate it to use the current template, then review again.";
    } else {
      if (!activeSmsProvider) return "Choose and activate an SMS provider in Provider settings.";
      if (!activeSmsProvider.configured || !activeSmsProvider.verifiedAt) return `Save and test your ${activeSmsProvider.name} connection in Provider settings.`;
      if (!activeSmsProvider.senderApproved) return `Confirm your sender for ${activeSmsProvider.name} in Provider settings.`;
      if (sender.trim() !== activeSmsProvider.senderId) return `Use your saved ${activeSmsProvider.name} sender: ${activeSmsProvider.senderId}.`;
      if (delivery === "dnd" && (!activeSmsProvider.supportsDnd || !activeSmsProvider.transactionalEnabled)) return "This provider has no activated transactional route in this app. Use a supported route or switch providers.";
      if (!activeSmsProvider.isActive) return "Activate this SMS provider in Provider settings.";
    }
    return "";
  };
  const campaignProviderBlocker = (campaign: Campaign) => {
    if (campaign.channel === "whatsapp") return "";
    if (!activeSmsProvider || (campaign.smsProviderId || "termii") !== activeSmsProvider.id) return `This campaign is saved for ${campaignProviderName(campaign)}. Activate that provider to resume it, or duplicate the campaign to use your current provider.`;
    if (campaign.smsCredentialRevision !== undefined && campaign.smsCredentialRevision !== activeSmsProvider.credentialRevision) return "This campaign belongs to an older API connection. Duplicate it and review the new campaign with your current credentials.";
    return "";
  };
  const canSendCampaign = (campaign: Campaign) => {
    return (campaign.channel !== "whatsapp" || !!campaign.whatsapp) && !campaignProviderBlocker(campaign) && !channelBlocker(campaign.channel, campaign.senderId, campaign.whatsapp) && campaign.mode !== "preview" && !["attention", "cancelled", "preparing"].includes(campaign.status) && campaign.summary.unknown === 0 && campaign.summary.pending > 0;
  };
  const detailsReady = !!campaignName.trim() && (isWhatsApp ? state.whatsapp.configured : validSmsSender(composerSmsProvider?.id || "termii", senderId));
  const messageReady = isWhatsApp ? whatsappPreview.ready && whatsappPermission : !!message.trim() && message.length <= smsDefinition.maxMessageLength && !/\{[^}]+\}/.test(message);
  const composerReady = detailsReady && audienceReady && deliveryReady && messageReady;
  const composerGuidance = (() => {
    if (authNeeded || loadError) return { text: channelBlocker(channel, senderId), target: "", action: "" };
    if (!detailsReady) return { text: !campaignName.trim() ? "Give your campaign a name to get started." : isWhatsApp ? "Add your approved WhatsApp template in settings." : smsDefinition.senderHelp, target: isWhatsApp && !!campaignName.trim() ? "settings" : "campaign-details", action: isWhatsApp && !!campaignName.trim() ? "Open settings" : "Campaign details" };
    if (!audienceReady) {
      const problem = audienceSource === "direct" ? directParsed.error || (directParsed.invalid.length ? "Correct the invalid numbers in your audience." : blockedDirectPhones.length ? "Remove suppressed numbers or contacts without permission." : "") : "";
      return { text: problem || (activeRecipientCount === 0 ? "Add at least one recipient using saved contacts or typed numbers." : activeRecipientCount > MAX_DIRECT_RECIPIENTS ? `Choose up to ${number(MAX_DIRECT_RECIPIENTS)} recipients for this campaign.` : "Confirm permission to message the numbers in your audience."), target: "campaign-audience", action: "Review audience" };
    }
    if (!messageReady || !deliveryReady) return { text: isWhatsApp ? !whatsappPreview.ready ? whatsappPreview.error : "Confirm that your audience agreed to receive this WhatsApp message." : !message.trim() ? "Write your message and check it in the phone preview." : message.length > smsDefinition.maxMessageLength ? `Shorten this message to ${number(smsDefinition.maxMessageLength)} characters for ${smsDefinition.name}.` : "Replace every placeholder in braces before continuing.", target: "campaign-message", action: "Review message" };
    const blocked = channelBlocker(channel, senderId);
    return blocked ? { text: blocked, target: !isWhatsApp && senderId.trim() !== composerSmsProvider?.senderId ? "campaign-details" : "settings", action: !isWhatsApp && senderId.trim() !== composerSmsProvider?.senderId ? "Update sender" : "Open settings" } : null;
  })();
  const campaignBlocker = (c: Campaign) => c.mode === "preview" ? "Preview campaigns do not send messages. Duplicate this campaign to prepare a live send." : ["attention", "preparing"].includes(c.status) || c.summary.unknown > 0 ? "Review the uncertain provider outcome before any new submission." : c.status === "cancelled" ? "Pending messages in this campaign were cancelled." : c.summary.pending === 0 ? "There are no pending recipients to send." : c.channel === "whatsapp" && !c.whatsapp ? "This campaign has no saved WhatsApp template. Duplicate it and prepare it with your current template." : campaignProviderBlocker(c) || channelBlocker(c.channel, c.senderId, c.whatsapp);
  const jumpToSection = (id: string) => {
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "start" });
    section?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
  };
  const openTermiiSettings = (section = "settings-api") => {
    setTermiiSetupOpen(true); go("settings");
    requestAnimationFrame(() => jumpToSection(section));
  };
  const toggleRecipient = (id: string) => { setRecipientIds((old) => old.includes(id) ? old.filter((x) => x !== id) : [...old, id]); setWhatsAppPermission(false); };
  const toggleVisibleRecipients = () => { setRecipientIds((old) => potentialRecipients.every((c) => old.includes(c.id)) ? old.filter((id) => !potentialRecipients.some((c) => c.id === id)) : Array.from(new Set([...old, ...potentialRecipients.map((c) => c.id)]))); setWhatsAppPermission(false); };
  const closeImport = useCallback(() => setImportOpen(false), []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeRemoveCredentials = useCallback(() => setRemoveCredentialsOpen(false), []);
  const closeConfirm = useCallback(() => { setConfirmCampaign(null); setConfirmRecipients([]); setSendPermission(false); }, []);
  const openImport = () => { setImportOpen(true); setImportResults(null); };
  const handleImport = async () => { setBusy("import"); setImportResults(null); try { if (!importConsent) throw new Error("Confirm that these contacts have agreed to receive your messages."); const contacts = importTab === "manual" ? [{ name: importName, phone: importPhone, group: importGroup || "General", consent: importConsent }] : parseImport(importText, importConsent, importGroup || "General"); if (!contacts.length) throw new Error("Add at least one phone number to import."); if (contacts.length > 5000) throw new Error("Please import no more than 5,000 contacts at a time."); const result = await api<{ inserted: number; duplicates: number; invalid: number; errors: string[] }>("/api/contacts", { contacts }); setImportResults(result); await load(); if (importTab === "manual" && result.inserted > 0) { setImportName(""); setImportPhone(""); } notify(`${number(result.inserted)} contact${result.inserted === 1 ? "" : "s"} added${result.duplicates ? ` · ${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"} skipped` : ""}.`); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const filePicked = async (file?: File) => { if (!file) return; try { if (file.size > 2 * 1024 * 1024) throw new Error("Please use a CSV file smaller than 2 MB."); const text = await file.text(); parseImport(text, false, "General"); setImportText(text); setImportFileName(file.name); setImportResults(null); } catch (e) { notify((e as Error).message, true); } };
  const patchContact = async (c: Contact, patch: Partial<Contact>) => { setBusy(c.id); try { await api("/api/contacts", { id: c.id, ...patch }, "PATCH"); await load(); notify(patch.suppressed === true ? "Contact suppressed. They will be excluded from future sends." : patch.suppressed === false ? "Contact removed from the suppression list." : "Contact updated."); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const deleteContacts = async () => { setBusy("delete"); try { await api("/api/contacts", { ids: selectedContacts }, "DELETE"); await load(); setSelectedContacts([]); setDeleteOpen(false); notify("Selected contacts deleted."); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const validateComposer = () => {
    if (!campaignName.trim()) throw new Error("Give your campaign a name.");
    if (isWhatsApp) {
      if (!state.whatsapp.configured) throw new Error("Configure your approved WhatsApp text template before creating a campaign.");
      if (!whatsappPreview.ready) throw new Error(whatsappPreview.error || "Complete every template variable.");
      if (!whatsappPermission) throw new Error(`Confirm that these recipients agreed to receive WhatsApp messages from ${state.whatsapp.businessName || "your organisation"}.`);
    } else {
      if (!message.trim()) throw new Error("Write the message you want to send.");
      if (/\{[^}]+\}/.test(message)) throw new Error("Replace the template placeholders in braces before continuing.");
    }
    if (audienceSource === "direct") {
      if (directParsed.error) throw new Error(directParsed.error);
      if (directParsed.invalid.length) throw new Error("Correct or remove every invalid phone number before continuing.");
      if (blockedDirectPhones.length) throw new Error("Remove numbers belonging to suppressed contacts or contacts without consent before continuing.");
      if (!eligibleDirectPhones.length) throw new Error("Type at least one complete Nigerian mobile number.");
      if (!directConsent) throw new Error("Confirm that these are your own test numbers or that you have permission to message them.");
    } else if (!activeRecipientIds.length) throw new Error("Select at least one opted-in contact.");
    if (activeRecipientCount > MAX_DIRECT_RECIPIENTS) throw new Error(`Choose no more than ${number(MAX_DIRECT_RECIPIENTS)} recipients for one campaign.`);
    if (!isWhatsApp && !validSmsSender(composerSmsProvider?.id || "termii", senderId)) throw new Error(smsDefinition.senderHelp);
    if (!isWhatsApp && message.length > smsDefinition.maxMessageLength) throw new Error(`${smsDefinition.name} accepts up to ${number(smsDefinition.maxMessageLength)} characters in this app.`);
  };
  const reviewCampaign = async (campaign: Campaign) => {
    setBusy("review");
    try {
      const verified = campaign.audienceSource === "direct" || campaign.channel === "whatsapp" ? await api<CampaignDetail>(`/api/campaigns/${campaign.id}`) : null;
      setConfirmRecipients(verified ? verified.recipients.filter((r) => r.status === "pending") : []);
      setConfirmCampaign(verified?.campaign || campaign);
      setSendPermission(false);
    } catch (e) { notify(`Could not load the campaign for review: ${(e as Error).message}`, true); }
    finally { setBusy(""); }
  };
  const removeBlockedDirectNumbers = () => {
    setDirectNumbers(directNumbers.split(/[\r\n,;]/).map((entry) => entry.trim()).filter((entry) => entry && !blockedContactPhones.has(normalizePhone(entry) || "")).join("\n"));
    setDirectConsent(false); setWhatsAppPermission(false);
  };
  const createCampaign = async (mode: "draft" | "preview", forSend = false) => {
    setBusy("create");
    try {
      validateComposer();
      const audience = audienceSource === "direct"
        ? { audienceSource: "direct", directNumbers, directConsent: true }
        : { audienceSource: "contacts", contactIds: activeRecipientIds };
      const content = isWhatsApp ? { channel: "whatsapp", whatsappData: whatsappValues, whatsappPermission: true } : { channel, message, senderId, smsProviderId: composerSmsProvider?.id || "termii", smsCredentialRevision: composerSmsProvider?.credentialRevision || 0 };
      const result = await api<{ campaign: Campaign }>("/api/campaigns", { name: campaignName.trim(), mode, ...content, ...audience });
      await load();
      if (forSend) await reviewCampaign(result.campaign);
      else { notify(mode === "preview" ? "Preview validated and saved. No message was sent." : "Campaign saved as a draft."); await showCampaign(result.campaign.id); }
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(""); }
  };
  const showCampaign = async (id: string) => { setBusy("detail"); try { const result = await api<CampaignDetail>(`/api/campaigns/${id}`); setDetail(result); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const dispatch = async () => {
    if (!confirmCampaign || !sendPermission) return;
    const id = confirmCampaign.id;
    const dispatchChannel = confirmCampaign.channel;
    const dispatchProviderId = dispatchChannel === "whatsapp" ? "termii" : confirmCampaign.smsProviderId || "termii";
    const batchLimit = 1050;
    pauseAfterBatch.current = false; setPauseRequested(false);
    setBusy("send"); setDispatchProgress("Submitting the first batch…");
    try {
      let remaining = confirmCampaign.summary.pending;
      let halted = false;
      let result: { campaign: Campaign; remaining: number; halted: boolean; message?: string } | null = null;
      let attempts = 0;
      while (remaining > 0 && !halted && !pauseAfterBatch.current && attempts < batchLimit) {
        setDispatchProgress(`${dispatchChannel === "whatsapp" ? "WhatsApp" : "SMS"} batch ${number(attempts + 1)} · ${number(remaining)} recipients remaining`);
        const next = await api<{ campaign: Campaign; remaining: number; halted: boolean; message?: string }>(`/api/campaigns/${id}/send`, { confirmed: true });
        result = next; remaining = next.remaining; halted = next.halted; attempts++;
        setConfirmCampaign(next.campaign);
        setDispatchProgress(`${number(next.campaign.recipientCount - remaining)} of ${number(next.campaign.recipientCount)} recipients processed`);
      }
      await load(); setConfirmCampaign(null); setConfirmRecipients([]); setSendPermission(false);
      setDetail(await api<CampaignDetail>(`/api/campaigns/${id}`));
      const message = halted ? result?.message || "Sending stopped. Review the campaign before taking another action."
        : pauseAfterBatch.current && remaining > 0 ? `Paused after the current batch. ${number(remaining)} recipients remain. You can review and resume this campaign.`
        : remaining > 0 ? "This submission session reached its batch limit and paused. Review and resume the remaining recipients."
        : campaignProviderDefinition(confirmCampaign).reports === "polling" ? "Submission finished. Refresh delivery reports to check recipient outcomes." : `Submission finished. Check your ${campaignProviderName(confirmCampaign)} dashboard for final delivery reports.`;
      notify(message, halted);
    } catch (e) {
      notify(`${(e as Error).message} Check campaign details before resuming; an uncertain submission is never retried automatically.`, true);
      await load().catch(() => undefined); setConfirmCampaign(null); setConfirmRecipients([]);
      setDetail(await api<CampaignDetail>(`/api/campaigns/${id}`).catch(() => null));
    } finally { setBusy(""); setDispatchProgress(""); setPauseRequested(false); pauseAfterBatch.current = false; void smsBalances.refresh(dispatchProviderId, true); }
  };
  const requestPause = () => { pauseAfterBatch.current = true; setPauseRequested(true); };
  const refreshReports = async () => {
    if (!detail) return;
    const campaignId = detail.campaign.id;
    setBusy("refresh");
    let cursor: number | null = 0, totalUpdated = 0;
    const warnings = new Set<string>();
    try {
      let pages = 0;
      while (cursor !== null) {
        const result: { updated: number; nextCursor: number | null; warnings: string[] } = await api(`/api/campaigns/${campaignId}/refresh`, { cursor });
        totalUpdated += result.updated;
        for (const warning of result.warnings || []) warnings.add(warning);
        pages++;
        const nextCursor = result.nextCursor ?? null;
        if (nextCursor !== null && (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor)) throw new Error("The report refresh stopped because its next page was invalid. The results already received are saved; refresh again to continue.");
        cursor = nextCursor;
        if (cursor !== null && pages >= 500) { warnings.add("This refresh reached its page limit. The results received are saved; refresh again to continue."); break; }
      }
      setDetail(await api<CampaignDetail>(`/api/campaigns/${campaignId}`));
      await load();
      notify(`${number(totalUpdated)} delivery record${totalUpdated === 1 ? "" : "s"} updated. ${warnings.size ? [...warnings].join(" ") : "Provider reports may take time to arrive."}`, warnings.size > 0);
    } catch (e) {
      const updated = await api<CampaignDetail>(`/api/campaigns/${campaignId}`).catch(() => null);
      if (updated) setDetail(updated);
      await load().catch(() => undefined);
      notify(`${totalUpdated ? `${number(totalUpdated)} delivery records were updated. ` : ""}${(e as Error).message}`, true);
    } finally { setBusy(""); }
  };
  const cancelCampaign = async () => { if (!detail) return; setBusy("cancel"); try { await api(`/api/campaigns/${detail.campaign.id}/cancel`, {}); setDetail(await api<CampaignDetail>(`/api/campaigns/${detail.campaign.id}`)); await load(); notify("Pending recipients cancelled. Already submitted messages cannot be recalled."); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const saveSettings = async () => { setBusy("settings"); try { await api("/api/settings", formSettings); const next = await load(); if (next) { setFormSettings(next.settings); if (!next.activeSmsProviderId || next.activeSmsProviderId === "termii") setSenderId(next.settings.senderId); } notify("Sender and estimate settings saved."); } catch (e) { notify((e as Error).message, true); } finally { setBusy(""); } };
  const applyProvider = (provider: Provider) => {
    const changed = syncProviderIdentity(provider);
    setState((previous) => ({ ...previous, provider, ...(changed ? { settings: { ...previous.settings, senderApproved: false, senderApprovalSource: null, senderVerifiedAt: null } } : {}) }));
    setApiBaseUrl(provider.baseUrl || "");
    return changed;
  };
  const providerError = async (error: unknown, prefix = "") => {
    const e = error as Error & { status?: number; code?: string };
    if (e.status === 409 && e.code === "provider_revision_conflict") {
      const latest = await load().catch(() => undefined);
      if (latest) { setApiBaseUrl(latest.provider.baseUrl || ""); setFormSettings(latest.settings); }
      setApiKey(""); setShowApiKey(false);
      notify("Provider settings changed in another session. The latest settings are loaded. Review them and enter any changes again.", true);
    } else notify(`${prefix}${e.message}`, true);
  };
  const saveApiSettings = async (testAfterSave = false) => {
    setBusy(testAfterSave ? "provider-save-test" : "provider-save");
    let saved = false;
    let testStarted = false;
    try {
      if (!providerActionsAvailable) throw new Error("Secure API configuration is currently unavailable. Please try again after it is enabled.");
      const baseUrl = apiBaseUrl.trim();
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { throw new Error("Enter the complete HTTPS base URL from your Termii dashboard."); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Use the HTTPS base URL from your dashboard, without credentials, query parameters or a fragment.");
      if (!apiKey.trim() && !state.provider.apiKeyConfigured) throw new Error("Enter your Termii API key to connect your account.");
      const result = await api<{ provider: Provider }>("/api/provider/settings", { baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), revision: state.provider.revision });
      saved = true;
      setApiKey(""); setShowApiKey(false);
      const identityChanged = applyProvider(result.provider);
      { const next = await load(); if (identityChanged && next) applySavedSenderFields(next.settings); }
      if (testAfterSave) {
        const expectedKey = providerIdentity.current.key;
        testStarted = true;
        const check = await api<ProviderCheck>("/api/provider/check", {});
        if (expectedKey !== providerIdentity.current.key) throw new Error("The connection changed while it was being checked. Test the current saved connection again.");
        const connectionChanged = applyProvider(check.provider);
        { const next = await load(); if (connectionChanged && next) applySavedSenderFields(next.settings); smsBalances.accept({ ...check, providerId: "termii", unit: "money" }, next?.smsProviders.find(provider => provider.id === "termii")); }
        void refreshSenderIds(true);
        notify("API settings saved and connection verified. No message was sent. You can enable live sending after confirming your approved sender.");
      } else notify(result.provider.verifiedAt ? "API settings saved securely." : "API settings saved securely. Test the connection before enabling live sending.");
    } catch (e) { if (testStarted && (e as ApiError).code !== "provider_revision_conflict") await load().catch(() => undefined); await providerError(e, saved ? "API settings were saved, but the connection test failed: " : ""); }
    finally { setBusy(""); }
  };
  const checkConnection = async () => {
    setBusy("connection");
    try {
      if (apiDirty) throw new Error("Save or discard your API changes before testing the saved connection.");
      const expectedKey = providerIdentity.current.key;
      const result = await api<ProviderCheck>("/api/provider/check", {});
      if (expectedKey !== providerIdentity.current.key) throw new Error("The connection changed while it was being checked. Test the current saved connection again.");
      const connectionChanged = applyProvider(result.provider);
      { const next = await load(); if (connectionChanged && next) applySavedSenderFields(next.settings); smsBalances.accept({ ...result, providerId: "termii", unit: "money" }, next?.smsProviders.find(provider => provider.id === "termii")); }
      void refreshSenderIds(true);
      notify("Termii connection verified using a balance check. No message was sent.");
    } catch (e) { if ((e as ApiError).code !== "provider_revision_conflict") await load().catch(() => undefined); await providerError(e); }
    finally { setBusy(""); }
  };
  const removeCredentials = async () => {
    setBusy("provider-remove");
    try {
      const result = await api<{ provider: Provider }>("/api/provider/settings", { revision: state.provider.revision }, "DELETE");
      setApiKey(""); setShowApiKey(false); applyProvider(result.provider); setRemoveCredentialsOpen(false);
      await load();
      notify("Termii credentials removed and live sending disabled. Your contacts and campaigns are preserved.");
    } catch (e) { await providerError(e); }
    finally { setBusy(""); }
  };
  const selectSenderId = async (sender: SenderIdRecord) => {
    if (!usableSenderId(sender) || !canManageSenderIds || busy) return;
    const { key, provider } = providerIdentity.current;
    setBusy(`sender-select:${sender.senderId}`);
    try {
      const result = await api<{ settings: Settings; provider: Provider }>("/api/provider/sender-ids/select", { senderId: sender.senderId, credentialRevision: provider.credentialRevision });
      if (key !== providerIdentity.current.key || result.provider.credentialRevision !== provider.credentialRevision) {
        const next = await load(); if (next) applySavedSenderFields(next.settings);
        throw new Error("The connection changed while selecting this sender. Review the current account's Sender IDs.");
      }
      applyProvider(result.provider);
      setState(previous => ({ ...previous, settings: result.settings }));
      applySavedSenderFields(result.settings); if (!state.activeSmsProviderId || state.activeSmsProviderId === "termii") setSenderId(result.settings.senderId); setSenderIdsError("");
      await load();
      notify(`${result.settings.senderId} saved as your Termii-verified sender. Live sending and your transactional route were not enabled by this action.`);
    } catch (error) {
      if (key === providerIdentity.current.key) setSenderIdsError((error as Error).message);
      if ((error as ApiError).status === 409) { const next = await load().catch(() => undefined); if (next) applySavedSenderFields(next.settings); }
    } finally { setBusy(""); }
  };
  const requestSenderId = async () => {
    if (!canManageSenderIds || busy || !senderRequestValid || existingSenderRequest || registeredRequestedSender) return;
    const { key, provider } = providerIdentity.current;
    const request = { senderId: requestedSender, company: senderRequestForm.company.trim(), useCase: senderRequestForm.useCase.trim(), credentialRevision: provider.credentialRevision };
    const requestedAt = Date.now();
    const updateLocal = (status: SenderIdRequest["status"], reason: string | null, timestamp = requestedAt) => {
      if (key === providerIdentity.current.key) setLocalSenderRequests(previous => [...previous.filter(item => senderKey(item.senderId) !== senderKey(request.senderId)), { senderId: request.senderId, status, requestedAt: timestamp, reason }]);
    };
    updateLocal("submitting", null); setSenderRequestNotice(null); setBusy("sender-request");
    try {
      const result = await api<{ submitted: true; status: "pending"; senderId: string; requestedAt: number; credentialRevision: number; connectionChanged?: boolean }>("/api/provider/sender-ids/request", request);
      if (key !== providerIdentity.current.key || result.credentialRevision !== provider.credentialRevision || result.connectionChanged) {
        await load().catch(() => undefined);
        notify("The Sender ID request was submitted, but the saved connection changed. Review the original Termii account before submitting another request.", true); return;
      }
      updateLocal("pending", null, result.requestedAt);
      setSenderRequestNotice({ text: `${result.senderId} was submitted for approval. It is pending and cannot be used until Termii activates it for Nigeria.`, error: false });
    } catch (error) {
      const e = error as ApiError;
      const uncertain = e.outcome === "unknown" || e.status === undefined || (!e.outcome && e.status >= 500);
      updateLocal(uncertain ? "unknown" : "rejected", e.message);
      if (key === providerIdentity.current.key) setSenderRequestNotice({ text: `${e.message}${uncertain ? " Do not submit this request again until you have checked its status in Termii. No automatic retry was attempted." : ""}`, error: true });
      if (e.status === 409 && e.code === "provider_revision_conflict") { const next = await load().catch(() => undefined); if (next) applySavedSenderFields(next.settings); }
    } finally {
      setBusy("");
      if (key === providerIdentity.current.key) void refreshSenderIds(true);
    }
  };
  const changeWhatsAppSetting = (patch: Partial<WhatsAppSettings>) => {
    const materialChange = ["deviceId", "businessName", "templateId", "templateBody", "category"].some((key) => key in patch && patch[key as keyof WhatsAppSettings] !== formWhatsApp[key as keyof WhatsAppSettings]);
    setFormWhatsApp((previous) => ({ ...previous, ...patch, ...(materialChange ? { liveEnabled: false, accountApproved: false, templateApproved: false } : {}) }));
    setWhatsAppPermission(false);
  };
  const whatsappSettingsError = async (error: unknown) => {
    const e = error as Error & { status?: number; code?: string };
    if (e.status === 409 && (e.code === "whatsapp_revision_conflict" || e.code === "provider_revision_conflict")) {
      const latest = await load().catch(() => undefined);
      if (latest) setFormWhatsApp(latest.whatsapp || blankWhatsApp);
      notify("The connection or WhatsApp settings changed in another session. Review the latest settings and try again.", true);
    } else notify(e.message, true);
  };
  const applyWhatsApp = (whatsapp: WhatsAppSettings) => { setState((previous) => ({ ...previous, whatsapp })); setFormWhatsApp(whatsapp); setWhatsAppPermission(false); };
  const saveWhatsAppSettings = async () => {
    setBusy("whatsapp-settings");
    try {
      if (whatsappFormKeys.error) throw new Error(whatsappFormKeys.error);
      const { deviceId, businessName, templateId, templateBody, category, accountApproved, templateApproved, ratePerMessage } = formWhatsApp;
      const result = await api<{ whatsapp: WhatsAppSettings }>("/api/whatsapp/settings", { deviceId: deviceId.trim(), businessName: businessName.trim(), templateId: templateId.trim(), templateBody, category, accountApproved, templateApproved, ratePerMessage, revision: state.whatsapp.revision });
      applyWhatsApp(result.whatsapp);
      notify("WhatsApp settings saved. These approval confirmations are yours; the app has not independently verified them with Termii.");
    } catch (e) { await whatsappSettingsError(e); }
    finally { setBusy(""); }
  };
  const toggleWhatsAppLive = async () => {
    setBusy("whatsapp-live");
    try {
      if (whatsappSettingsDirty || apiDirty) throw new Error("Save or discard your API and WhatsApp changes before changing WhatsApp live sending.");
      const enabled = !whatsappLiveActive;
      const result = await api<{ whatsapp: WhatsAppSettings }>("/api/whatsapp/settings", { liveEnabled: enabled, revision: state.whatsapp.revision });
      applyWhatsApp(result.whatsapp);
      notify(enabled ? "WhatsApp live sending enabled. Every campaign still needs review and confirmation." : "WhatsApp live sending disabled. Drafts and previews remain available.");
    } catch (e) { await whatsappSettingsError(e); }
    finally { setBusy(""); }
  };
  const useTemplate = (t: typeof templates[number]) => { setCampaignName(t.name); setMessage(t.body); setChannel(t.channel); setLastSmsChannel(t.channel); setWhatsAppPermission(false); go("compose"); notify("Template added. Replace each placeholder in braces with your details."); };
  const duplicate = (c: Campaign) => {
    setCampaignName(`${c.name} — copy`); setChannel(c.channel); setRecipientIds([]); setWhatsAppPermission(false);
    if (c.channel === "whatsapp") setWhatsAppData(c.whatsapp?.data || {});
    else { setMessage(c.message); setSenderId(composerSmsProvider?.senderId || c.senderId); if (c.channel === "dnd" && !composerSmsProvider?.supportsDnd) { setChannel("generic"); setLastSmsChannel("generic"); } else setLastSmsChannel(c.channel); }
    setAudienceSource(c.audienceSource === "direct" ? "direct" : "contacts");
    if (c.audienceSource === "direct") { setDirectNumbers(detail?.campaign.id === c.id ? detail.recipients.map((r) => r.phone).join("\n") : ""); setDirectConsent(false); }
    setDetail(null); go("compose"); notify(c.audienceSource === "direct" ? "Message and numbers copied. Review the numbers and confirm permission for this new campaign." : "Message copied. Select recipients for this new campaign.");
  };
  const allContactSelected = visibleContacts.length > 0 && visibleContacts.every((c) => selectedContacts.includes(c.id));
  const shownCampaigns = state.campaigns.filter((c) => (campaignFilter === "all" || c.mode === campaignFilter) && `${c.name} ${c.message}`.toLowerCase().includes(campaignSearch.toLowerCase()));
  const mainTitle = view === "compose" ? "Send messages" : view === "settings" ? "Provider settings" : navItems.find((n) => n.id === view)?.label || "Overview";

  const CampaignRows = ({ campaigns }: { campaigns: Campaign[] }) => <div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Delivered</th><th>Created</th><th aria-label="Open" /></tr></thead><tbody>{campaigns.map((c) => <tr key={c.id} className="click-row" onClick={() => void showCampaign(c.id)}><td><button className="campaign-name" onClick={(e) => { e.stopPropagation(); void showCampaign(c.id); }}><span className={`row-icon ${c.mode === "preview" ? "preview-icon" : c.channel === "whatsapp" ? "whatsapp-row-icon" : ""}`}>{c.mode === "preview" ? <Eye size={17} /> : c.channel === "whatsapp" ? <MessageCircle size={17} /> : <MessageSquare size={17} />}</span><span><strong>{c.name}</strong><small>{c.senderId} · {c.channel === "whatsapp" ? "WhatsApp template" : `${campaignProviderName(c)} · ${c.segments} segment${c.segments === 1 ? "" : "s"}`}{c.audienceSource === "direct" ? " · Typed numbers" : ""}</small></span></button></td><td><div className="campaign-badges"><Badge value={c.mode === "preview" ? "preview" : c.status} />{c.channel === "whatsapp" && <Badge value="whatsapp">WhatsApp</Badge>}</div></td><td>{number(c.recipientCount)}</td><td>{c.mode === "live" ? number(c.summary.delivered) : "—"}</td><td className="muted table-date">{date(c.createdAt)}</td><td><ChevronRight size={17} className="muted" /></td></tr>)}</tbody></table></div>;

  return <div className="app-shell">
    <a className="skip-link" href="#workspace-content" onClick={(event) => { event.preventDefault(); document.getElementById("workspace-content")?.focus(); }}>Skip to content</a>
    {sidebar && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
    <aside ref={sidebarRef} id="workspace-navigation" role={sidebar ? "dialog" : undefined} aria-modal={sidebar ? true : undefined} aria-label="Workspace navigation" className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
      <button className="brand" onClick={() => go("overview")} aria-label="Trezad campaign workspace home"><span className="brand-mark"><MessageSquare size={23} strokeWidth={2.2} /><span /></span><span>Trezad<span className="brand-sms">SMS & Email</span></span></button>
      {sidebar && <button className="icon-button sidebar-close" aria-label="Close navigation panel" onClick={() => setSidebar(false)}><X size={18} /></button>}
      <div className="workspace"><span className="workspace-avatar">T</span><div><strong>Trezad workspace</strong><span>SMS · WhatsApp · Email <LockKeyhole size={10} /></span></div></div>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Main navigation">{navItems.map(({ id, label: text, icon: Icon }) => <button key={id} onClick={() => go(id)} className={`nav-link ${view === id ? "active" : ""}`} aria-current={view === id ? "page" : undefined}><Icon size={19} strokeWidth={1.8} /><span>{text}</span>{id === "compose" && <span className="nav-plus">+</span>}</button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => { setFormSettings(state.settings); setFormWhatsApp(state.whatsapp); go("settings"); }} className={`nav-link ${view === "settings" ? "active" : ""}`} aria-current={view === "settings" ? "page" : undefined}><Settings2 size={19} strokeWidth={1.8} /><span>Provider settings</span></button><a href={isWhatsApp ? "https://developers.termii.com/" : activeSmsProvider?.docsUrl || smsDefinition.docsUrl} target="_blank" rel="noreferrer" className="nav-link"><CircleHelp size={19} strokeWidth={1.8} /><span>{isWhatsApp ? "WhatsApp documentation" : "Provider documentation"}</span><ArrowUpRight size={14} /></a><div className="sidebar-status"><span className={`status-dot ${dataAvailable && (smsLiveActive || whatsappReadyToSend) ? "green" : "amber"}`} /><div><strong>{dataAvailable ? activeSmsProvider ? activeSmsProvider.name : "Choose an SMS provider" : "Private workspace"}</strong><span>{connectionLabel}</span></div></div><div className="account"><span className="account-avatar">O</span><div><strong>Owner</strong><small>Workspace owner</small></div><LockKeyhole size={14} /></div></div>
    </aside>
    <div className="app-main"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={sidebar} aria-controls="workspace-navigation" onClick={() => setSidebar(true)}><Menu size={22} /></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={14} /><strong>{mainTitle}</strong></div><div className="topbar-right"><button className="topbar-status" onClick={() => go("settings")}><span className={`status-dot ${dataAvailable && (smsLiveActive || whatsappReadyToSend) ? "green" : "amber"}`} />{connectionLabel}<ChevronRight size={13} /></button><span className="country"><span className="flag"><i /><i /><i /></span>Nigeria <span className="time-zone">· WAT</span></span><span className="top-divider" /><span className="private-label"><LockKeyhole size={13} />Private</span><span className="top-avatar" aria-label="Owner workspace">O</span></div></header>
    <main id="workspace-content" tabIndex={-1}>
      {authNeeded && <div className="notice notice-warning"><LockKeyhole size={18} /><span>This is a private workspace. Sign in to load contacts, save drafts and manage campaigns.</span><a href="/signin-with-chatgpt?return_to=/" target="_top" className="text-link">Sign in <ArrowRight size={14} /></a></div>}
      {loadError && <div className="notice notice-error"><AlertCircle size={18} /><span>{loadError}</span><button className="text-link" onClick={() => void load(true)}>Try again <RefreshCw size={14} /></button></div>}
      {loading && <div className="workspace-loading" role="status" aria-live="polite"><div><LoaderCircle size={20} className="spin" /><span>Loading workspace…</span></div><div className="loading-skeleton" /><div className="loading-skeleton" /><div className="loading-skeleton" /><span className="sr-only">Loading campaigns, contacts and channel settings.</span></div>}
      {!loading && <>
      {view === "overview" && <>
        <div className="page-heading overview-heading">
          <div><h1>Overview</h1><p>Manage your SMS, WhatsApp and email campaigns.</p></div>
          <div className="heading-actions">
            <Button className="secondary" onClick={() => launchComposer(isWhatsApp ? "whatsapp" : "sms", true)}><Smartphone size={17} />Test message</Button>
            <Button className="primary" onClick={() => go("compose")}><Plus size={18} />New campaign</Button>
          </div>
        </div>
        <div className="metrics" aria-label="Workspace activity">
          <button className="metric metric-contacts" onClick={() => go("contacts")}><div className="metric-top"><span>Total contacts</span><span className="metric-icon"><Users size={19} /></span></div><strong>{metricValue(state.contacts.length)}</strong><div className="metric-bottom"><small>{dataAvailable ? `${number(eligible.length)} opted in & active` : "Your audience at a glance"}</small><ArrowUpRight size={16} /></div></button>
          <button className="metric metric-campaigns" onClick={() => { setCampaignFilter("all"); go("campaigns"); }}><div className="metric-top"><span>Campaigns</span><span className="metric-icon"><MessageSquare size={19} /></span></div><strong>{metricValue(state.campaigns.length)}</strong><div className="metric-bottom"><small>{dataAvailable ? `${number(state.campaigns.filter(c => c.mode === "draft").length)} drafts saved` : "Drafts, previews & live sends"}</small><ArrowUpRight size={16} /></div></button>
          <button className="metric metric-accepted" onClick={() => { setCampaignFilter("live"); go("campaigns"); }}><div className="metric-top"><span>Provider accepted</span><span className="metric-icon"><Send size={18} /></span></div><strong>{metricValue(submitted)}</strong><div className="metric-bottom"><small>Includes confirmed deliveries</small><ArrowUpRight size={16} /></div></button>
          <button className="metric metric-delivered" onClick={() => { setCampaignFilter("live"); go("campaigns"); }}><div className="metric-top"><span>Delivered</span><span className="metric-icon"><CheckCheck size={20} /></span></div><strong>{metricValue(delivered)}</strong><div className="metric-bottom"><small>Confirmed by delivery reports</small><ArrowUpRight size={16} /></div></button>
        </div>
        <SmsProviderBalances providers={state.smsProviders} activeId={state.activeSmsProviderId} balances={smsBalances.balances} available={dataAvailable} onRefresh={id => void smsBalances.refresh(id, true)} onRefreshAll={() => void smsBalances.refreshAll(true)} onManage={() => go("settings")} />
        {dataAvailable && stepsDone < 3 && <section className="setup-card"><div className="setup-intro"><span className="setup-icon"><Zap size={21} /></span><div><h3>Complete your setup</h3><p>Connect a channel, add recipients and prepare a campaign.</p></div><span className="setup-progress">{stepsDone} of 3 complete</span></div><div className="setup-steps"><button onClick={() => go("settings")}><span className={`step-circle ${connectionSetupReady ? "done" : ""}`}>{connectionSetupReady ? <Check size={13} /> : "1"}</span><span><strong>Connect your channels</strong><small>Select SMS · set up WhatsApp</small></span><ChevronRight size={15} /></button><button onClick={() => { go("contacts"); openImport(); }}><span className={`step-circle ${state.contacts.length ? "done" : ""}`}>{state.contacts.length ? <Check size={13} /> : "2"}</span><span><strong>Add your audience</strong><small>Import opted-in contacts</small></span><ChevronRight size={15} /></button><button onClick={() => go("compose")}><span className={`step-circle ${state.campaigns.length ? "done" : ""}`}>{state.campaigns.length ? <Check size={13} /> : "3"}</span><span><strong>Create your campaign</strong><small>Preview before you send</small></span><ChevronRight size={15} /></button></div></section>}
        <div className="dashboard-grid"><section className="panel recent-campaigns"><div className="panel-heading"><div><h2>Recent campaigns</h2><p>Your latest drafts, previews and submissions.</p></div><button className="text-link" onClick={() => go("campaigns")}>View all<ArrowRight size={15} /></button></div>{!dataAvailable ? <Empty icon={authNeeded ? LockKeyhole : RefreshCw} title={authNeeded ? "Your campaigns are private" : "Campaigns are unavailable"} text={authNeeded ? "Sign in to your workspace to load your campaigns and delivery activity." : "Use Retry in the connection notice to load your campaign activity."} /> : state.campaigns.length ? <CampaignRows campaigns={state.campaigns.slice(0, 5)} /> : <Empty icon={MessageSquare} title="No campaigns yet" text="Write a message, choose your audience and preview your first campaign." action={<Button className="secondary small" onClick={() => go("compose")}><Plus size={15} />Create a campaign</Button>} />}</section>
          <section className="panel channel-health-card"><div className="panel-heading"><div><h2>Channel status</h2><p>Your active delivery connections.</p></div><span className="section-icon"><Radio size={19} /></span></div><button className="channel-health-row" onClick={() => go("settings")}><span className="metric-icon"><MessageSquare size={20} /></span><div><strong>SMS</strong><small>{!dataAvailable ? "Connection status unavailable" : smsLiveActive ? `${activeSmsProvider?.name} · ${activeSmsProvider?.senderId}` : "Choose and activate an SMS provider"}</small></div><Badge value={!dataAvailable ? "neutral" : smsLiveActive ? "active" : "setup"}>{!dataAvailable ? "—" : smsLiveActive ? "Live" : state.smsProviders.some(provider => provider.configured) ? "Paused" : "Set up"}</Badge></button><button className="channel-health-row" onClick={() => go("settings")}><span className="metric-icon"><MessageCircle size={20} /></span><div><strong>WhatsApp · Termii</strong><small>{!dataAvailable ? "Connection status unavailable" : whatsappReadyToSend ? state.whatsapp.businessName + " · approved template" : state.whatsapp.configured ? "Review your template & activation" : "Add your business & template"}</small></div><Badge value={!dataAvailable ? "neutral" : whatsappReadyToSend ? "whatsapp" : "setup"}>{!dataAvailable ? "—" : whatsappReadyToSend ? "Live" : state.whatsapp.configured ? "Live off" : "Set up"}</Badge></button><Button className="secondary full" onClick={() => go("settings")}>Manage connections<ArrowRight size={15} /></Button><small className="provider-note"><LockKeyhole size={12} />Your API key stays encrypted on the server.</small></section>
        </div>
        <div className="dashboard-actions" aria-label="Campaign shortcuts">
          <button className="dashboard-action" onClick={() => launchComposer("sms")}><span><MessageSquare size={20} /></span><div><strong>SMS campaign</strong><small>Create a message for Nigerian mobile numbers.</small></div><ArrowRight size={16} /></button>
          <button className="dashboard-action" onClick={() => launchComposer("whatsapp")}><span><MessageCircle size={20} /></span><div><strong>WhatsApp campaign</strong><small>Use your approved WhatsApp template.</small></div><ArrowRight size={16} /></button>
          <button className="dashboard-action" onClick={() => { go("contacts"); setImportTab("csv"); openImport(); }}><span><Upload size={20} /></span><div><strong>Import contacts</strong><small>Add recipients from a CSV file.</small></div><ArrowRight size={16} /></button>
        </div>
        <div className="bottom-tip"><span><ShieldCheck size={17} />Recipient permissions</span><p>Send to people who have agreed to receive your messages.</p><button onClick={() => go("contacts")}>Manage contacts<ArrowRight size={14} /></button></div>
      </>}
      {view === "compose" && <>
        <div className="page-heading"><div><h1>Create campaign</h1><p>Choose a channel, add recipients and review your message.</p></div><Button className="secondary" onClick={() => { if (isWhatsApp) { setFormWhatsApp(state.whatsapp); go("settings"); } else go("templates"); }}><FileText size={16} />{isWhatsApp ? "Manage approved template" : "Browse templates"}</Button></div>
        {(isWhatsApp ? !state.provider.configured : !activeSmsProvider) && <div className="notice notice-soft"><Eye size={18} /><span><strong>Your workspace is ready to preview.</strong> {isWhatsApp ? "Connect Termii and configure WhatsApp to enable real delivery." : "Choose an active SMS provider in settings to enable real delivery."}</span><button className="text-link" onClick={() => go("settings")}>Set up provider <ArrowRight size={14} /></button></div>}
        <div className="delivery-choice" role="group" aria-label="Delivery channel">
          <button type="button" className={!isWhatsApp ? "selected" : ""} aria-pressed={!isWhatsApp} onClick={() => selectDelivery("sms")}><span className="delivery-choice-icon"><MessageSquare size={21} /></span><span><strong>SMS</strong><small>Reach Nigerian mobile numbers</small></span><span className="delivery-choice-check">{!isWhatsApp && <Check size={14} />}</span></button>
          <button type="button" className={isWhatsApp ? "selected" : ""} aria-pressed={isWhatsApp} onClick={() => selectDelivery("whatsapp")}><span className="delivery-choice-icon"><MessageCircle size={21} /></span><span><strong>WhatsApp</strong><small>Send an approved text template</small></span><span className="delivery-choice-check">{isWhatsApp && <Check size={14} />}</span></button>
        </div>
        <div className="workflow-bar" aria-label="Campaign preparation progress">{[{ label: "Campaign details", done: detailsReady, id: "campaign-details" }, { label: "Choose audience", done: audienceReady, id: "campaign-audience" }, { label: "Prepare message", done: messageReady, id: "campaign-message" }].map((step, index) => <button key={step.id} className={`workflow-step ${step.done ? "complete" : ""}`} onClick={() => jumpToSection(step.id)}><span className="workflow-step-number">{step.done ? <Check size={15} /> : index + 1}</span><span>{step.label}</span>{step.done && <span className="sr-only">Complete</span>}</button>)}</div>
        <div className="composer-grid"><div className="composer-fields"><section className="panel form-section" id="campaign-details"><div className="section-title"><span className="section-number">01</span><div><h2>Campaign details</h2><p>Name this campaign and choose the sending details.</p></div><Badge value={isWhatsApp ? "whatsapp" : "neutral"}>{isWhatsApp ? "WhatsApp" : "SMS"}</Badge></div><label className="field">Campaign name<input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} maxLength={120} placeholder={isWhatsApp ? "e.g. Community group invitation" : "e.g. October customer update"} /></label>
        {isWhatsApp ? <div className="whatsapp-sender-card"><span className="whatsapp-avatar"><MessageCircle size={21} /></span><div><strong>{state.whatsapp.businessName || "Connect your WhatsApp business"}</strong><p>{state.whatsapp.configured ? "One approved text template · " + label(state.whatsapp.category) : "Add your activated device and approved template in settings."}</p>{state.whatsapp.templateId && <small>Template <code>{state.whatsapp.templateId}</code></small>}</div><button className="text-link" onClick={() => { setFormWhatsApp(state.whatsapp); go("settings"); }}>{state.whatsapp.configured ? "Manage" : "Set up"}<ArrowRight size={14} /></button></div> : <><div className="composer-provider"><span className="section-icon"><Radio size={18} /></span><div><small>SMS provider</small><strong>{activeSmsProvider?.name || "No active provider"}</strong><p>{activeSmsProvider ? "New campaigns use this account and its saved sender." : "Drafts use Termii until you activate a provider."}</p></div><button className="text-link" onClick={() => go("settings")}>Change<ArrowRight size={14} /></button></div><div className="field-row"><label className="field">{smsDefinition.senderType === "flexible" ? "Sender ID / number" : "Sender ID"}<input value={senderId} onChange={(e) => setSenderId(e.target.value)} maxLength={smsDefinition.senderType === "flexible" ? 32 : 11} placeholder={smsDefinition.senderType === "flexible" ? "Approved sender or +number" : "Your brand"} /><small>{smsDefinition.senderHelp}</small></label><label className="field">Message type<select value={channel} onChange={(e) => { const next = e.target.value as "generic" | "dnd"; setChannel(next); setLastSmsChannel(next); }}><option value="generic">Promotional</option><option value="dnd" disabled={!composerSmsProvider?.supportsDnd}>Transactional{!composerSmsProvider?.supportsDnd ? " · Termii route" : ""}</option></select><small>{channel === "dnd" ? "Requires an activated transactional route." : "Offers, invitations and subscriber updates."}</small></label></div>{channel === "dnd" ? <div className="inline-note"><ShieldCheck size={15} />Transactional messages must relate to an existing service or account. This route is not for promotions.</div> : <div className="inline-note"><Clock3 size={15} />{smsDefinition.id === "termii" ? "Promotional SMS sending is available from 8 a.m. to 8 p.m. WAT. DND restrictions still apply." : "Promotional SMS is subject to recipient permission, DND and provider/network rules."}</div>}</>}
        </section>
        <section className="panel form-section audience-section" id="campaign-audience">
          <div className="section-title"><span className="section-number">02</span><div><h2>Choose your audience</h2><p>Use saved contacts or type numbers for this campaign.</p></div><Badge value="neutral">{number(activeRecipientCount)} recipients</Badge></div>
          <div className="segmented audience-tabs" role="group" aria-label="Recipient source"><button id="audience-contacts-tab" aria-pressed={audienceSource === "contacts"} aria-controls="audience-contacts-panel" className={audienceSource === "contacts" ? "selected" : ""} onClick={() => { setAudienceSource("contacts"); setWhatsAppPermission(false); }}><Users size={15} />Saved contacts</button><button id="audience-direct-tab" aria-pressed={audienceSource === "direct"} aria-controls="audience-direct-panel" className={audienceSource === "direct" ? "selected" : ""} onClick={() => { setAudienceSource("direct"); setWhatsAppPermission(false); }}><Smartphone size={15} />Type or paste numbers</button></div>
          {audienceSource === "contacts" ? <div id="audience-contacts-panel" role="region" aria-labelledby="audience-contacts-tab"><p className="audience-mode-hint">Choose from your opted-in, unsuppressed contacts. Your selection stays here when you switch to typed numbers.</p>{!eligible.length ? <div className="recipient-empty"><Users size={25} /><h3>No eligible contacts</h3><p>Add your opted-in contacts to get started.</p><Button className="secondary small" onClick={openImport}><Plus size={15} />Add contacts</Button></div> : <><div className="recipient-tools"><div className="search-input"><Search size={16} /><input placeholder="Find a contact" aria-label="Find a recipient" value={recipientSearch} onChange={(e) => setRecipientSearch(e.target.value)} /></div><select aria-label="Recipient group" value={recipientGroup} onChange={(e) => setRecipientGroup(e.target.value)}><option value="all">All groups</option>{groups.map((g) => <option key={g}>{g}</option>)}</select></div><div className="recipient-select-top"><label className="checkbox-label"><input type="checkbox" checked={potentialRecipients.length > 0 && potentialRecipients.every((c) => recipientIds.includes(c.id))} onChange={toggleVisibleRecipients} /><span>Select all {number(potentialRecipients.length)} shown</span></label>{recipientIds.length > 0 && <button className="text-link" onClick={() => { setRecipientIds([]); setWhatsAppPermission(false); }}>Clear selection</button>}</div><div className="recipient-list">{potentialRecipients.length ? potentialRecipients.slice(0, 300).map((c) => <label className="recipient-row" key={c.id}><input type="checkbox" checked={recipientIds.includes(c.id)} onChange={() => toggleRecipient(c.id)} /><span className="contact-avatar">{(c.name || "C")[0].toUpperCase()}</span><span><strong>{c.name || "Unnamed contact"}</strong><small>{c.phone}</small></span><Badge value="neutral">{c.group || "General"}</Badge></label>) : <p className="no-results">No contacts match your search.</p>}</div>{potentialRecipients.length > 300 && <small className="field-hint">Showing the first 300 matches. “Select all” includes all {number(potentialRecipients.length)} matching contacts.</small>}</>}{activeRecipientIds.length > MAX_DIRECT_RECIPIENTS && <p className="direct-error-message" role="alert">Choose no more than {number(MAX_DIRECT_RECIPIENTS)} recipients for one campaign.</p>}</div> : <div id="audience-direct-panel" role="region" aria-labelledby="audience-direct-tab">
            <p className="audience-mode-hint">Send a quick test to your own number, or paste a list. These numbers are used for this campaign and are not added to Contacts.</p>
            <label className="field direct-number-field">Nigerian mobile numbers<textarea rows={5} value={directNumbers} onChange={(e) => { setDirectNumbers(e.target.value); setDirectConsent(false); setWhatsAppPermission(false); }} placeholder="e.g. +2347061234567" aria-describedby="direct-number-hint direct-number-feedback" aria-invalid={!!directParsed.error || directParsed.invalid.length > 0 || blockedDirectPhones.length > 0} spellCheck={false} autoComplete="off" /><small id="direct-number-hint">Separate numbers with a new line, comma or semicolon. Local and +234 formats are accepted. Up to {number(MAX_DIRECT_RECIPIENTS)} entries per campaign.</small></label>
            <div className="direct-number-counts" id="direct-number-feedback" aria-live="polite"><span><CheckCheck size={14} /><strong>{number(eligibleDirectPhones.length)}</strong> valid, eligible {eligibleDirectPhones.length === 1 ? "number" : "numbers"}</span>{directParsed.duplicates > 0 && <span className="direct-duplicates"><Copy size={12} />{number(directParsed.duplicates)} duplicate{directParsed.duplicates === 1 ? "" : "s"} removed</span>}{directNumbers && <button className="text-link" onClick={() => { setDirectNumbers(""); setDirectConsent(false); setWhatsAppPermission(false); }}>Clear list</button>}</div>
            {directParsed.error && <div className="direct-validation direct-validation-error" role="alert"><AlertCircle size={17} /><div><strong>Check this number list</strong><p>{directParsed.error}</p></div></div>}
            {directParsed.invalid.length > 0 && <div className="direct-validation direct-validation-error" role="alert"><AlertCircle size={17} /><div><strong>{number(directParsed.invalid.length)} invalid {directParsed.invalid.length === 1 ? "entry" : "entries"}</strong><p>Correct or remove these entries before saving, previewing or sending.</p><div className="direct-invalid-values">{directParsed.invalid.slice(0, 10).map((entry, i) => <code key={i}>{entry}</code>)}</div>{directParsed.invalid.length > 10 && <small>And {number(directParsed.invalid.length - 10)} more invalid entries.</small>}</div></div>}
            {blockedDirectPhones.length > 0 && <div className="direct-validation direct-validation-blocked" role="alert"><Ban size={17} /><div><strong>{number(blockedDirectPhones.length)} {blockedDirectPhones.length === 1 ? "number is blocked" : "numbers are blocked"}</strong><p>These numbers match saved contacts who are suppressed or have no consent. Remove them from this list before continuing.</p><div className="direct-blocked-list">{blockedDirectPhones.slice(0, 10).map((phone) => <span key={phone}><code>{phone}</code><small>{blockedContactPhones.get(phone)?.suppressed ? "Suppressed" : "No consent"}</small></span>)}</div>{blockedDirectPhones.length > 10 && <small>And {number(blockedDirectPhones.length - 10)} more blocked numbers.</small>}<button className="text-link" onClick={removeBlockedDirectNumbers}>Remove blocked numbers <ArrowRight size={13} /></button></div></div>}
            {eligibleDirectPhones.length > 0 && <div className="direct-normalized-list"><div><strong>Normalised recipients</strong><span>{number(eligibleDirectPhones.length)} unique</span></div><div className="direct-phone-chips">{eligibleDirectPhones.slice(0, 10).map((phone) => <code key={phone}>{phone}</code>)}{eligibleDirectPhones.length > 10 && <span>+{number(eligibleDirectPhones.length - 10)} more</span>}</div></div>}
            <label className="checkbox-label checkbox-card direct-consent"><input type="checkbox" checked={directConsent} onChange={(e) => setDirectConsent(e.target.checked)} /><span><strong>These are my own test numbers or I have permission to message them</strong><small>This permission applies to the numbers entered above. Existing contact suppression is always respected.</small></span></label>
            <p className="direct-number-note"><CircleHelp size={13} />For example, +2347061234567 and 07061234567 become the same recipient. Do not add a 0 after 234.</p>
          </div>}
        </section>
        <section className="panel form-section" id="campaign-message"><div className="section-title"><span className="section-number">03</span><div><h2>{isWhatsApp ? "Personalise your approved template" : "Write your message"}</h2><p>{isWhatsApp ? "Fill the variables in your saved WhatsApp template." : "Write the message your recipients will receive."}</p></div></div>
        {isWhatsApp ? <>
          {!state.whatsapp.configured ? <div className="whatsapp-setup-empty"><span className="whatsapp-avatar"><MessageCircle size={25} /></span><h3>Your business, on WhatsApp</h3><p>Save your activated Termii device and approved text template to prepare this campaign.</p><Button className="secondary small" onClick={() => { setFormWhatsApp(state.whatsapp); go("settings"); }}>Set up WhatsApp<ArrowRight size={15} /></Button></div> : <>
            <div className="whatsapp-template-reference"><div><strong>Saved template reference</strong><Badge value="whatsapp">{label(state.whatsapp.category)}</Badge></div><p>{state.whatsapp.templateBody}</p><small>Termii sends the actual approved template identified by your template ID. This copied text is only a local preview reference.</small></div>
            {state.whatsapp.templateKeys.length > 0 ? <div className="whatsapp-variable-fields">{state.whatsapp.templateKeys.map((key) => <label className="field" key={key}><span>Value for <code>{`{{${key}}}`}</code></span><textarea rows={2} maxLength={1500} value={whatsappData[key] || ""} onChange={(e) => { setWhatsAppData((current) => ({ ...current, [key]: e.target.value })); setWhatsAppPermission(false); }} placeholder={`Enter the value for ${key}`} /><small>This value is the same for every recipient in this campaign.</small></label>)}</div> : <p className="field-hint">This template has no variables. The same approved text will be sent to every recipient.</p>}
            {!whatsappPreview.ready && <div className="inline-note whatsapp-validation"><AlertCircle size={15} /><span>{whatsappPreview.error}</span></div>}
            <div className="whatsapp-permission"><label className="checkbox-label checkbox-card"><input type="checkbox" checked={whatsappPermission} onChange={(e) => setWhatsAppPermission(e.target.checked)} /><span><strong>These recipients agreed to receive WhatsApp messages from {state.whatsapp.businessName || "my organisation"}</strong><small>Their permission covers this {state.whatsapp.category === "marketing" ? "marketing message or invitation" : "service or account update"}. I will honour opt-out requests. A saved phone number or group membership alone is not permission.</small></span></label></div>
            <div className="inline-note"><Users size={15} /><span>For a group invitation, use an approved marketing template containing your invite link. Each recipient decides whether to join; this app does not add people to groups.</span></div>
          </>}
        </> : <><label className="field"><span className="sr-only">SMS message</span><textarea className="message-input" rows={7} maxLength={smsDefinition.maxMessageLength} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hello! Tell your customers something worth reading…" /></label><div className="message-meta"><span>{number(message.length)} / {number(smsDefinition.maxMessageLength)} characters</span><span><Badge value="neutral">{info.encoding}</Badge><strong>{info.segments} SMS segment{info.segments === 1 ? "" : "s"}</strong></span></div><div className="inline-note"><CircleHelp size={15} /><span>{info.encoding === "Unicode" ? "Special characters and emoji use Unicode: 70 units for one segment, 67 per segment for longer messages." : "Standard SMS uses 160 units for one segment, 153 per segment for longer messages. Some symbols count twice."} Estimates can differ from provider billing.</span></div>{channel === "generic" && <p className="field-hint">Include a real opt-out contact or link. Recipients cannot reply to a brand-name sender ID.</p>}</>}
        </section>
        <div className="compose-summary"><span><strong>{number(activeRecipientCount)}</strong> recipients</span><span><strong>{number(activeRecipientCount * unitsPerRecipient)}</strong> {isWhatsApp ? "WhatsApp messages" : "SMS units"}</span><span>Estimate <strong>{money(estimate)}</strong></span></div><div className="compose-actions"><Button className="secondary" disabled={!!busy || authNeeded || loading || !!loadError || !composerReady} onClick={() => void createCampaign("draft")}><FileText size={16} />Save draft</Button><div><Button className="secondary" disabled={!!busy || authNeeded || loading || !!loadError || !composerReady} busy={busy === "create"} onClick={() => void createCampaign("preview")}><Eye size={16} />Run preview</Button><Button className="primary" disabled={!canLive || !!busy || authNeeded || loading || !!loadError || !composerReady} onClick={() => void createCampaign("draft", true)}><Send size={16} />Review & send</Button></div></div>{composerGuidance && <div className="send-lock" id="composer-guidance"><CircleHelp size={16} /><span>{composerGuidance.text}</span>{composerGuidance.target && <button className="text-link" onClick={() => composerGuidance.target === "settings" ? go("settings") : jumpToSection(composerGuidance.target)}>{composerGuidance.action}<ArrowRight size={14} /></button>}</div>}
        </div><aside className="composer-preview"><div className="preview-label"><Smartphone size={16} />{isWhatsApp ? "WHATSAPP TEMPLATE PREVIEW" : "MESSAGE PREVIEW"}</div><div className={`sms-phone ${isWhatsApp ? "whatsapp-phone" : ""}`}><div className="phone-status"><span>9:41</span><span>● ▰</span></div><div className="phone-notch" /><div className="sms-phone-header"><ChevronRight size={18} className="back-arrow" /><div><span className="phone-contact-icon"><MessageCircle size={21} /></span><strong>{displaySender}<ChevronRight size={11} /></strong></div></div><div className="sms-phone-content"><p className="phone-today">Today, 9:41 AM</p><div className={`sms-bubble ${!displayMessage ? "placeholder-bubble" : ""}`}>{displayMessage || (isWhatsApp ? "Your approved template reference will appear here after setup." : "Your message will appear here as you type.")}</div><p className="phone-sms-label">{isWhatsApp ? "WhatsApp · Reference only" : "SMS · Preview only"}</p></div><div className="phone-bottom-bar" /></div><p className="preview-caption">{isWhatsApp ? "Based on your copied template text. Termii’s approved template is the authoritative message." : <>A preview of your message. Actual appearance<br />may vary by device and network.</>}</p><div className="estimate-card"><div><h3>Campaign estimate</h3><span className="tiny-pill">NGN estimate</span></div><dl><div><dt>Recipients</dt><dd>{number(activeRecipientCount)}</dd></div><div><dt>{isWhatsApp ? "Messages per recipient" : "Segments per recipient"}</dt><dd>{unitsPerRecipient}</dd></div><div><dt>{isWhatsApp ? "Total WhatsApp messages" : "Total SMS units"}</dt><dd>{number(activeRecipientCount * unitsPerRecipient)}</dd></div><div className="estimate-total"><dt>Estimated cost</dt><dd>{money(estimate)}</dd></div></dl>{unitRate == null ? <button className="text-link" onClick={() => { setFormSettings(state.settings); setFormWhatsApp(state.whatsapp); go("settings"); }}>Add your account rate <ArrowRight size={13} /></button> : <small>At {money(unitRate)} per {isWhatsApp ? "WhatsApp message" : "SMS segment"}. Your provider’s final charge may differ.</small>}</div>{isWhatsApp && <div className="whatsapp-scale-note"><ShieldCheck size={16} /><p>Start with a small test. For 3,000+ recipients, confirm your account’s current messaging limit and funding with Termii.</p></div>}</aside></div>
      </>}
      {view === "contacts" && <>
        <div className="page-heading"><div><h1>Contacts</h1><p>Manage recipients, groups and messaging permissions.</p></div><div className="heading-actions"><Button className="secondary" disabled={!state.contacts.length} onClick={() => downloadCsv("trezad-contacts.csv", [["name", "phone", "group", "consent", "suppressed"], ...state.contacts.map((c) => [c.name, c.phone, c.group, c.consent, c.suppressed])])}><ArrowDownToLine size={16} />Export</Button><Button className="primary" onClick={openImport}><Plus size={17} />Add contacts</Button></div></div>
        <PhoneFormatHelp />
        <div className="contact-stats"><div><span className="mini-stat-icon"><Users size={19} /></span><span><strong>{metricValue(state.contacts.length)}</strong><small>Total contacts</small></span></div><div><span className="mini-stat-icon green-icon"><CircleCheck size={19} /></span><span><strong>{metricValue(eligible.length)}</strong><small>Opted in & active</small></span></div><div><span className="mini-stat-icon muted-icon"><Ban size={18} /></span><span><strong>{metricValue(state.contacts.filter((c) => c.suppressed).length)}</strong><small>Suppressed</small></span></div><div><span className="mini-stat-icon sand-icon"><Filter size={18} /></span><span><strong>{metricValue(groups.length)}</strong><small>Groups</small></span></div></div>
        <section className="panel"><div className="table-toolbar"><div className="search-input"><Search size={17} /><input placeholder="Search name, number or group…" aria-label="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="toolbar-right"><select aria-label="Filter contacts by group" value={contactGroup} onChange={(e) => setContactGroup(e.target.value)}><option value="all">All groups</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>{selectedContacts.length > 0 && <Button className="danger-ghost small" onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete {selectedContacts.length}</Button>}<span className="table-count">{metricValue(visibleContacts.length)} contacts</span></div></div>{!dataAvailable ? <Empty icon={authNeeded ? LockKeyhole : RefreshCw} title={authNeeded ? "Your contacts are private" : "Contacts are unavailable"} text={authNeeded ? "Sign in to load your saved contacts and groups." : "Use Retry in the connection notice to load your audience."} /> : state.contacts.length ? visibleContacts.length ? <div className="table-scroll"><table><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="Select all visible contacts" checked={allContactSelected} onChange={() => setSelectedContacts((old) => allContactSelected ? old.filter((id) => !visibleContacts.some((c) => c.id === id)) : Array.from(new Set([...old, ...visibleContacts.map((c) => c.id)])))} /></th><th>Contact</th><th>Phone number</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visibleContacts.map((c) => <tr key={c.id}><td className="checkbox-cell"><input type="checkbox" aria-label={`Select ${c.name || c.phone}`} checked={selectedContacts.includes(c.id)} onChange={() => setSelectedContacts((old) => old.includes(c.id) ? old.filter((id) => id !== c.id) : [...old, c.id])} /></td><td><div className="contact-name"><span className="contact-avatar">{(c.name || "C")[0].toUpperCase()}</span><strong>{c.name || "Unnamed contact"}</strong></div></td><td className="phone-number">{c.phone}</td><td><Badge value="neutral">{c.group || "General"}</Badge></td><td><Badge value={c.suppressed ? "suppressed" : c.consent ? "active" : "pending"}>{c.suppressed ? "Suppressed" : c.consent ? "Opted in" : "No consent"}</Badge></td><td><button className="table-action" disabled={!!busy} onClick={() => void patchContact(c, { suppressed: !c.suppressed })}>{busy === c.id ? <LoaderCircle size={13} className="spin" /> : c.suppressed ? <RefreshCw size={13} /> : <Ban size={13} />}{c.suppressed ? "Restore" : "Suppress"}</button></td></tr>)}</tbody></table></div> : <Empty icon={Search} title="No contacts found" text="Try a different name, number or group." /> : <Empty icon={Users} title="No contacts yet" text="Add a contact, paste numbers or import a CSV. We’ll format Nigerian numbers and skip duplicates for you." action={<div className="empty-actions"><Button className="primary" onClick={openImport}><Upload size={16} />Import contacts</Button><button className="text-link" onClick={() => downloadCsv("trezad-contact-template.csv", [["name", "phone", "group", "consent"], ["Example contact", "08012345678", "Customers", "true"]])}>Download CSV template <ArrowDownToLine size={14} /></button></div>} />}</section><div className="bottom-tip"><span><ShieldCheck size={17} />Suppressed contacts</span><p>Suppressed contacts stay in your list but are excluded from future sends.</p></div>
      </>}
      {view === "campaigns" && <><div className="page-heading"><div><h1>Campaigns</h1><p>Review drafts, previews, submissions and delivery reports.</p></div><Button className="primary" onClick={() => go("compose")}><Plus size={17} />New campaign</Button></div><section className="panel"><div className="table-toolbar"><div className="segmented">{["all", "draft", "preview", "live"].map((v) => <button key={v} className={campaignFilter === v ? "selected" : ""} onClick={() => setCampaignFilter(v)}>{v === "all" ? "All campaigns" : label(v)}</button>)}</div><div className="search-input small-search"><Search size={16} /><input placeholder="Search campaigns…" aria-label="Search campaigns" value={campaignSearch} onChange={(e) => setCampaignSearch(e.target.value)} /></div></div>{!dataAvailable ? <Empty icon={authNeeded ? LockKeyhole : RefreshCw} title={authNeeded ? "Your campaigns are private" : "Campaigns are unavailable"} text={authNeeded ? "Sign in to load your drafts, previews and delivery reports." : "Use Retry in the connection notice to load your campaign history."} /> : shownCampaigns.length ? <CampaignRows campaigns={shownCampaigns} /> : <Empty icon={MessageSquare} title={state.campaigns.length ? "No matching campaigns" : "No campaigns yet"} text={state.campaigns.length ? "Try another filter or search term." : "Create a campaign and run a preview. Your drafts, submissions and delivery reports will appear here."} action={!state.campaigns.length && <Button className="primary" onClick={() => go("compose")}><Plus size={16} />Create a campaign</Button>} />}</section><div className="notice notice-soft spacing-top"><CircleHelp size={18} /><span><strong>Accepted is the first step.</strong> A provider acceptance means a message was submitted. Only a delivery report confirms delivery to the recipient.</span></div></>}
      {view === "templates" && <><div className="page-heading"><div><h1>SMS templates</h1><p>Choose a starting point and replace placeholders before sending.</p></div><Button className="secondary" onClick={() => { setMessage(""); setCampaignName(""); selectDelivery("sms"); go("compose"); }}><Plus size={17} />Start from scratch</Button></div><div className="template-grid">{templates.map((t) => <article className="panel template-card" key={t.name}><div className="template-top"><span className={`template-icon ${t.color}`}><t.icon size={22} strokeWidth={1.7} /></span><Badge value="neutral">{t.type}</Badge></div><h2>{t.name}</h2><p>{t.description}</p><div className="template-message">{t.body}</div><button className="text-link" onClick={() => useTemplate(t)}>Use this template <ArrowRight size={16} /></button></article>)}</div><p className="template-footnote"><CircleHelp size={15} />These are SMS writing starters, not approved WhatsApp templates. Replace every placeholder before saving. Transactional SMS needs an approved route.</p><div className="notice notice-soft spacing-top"><MessageCircle size={18} /><span>For WhatsApp, save the exact text template approved for your Termii device in Provider settings.</span><button className="text-link" onClick={() => { setFormWhatsApp(state.whatsapp); go("settings"); }}>WhatsApp settings <ArrowRight size={14} /></button></div></>}
      {view === "email" && <EmailVerifier available={dataAvailable} onNotify={notify} />}
      {view === "marketing" && <EmailMarketing available={dataAvailable} onNotify={notify} onOpenVerifier={() => go("email")} />}
      {view === "settings" && <><div className="page-heading"><div><h1>Provider settings</h1><p>Save your accounts, compare balances and choose one active SMS provider.</p></div><Badge value={activeSmsProvider ? "active" : "neutral"}>{activeSmsProvider ? `${activeSmsProvider.name} active` : "SMS paused"}</Badge></div>
        <nav className="settings-jump-nav" aria-label="Settings sections"><button onClick={() => jumpToSection("settings-providers")}><Radio size={16} />SMS providers<ArrowDownToLine size={13} /></button><button onClick={() => openTermiiSettings("settings-api")}><LockKeyhole size={16} />Termii connection<ArrowDownToLine size={13} /></button><button onClick={() => openTermiiSettings("settings-sender-ids")}><ShieldCheck size={16} />Termii Sender IDs<ArrowDownToLine size={13} /></button><button onClick={() => openTermiiSettings("settings-whatsapp")}><MessageCircle size={16} />WhatsApp settings<ArrowDownToLine size={13} /></button></nav>
        <SmsProviderDirectory providers={state.smsProviders} activeId={state.activeSmsProviderId} routingRevision={state.smsRoutingRevision} termiiSource={state.provider.source} balances={smsBalances.balances} available={dataAvailable} busy={busy} setBusy={setBusy} onReload={reloadProviders} onRefresh={smsBalances.refresh} onBalance={smsBalances.accept} onNotify={notify} onTermiiConfigure={openTermiiSettings} />
        <details className="termii-setup-disclosure" open={termiiSetupOpen} onToggle={event => setTermiiSetupOpen(event.currentTarget.open)}><summary><span className="section-icon"><MessageCircle size={20} /></span><div><strong>Termii connection, Sender IDs & WhatsApp</strong><p>Your existing Termii account and WhatsApp setup stay available independently.</p></div><ChevronDown size={19} /></summary><div className="settings-grid"><div><section className="panel settings-provider" id="settings-api">
          <div className="provider-header"><div className="provider-brand"><span className="termii-symbol large">t<span>•</span></span><div><h2>Termii</h2><p>Your Termii account for SMS and WhatsApp</p></div></div><Badge value={state.provider.verifiedAt ? "connected" : state.provider.configured ? "setup" : "neutral"}>{state.provider.verifiedAt ? "Verified" : state.provider.configured ? "Ready to test" : "Not connected"}</Badge></div>
          <p className="settings-description">Connect your own Termii account here. Save your account-specific base URL and API key, then verify the connection with a balance check.</p>
          {!loading && !authNeeded && !loadError && !state.provider.configurationAvailable && <div className="notice notice-warning"><LockKeyhole size={17} /><span>Secure credential storage is currently unavailable. API configuration is disabled until it is available.</span></div>}
          <div className="api-config-fields">
            <label className="field">Account base URL<input type="url" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="Paste the HTTPS base URL from your Termii dashboard" disabled={!providerActionsAvailable || !!busy} autoComplete="off" autoCapitalize="none" spellCheck={false} /><small>Use the exact account-specific base URL shown in your Termii dashboard.</small></label>
            <div className="field"><label htmlFor="termii-api-key">API key</label><div className="api-key-input"><input id="termii-api-key" name="termii-new-api-key" type={showApiKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={state.provider.apiKeyConfigured ? "Saved securely; leave blank to keep" : "Paste your Termii API key"} disabled={!providerActionsAvailable || !!busy} autoComplete="new-password" autoCapitalize="none" spellCheck={false} /><button type="button" className="icon-button" aria-label={showApiKey ? "Hide newly entered API key" : "Show newly entered API key"} aria-pressed={showApiKey} disabled={!apiKey || !!busy} onClick={() => setShowApiKey((visible) => !visible)}>{showApiKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><small>{state.provider.apiKeyConfigured ? "Your saved key is never displayed. Enter a new key only when you want to replace it." : "Your key is encrypted on the server and is cleared from this field after saving."}</small></div>
          </div>
          <div className="api-privacy-note"><LockKeyhole size={14} /><span>Credentials are shared by SMS and WhatsApp. Connection tests check your balance and send no messages.</span></div>
          {apiDirty && state.provider.configured && <div className="api-unsaved-note"><span className="status-dot amber" /><p>Unsaved edits do not change the active connection. Saving a different key or URL switches live sending off until you verify it again.</p><button className="text-link" disabled={!!busy} onClick={() => { setApiBaseUrl(state.provider.baseUrl || ""); setApiKey(""); setShowApiKey(false); }}>Discard</button></div>}
          <div className="api-save-actions"><Button className="secondary" busy={busy === "provider-save"} disabled={!providerActionsAvailable || !!busy} onClick={() => void saveApiSettings(false)}>Save API settings</Button><Button className="primary" busy={busy === "provider-save-test"} disabled={!providerActionsAvailable || !!busy} onClick={() => void saveApiSettings(true)}><ShieldCheck size={16} />Save & test connection</Button></div>
          <div className="saved-connection"><div><span className={`status-dot ${state.provider.verifiedAt ? "green" : "amber"}`} /><div><strong>{state.provider.verifiedAt ? "Connection verified" : state.provider.configured ? "Connection not yet verified" : "No saved connection"}</strong><p>{state.provider.verifiedAt ? `Verified ${date(state.provider.verifiedAt)} WAT` : state.provider.configured ? "Run a balance check to verify these credentials." : "Save your account details to get started."}</p></div></div><Button className="secondary small" busy={busy === "connection"} disabled={!!busy || !state.provider.configured || apiDirty || !providerActionsAvailable} onClick={() => void checkConnection()}><RefreshCw size={14} />Test saved connection</Button></div>
          <ProviderBalanceCard snapshot={dataAvailable ? currentBalance : null} fetching={balanceLoading} error={balanceError} configured={state.provider.configured} available={dataAvailable} onRefresh={() => void smsBalances.refresh("termii", true)} onConfigure={() => jumpToSection("settings-api")} compact />
          <div className="api-account-actions"><a className="text-link" href="https://app.termii.com/" target="_blank" rel="noreferrer">Open Termii dashboard <ArrowUpRight size={14} /></a>{state.provider.apiKeyConfigured && <button className="text-link remove-credentials-link" disabled={!!busy || !providerActionsAvailable} onClick={() => setRemoveCredentialsOpen(true)}><Trash2 size={13} />Remove saved credentials</button>}</div>
        </section>
        <section className="panel form-section sender-ids-section spacing-top" id="settings-sender-ids">
          <div className="sender-section-heading"><div className="section-title"><span className="section-icon"><ShieldCheck size={20} /></span><div><h2>Sender IDs</h2><p>Review the sender names in your Termii account.</p></div></div><Button className="secondary small" busy={senderIdsLoading} disabled={!accountReadable || !!busy} onClick={() => void refreshSenderIds(true)}>{!senderIdsLoading && <RefreshCw size={14} />}Refresh list</Button></div>
          <p className="settings-description">Use an active Nigerian Sender ID as your default SMS sender, or submit a new name for Termii to review. Approval requests do not send messages.</p>
          {dataAvailable && <div className="sender-current"><div><span>Saved SMS sender</span><strong>{state.settings.senderId}</strong><small>{savedSenderVerified ? `Verified from Termii${state.settings.senderVerifiedAt ? ` · ${date(state.settings.senderVerifiedAt)} WAT` : ""}` : state.settings.senderApproved ? "Manually confirmed by you; not verified from the account list." : "Approval has not been confirmed."}</small></div><Badge value={savedSenderVerified ? "active" : state.settings.senderApproved ? "neutral" : "setup"}>{savedSenderVerified ? "Termii verified" : state.settings.senderApproved ? "Manual confirmation" : "Not approved"}</Badge></div>}
          {!dataAvailable ? <div className="sender-list-empty"><LockKeyhole size={20} /><p>Sign in or reconnect your workspace to load your account’s Sender IDs.</p></div> : !state.provider.configured ? <div className="sender-list-empty"><ShieldCheck size={20} /><p>Save your Termii API connection to load Sender IDs and submit approval requests.</p><button className="text-link" onClick={() => jumpToSection("settings-api")}>Connect Termii<ArrowRight size={14} /></button></div> : <>
            {senderIdsLoading && !currentSenderIds && <div className="account-loading" role="status"><LoaderCircle size={18} className="spin" /><span>Loading Sender IDs from Termii…</span></div>}
            {senderIdsError && <div className="account-inline-error" role="status"><AlertCircle size={16} /><span>{senderIdsError}{currentSenderIds ? " The list below is the last successful result." : ""}</span></div>}
            {currentSenderIds && <>
              <div className="sender-list-meta"><span>{number(currentSenderIds.senderIds.length)} sender{currentSenderIds.senderIds.length === 1 ? "" : "s"} returned{currentSenderIds.total !== null ? ` · ${number(currentSenderIds.total)} in account` : ""}</span><span>{senderIdsError ? "Last loaded" : "Fetched"} {date(currentSenderIds.fetchedAt)} WAT</span></div>
              {!currentSenderIds.complete && <div className="sender-list-notice"><AlertCircle size={16} /><div><strong>This list is incomplete</strong><p>Some Sender IDs may be missing. Review the full list in your <a href="https://app.termii.com/" target="_blank" rel="noreferrer">Termii dashboard <ArrowUpRight size={12} /></a>.</p></div></div>}
              {currentSenderIds.senderApprovalRevoked && <div className="sender-list-notice"><AlertCircle size={16} /><div><strong>Your saved sender needs attention</strong><p>Termii no longer confirms that it is active for Nigeria. Its cached approval and SMS live sending have been turned off. Review the current list before choosing a sender.</p></div></div>}
              {currentSenderIds.senderIds.length ? <ul className="sender-id-list">{currentSenderIds.senderIds.map((item, index) => {
                const usable = usableSenderId(item);
                const selected = usable && savedSenderVerified && senderKey(item.senderId) === senderKey(state.settings.senderId);
                return <li key={`${item.senderId}-${item.country}-${index}`}><div className="sender-id-identity"><strong>{item.senderId}</strong><small>{item.country || "Country not specified"}</small>{!usable && <span>{item.status === "active" ? "Not an active Nigerian sender" : item.status === "pending" ? "Awaiting Termii approval" : item.status === "blocked" ? "Unavailable for sending" : "Approval status is unconfirmed"}</span>}</div><Badge value={item.status === "blocked" ? "failed" : item.status === "unknown" ? "neutral" : item.status}>{label(item.status)}</Badge>{usable ? <Button className="secondary small" busy={busy === `sender-select:${item.senderId}`} disabled={!!busy || !canManageSenderIds || selected} onClick={() => void selectSenderId(item)}>{selected ? <><Check size={14} />Selected</> : "Use ID"}</Button> : <span className="sender-unavailable">Not usable</span>}</li>;
              })}</ul> : <div className="sender-list-empty"><Inbox size={21} /><p>{currentSenderIds.complete ? "No Sender IDs were found in this Termii account. You can request one below." : "No Sender IDs were returned in this partial result. Check the full list in Termii."}</p></div>}
            </>}
          </>}
          {senderRequestHistory.length > 0 && <div className="sender-request-history"><h3>Approval requests</h3><ul>{senderRequestHistory.map(request => {
            const active = currentSenderIds?.senderIds.some(item => usableSenderId(item) && senderKey(item.senderId) === senderKey(request.senderId));
            return <li key={senderKey(request.senderId)}><div><strong>{request.senderId}</strong><small>Requested {date(request.requestedAt)} WAT</small>{request.reason && !active && <p>{request.reason}</p>}{active && <p>Termii now lists this sender as active. Choose Use ID above to save it.</p>}{request.status === "unknown" && !active && <p>Check this request in Termii before submitting it again.</p>}</div><Badge value={active ? "active" : request.status === "rejected" ? "failed" : request.status === "unknown" ? "attention" : "pending"}>{active ? "Now active" : request.status === "pending" ? "Pending approval" : request.status === "unknown" ? "Unconfirmed" : label(request.status)}</Badge></li>;
          })}</ul></div>}
          <div className="sender-request-form"><div className="sender-request-heading"><h3>Request a Sender ID</h3><p>Send your company name and a sample message to Termii for approval. A submitted request remains pending until the provider approves it.</p></div><div className="field-row"><label className="field">Sender ID<input value={senderRequestForm.senderId} onChange={event => setSenderRequestForm(previous => ({ ...previous, senderId: event.target.value }))} maxLength={11} placeholder="Your brand" disabled={!dataAvailable || !!busy} autoComplete="off" /><small>3–11 letters or numbers, including at least one letter. No spaces.</small></label><label className="field">Company name<input value={senderRequestForm.company} onChange={event => setSenderRequestForm(previous => ({ ...previous, company: event.target.value }))} minLength={2} maxLength={200} placeholder="Your company or organisation" disabled={!dataAvailable || !!busy} autoComplete="organization" /><small>Use the company or organisation behind this sender.</small></label></div><label className="field">Sample message / intended use<textarea value={senderRequestForm.useCase} onChange={event => setSenderRequestForm(previous => ({ ...previous, useCase: event.target.value }))} minLength={10} maxLength={2000} rows={4} placeholder="Include a representative message and explain how you will use this Sender ID." disabled={!dataAvailable || !!busy} /><small>10–2,000 characters. {number(senderRequestForm.useCase.length)} entered.</small></label>
            {apiDirty && <div className="sender-form-hint"><AlertCircle size={15} /><span>Save or discard your API edits before choosing a sender or submitting a request. This section uses your saved connection.</span></div>}
            {existingSenderRequest && <div className="sender-form-hint"><Clock3 size={15} /><span>{existingSenderRequest.status === "unknown" ? "This sender already has an unconfirmed request. Check its status in Termii before any new submission." : "This sender already has a request in progress. Refresh the list to check for approval."}</span></div>}
            {!existingSenderRequest && registeredRequestedSender && <div className="sender-form-hint"><CircleHelp size={15} /><span>This Sender ID is already listed for Nigeria. Review its current status above instead of submitting it again.</span></div>}
            {senderRequestNotice && <div className={`sender-request-result ${senderRequestNotice.error ? "is-error" : ""}`} role="status">{senderRequestNotice.error ? <AlertCircle size={16} /> : <Clock3 size={16} />}<span>{senderRequestNotice.text}</span></div>}
            <div className="sender-request-actions"><Button className="primary" busy={busy === "sender-request"} disabled={!!busy || !canManageSenderIds || !senderRequestValid || !!existingSenderRequest || !!registeredRequestedSender} onClick={() => void requestSenderId()}>Submit for approval<ArrowRight size={15} /></Button><a className="text-link" href="https://app.termii.com/" target="_blank" rel="noreferrer">Review in Termii<ArrowUpRight size={14} /></a></div><p className="sender-request-footnote">This submits an approval request only. It does not enable live sending or your transactional route.</p>
          </div>
        </section>
        <section className="panel form-section spacing-top" id="settings-sms"><div className="section-title"><span className="section-icon"><MessageSquare size={20} /></span><div><h2>Termii SMS sender & billing estimate</h2><p>Your brand name and account-specific rate.</p></div></div><div className="field-row"><label className="field">Default sender ID<input value={formSettings.senderId} onChange={(e) => setFormSettings({ ...formSettings, senderId: e.target.value, senderApproved: false, senderApprovalSource: null, senderVerifiedAt: null })} maxLength={11} placeholder="Trezad" /><small>3–11 characters. Use the exact approved name.</small></label><label className="field">Rate per SMS segment (₦)<input type="number" min="0" step="0.01" value={formSettings.ratePerSegment ?? ""} onChange={(e) => setFormSettings({ ...formSettings, ratePerSegment: e.target.value === "" ? null : Number(e.target.value) })} placeholder="Enter your Termii rate" /><small>Optional. Used for estimates, not provider billing.</small></label></div>{formSenderVerified ? <div className="sender-verified-note"><ShieldCheck size={18} /><div><strong>Sender verified from your Termii account</strong><p>{formSettings.senderId} was selected from the active Nigerian Sender IDs above. Changing the name clears this verification.</p></div></div> : <label className="checkbox-label checkbox-card"><input type="checkbox" checked={formSettings.senderApproved} onChange={(e) => setFormSettings({ ...formSettings, senderApproved: e.target.checked, senderApprovalSource: e.target.checked ? "manual" : null, senderVerifiedAt: null })} /><span><strong>I manually confirm that this sender ID is approved</strong><small>Fallback for a sender you have confirmed directly with Termii. This records your confirmation; it does not verify approval from the provider’s account list.</small></span></label>}<label className="checkbox-label checkbox-card"><input type="checkbox" checked={formSettings.transactionalEnabled} onChange={(e) => setFormSettings({ ...formSettings, transactionalEnabled: e.target.checked })} /><span><strong>My transactional route has been activated</strong><small>Optional. Required for service, account and transactional messages.</small></span></label><div className="settings-save"><Button className="primary" onClick={() => void saveSettings()} busy={busy === "settings"} disabled={!!busy || authNeeded}>Save settings<Check size={16} /></Button></div></section>
        <section className="panel live-sending-card"><div className="live-sending-heading"><span className={`live-sending-icon ${state.activeSmsProviderId === "termii" ? "enabled" : ""}`}><Send size={19} /></span><div><h2>Termii SMS activation</h2><p>{state.activeSmsProviderId === "termii" ? "Termii is your active SMS provider." : "Use the Termii Active switch in the provider list when you want SMS campaigns to use this account."}</p></div><Button className="secondary small" onClick={() => jumpToSection("settings-providers")}>Provider list<ArrowRight size={14} /></Button></div><p className="live-sending-note">Only one SMS provider can be active. WhatsApp has its own switch below and always uses the Termii connection.</p></section>
        <section className="panel form-section whatsapp-settings spacing-top" id="settings-whatsapp">
          <div className="section-title"><span className="section-icon whatsapp-section-icon"><MessageCircle size={21} /></span><div><h2>WhatsApp business & template</h2><p>One approved text template, ready for your audience.</p></div><Badge value={state.whatsapp.configured ? "whatsapp" : "setup"}>{state.whatsapp.configured ? "Configured" : "Setup needed"}</Badge></div>
          <p className="settings-description">Use the same Termii connection above. Activate WhatsApp with Termii, obtain approval for a text template, then copy its details here. Your SMS sender ID is separate.</p>
          <div className="field-row"><label className="field">WhatsApp device ID<input value={formWhatsApp.deviceId} onChange={(e) => changeWhatsAppSetting({ deviceId: e.target.value })} maxLength={128} placeholder="Device ID from Termii" disabled={!!busy || authNeeded || loading || !!loadError} autoComplete="off" spellCheck={false} /><small>The exact activated device identifier supplied by Termii.</small></label><label className="field">Business display name<input value={formWhatsApp.businessName} onChange={(e) => changeWhatsAppSetting({ businessName: e.target.value })} maxLength={120} placeholder="Your organisation name" disabled={!!busy || authNeeded || loading || !!loadError} /><small>Identifies your organisation in previews and permission checks.</small></label></div>
          <div className="field-row"><label className="field">Approved template ID<input value={formWhatsApp.templateId} onChange={(e) => changeWhatsAppSetting({ templateId: e.target.value })} maxLength={128} placeholder="Exact approved template ID" disabled={!!busy || authNeeded || loading || !!loadError} autoComplete="off" spellCheck={false} /><small>Use the ID for the approved text-only template.</small></label><label className="field">Template category<select value={formWhatsApp.category} onChange={(e) => changeWhatsAppSetting({ category: e.target.value as "marketing" | "utility" })} disabled={!!busy || authNeeded || loading || !!loadError}><option value="marketing">Marketing · offers & invitations</option><option value="utility">Utility · service & account updates</option></select><small>Match the category approved for this exact template.</small></label></div>
          <label className="field whatsapp-body-field">Copy of the approved template body<textarea rows={5} maxLength={2000} value={formWhatsApp.templateBody} onChange={(e) => changeWhatsAppSetting({ templateBody: e.target.value })} placeholder={"Paste the exact approved text, including variables such as {{1}} or {{invite_link}}."} disabled={!!busy || authNeeded || loading || !!loadError} aria-invalid={!!whatsappFormKeys.error} /><small>This text is a local preview reference. Termii sends its actual approved template by ID; editing this copy does not change that template.</small></label>
          {whatsappFormKeys.error ? <p className="direct-error-message" role="alert">{whatsappFormKeys.error}</p> : <div className="whatsapp-variable-summary"><span>{whatsappFormKeys.keys.length ? "Campaign variables" : "No template variables"}</span><div>{whatsappFormKeys.keys.map((key) => <code key={key}>{`{{${key}}}`}</code>)}</div><small>{number(formWhatsApp.templateBody.length)} / 2,000 characters</small></div>}
          <label className="field whatsapp-rate-field">Rate per WhatsApp message (₦)<input type="number" min="0" step="0.01" value={formWhatsApp.ratePerMessage ?? ""} onChange={(e) => changeWhatsAppSetting({ ratePerMessage: e.target.value === "" ? null : Number(e.target.value) })} placeholder="Enter your account-specific rate" disabled={!!busy || authNeeded || loading || !!loadError} /><small>Optional estimate for this template category. Confirm the current charge with Termii. WhatsApp messages do not use SMS segments.</small></label>
          <div className="whatsapp-owner-confirmations"><div><ShieldCheck size={16} /><strong>Your approval confirmations</strong><span>Owner confirmed</span></div><p>Only check these after Termii completes the relevant activation and approval. The app cannot independently verify them.</p><label className="checkbox-label checkbox-card"><input type="checkbox" checked={formWhatsApp.accountApproved} onChange={(e) => changeWhatsAppSetting({ accountApproved: e.target.checked })} disabled={!!busy || authNeeded || loading || !!loadError} /><span><strong>Termii has activated this WhatsApp business account and device</strong><small>I have confirmed this exact device can send WhatsApp template messages.</small></span></label><label className="checkbox-label checkbox-card"><input type="checkbox" checked={formWhatsApp.templateApproved} onChange={(e) => changeWhatsAppSetting({ templateApproved: e.target.checked })} disabled={!!busy || authNeeded || loading || !!loadError} /><span><strong>This exact text template is approved for this device</strong><small>I have checked its ID, body, variables and category against the provider’s approved template.</small></span></label></div>
          {whatsappSettingsDirty && <p className="whatsapp-unsaved-note"><span className="status-dot amber" />Unsaved WhatsApp changes. Editing the business, device or template resets these confirmations and switches live sending off when saved.</p>}
          <div className="settings-save whatsapp-save"><Button className="primary" busy={busy === "whatsapp-settings"} disabled={!!busy || authNeeded || loading || !!loadError || !!whatsappFormKeys.error} onClick={() => void saveWhatsAppSettings()}>Save WhatsApp settings<Check size={16} /></Button>{whatsappSettingsDirty && <button className="text-link" disabled={!!busy} onClick={() => setFormWhatsApp(state.whatsapp)}>Discard changes</button>}</div>
        </section>
        <section className="panel live-sending-card whatsapp-live-card"><div className="live-sending-heading"><span className={`live-sending-icon ${whatsappLiveActive ? "enabled" : ""}`}><MessageCircle size={20} /></span><div><h2>WhatsApp live sending</h2><p>{whatsappLiveActive ? "Approved template submissions are enabled for reviewed campaigns." : "Enable this channel separately when your approved template is ready."}</p></div><button type="button" className={`live-switch ${whatsappLiveActive ? "is-on" : ""}`} role="switch" aria-checked={whatsappLiveActive} aria-label="Enable live WhatsApp sending" disabled={!!busy || !providerActionsAvailable || !!loadError || apiDirty || whatsappSettingsDirty || (!whatsappLiveActive && !canEnableWhatsApp)} onClick={() => void toggleWhatsAppLive()}><span>{busy === "whatsapp-live" && <LoaderCircle size={12} className="spin" />}</span></button></div><div className="live-requirements"><span className={state.provider.verifiedAt ? "complete" : ""}>{state.provider.verifiedAt ? <Check size={13} /> : <span className="requirement-dot" />}API connection verified</span><span className={state.whatsapp.accountApproved ? "complete" : ""}>{state.whatsapp.accountApproved ? <Check size={13} /> : <span className="requirement-dot" />}Device owner-confirmed</span><span className={state.whatsapp.templateApproved ? "complete" : ""}>{state.whatsapp.templateApproved ? <Check size={13} /> : <span className="requirement-dot" />}Template owner-confirmed</span></div><p className="live-sending-note">{apiDirty || whatsappSettingsDirty ? "Save or discard your API and WhatsApp changes before changing WhatsApp live sending." : whatsappLiveActive ? "Each campaign requires recipient permission and final confirmation. SMS is never used as an automatic fallback." : canEnableWhatsApp ? "You’re ready to enable WhatsApp. Each campaign will still require your review and confirmation." : "Verify the shared API connection and save your WhatsApp device, approved template and owner confirmations above."}</p>{state.whatsapp.configured && state.whatsapp.providerRevision !== state.provider.credentialRevision && <p className="whatsapp-revision-note"><RefreshCw size={13} />The API key or base URL changed. Verify the current connection and re-enable WhatsApp before sending.</p>}</section>
        </div><aside><section className="panel setup-guide"><div className="setup-guide-icon"><Zap size={22} /></div><h2>From setup to your first message</h2><p>Connect once, then configure each delivery channel.</p><ol><li><span>1</span><div><strong>Create & fund your account</strong><p>Complete Termii’s onboarding and fund the services you plan to use.</p><a href="https://termii.com/" target="_blank" rel="noreferrer">Visit Termii <ArrowUpRight size={13} /></a></div></li><li><span>2</span><div><strong>Connect your credentials</strong><p>Paste the base URL and API key from your Termii dashboard into this page, then choose Save & test connection.</p></div></li><li><span>3</span><div><strong>Prepare your channel</strong><p>Save an approved SMS sender or your activated WhatsApp device and approved text template. Enable that channel, then review your campaign.</p></div></li></ol><details><summary>How your API key is handled <ChevronDown size={14} /></summary><div className="config-help"><p>Your key is encrypted on the server. This page never retrieves or displays a saved key.</p><p>Leaving the key field blank keeps the saved key. Replacing the API key or changing the base URL requires a new connection test and a separate action to enable each delivery channel.</p><p>Removing credentials disconnects the provider and turns off SMS and WhatsApp delivery.</p></div></details></section><section className="panel route-note whatsapp-guide spacing-top"><h3><MessageCircle size={18} />Inviting your community</h3><p>Use an approved marketing text template with a group invite link. Recipients join by choice; this app cannot add people to a group.</p><p>Start with 1–30 opted-in test recipients. Before sending to 3,000 or more, confirm your account’s current WhatsApp messaging limit and balance with Termii. Limits depend on your account.</p><p>Up to 5,000 recipients per campaign in this workspace. Keep this tab open while submissions run; you can pause after the current batch.</p><a href="https://developers.termii.com/" target="_blank" rel="noreferrer" className="text-link">WhatsApp API documentation <ArrowUpRight size={13} /></a></section><section className="panel route-note spacing-top"><h3><Clock3 size={17} />SMS sending in Nigeria</h3><p>Promotional messages are subject to DND restrictions. Termii documents an MTN delivery restriction between 8 p.m. and 8 a.m. WAT.</p><a href="https://developers.termii.com/messaging-api/" target="_blank" rel="noreferrer" className="text-link">Read route guidance <ArrowUpRight size={13} /></a></section></aside></div></details><section className="panel provider-research"><div><p className="eyebrow">ACCOUNT SETUP</p><h2>Choose the provider that fits your account</h2><p>Fund each service directly and use its own approved sender. Connection tests only read account balance; they never submit a message. Provider prices, sender approval and delivery coverage depend on your account.</p></div><div className="research-grid"><div><strong>SMS provider selection</strong><p>Only the selected provider handles new SMS campaigns. Saved campaigns keep the provider and credential version used when they were created.</p></div><div><strong>WhatsApp remains separate</strong><p>Your existing Termii WhatsApp device and approved template remain available when you activate another SMS provider.</p></div><div><strong>Check with a small test</strong><p>Use “Type or paste numbers” to send a reviewed test to your own number before preparing the full community campaign.</p><button className="text-link" onClick={() => launchComposer("sms", true)}>Prepare a test<ArrowRight size={14} /></button></div></div></section></>}
      </>}
      <footer><span className="footer-brand"><MessageSquare size={13} />Trezad</span><span>SMS, WhatsApp & email marketing</span><span className="footer-private"><LockKeyhole size={11} />Private workspace</span></footer>
    </main></div>
    {toast && <div className={`toast ${toast.error ? "toast-error" : ""}`} role={toast.error ? "alert" : "status"}>{toast.error ? <AlertCircle size={19} /> : <CircleCheck size={19} />}<span>{toast.text}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={17} /></button></div>}
    {importOpen && <Modal title="Add contacts" subtitle="Add contacts who have agreed to receive your messages." onClose={closeImport} wide locked={busy === "import"}><div className="modal-body"><div className="segmented import-tabs">{[{ id: "manual", text: "Add a contact", icon: Plus }, { id: "csv", text: "Import CSV", icon: Upload }, { id: "paste", text: "Paste numbers", icon: FileText }].map(({ id, text, icon: Icon }) => <button key={id} className={importTab === id ? "selected" : ""} onClick={() => { setImportTab(id); setImportResults(null); }}><Icon size={15} />{text}</button>)}</div><PhoneFormatHelp compact />{importTab === "manual" ? <div className="field-row"><label className="field">Contact name<input value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="e.g. Ada Okafor" maxLength={120} /></label><label className="field">Nigerian mobile number<input value={importPhone} onChange={(e) => setImportPhone(e.target.value)} type="tel" placeholder="+2347061234567" /><small>Use a complete Nigerian mobile number. +234 is recommended.</small></label></div> : importTab === "csv" ? <><input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void filePicked(e.target.files?.[0])} /><button className="upload-zone" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void filePicked(e.dataTransfer.files?.[0]); }}><span><Upload size={25} /></span><strong>{importFileName || "Choose a CSV or drop it here"}</strong><small>Up to 5,000 contacts · 2 MB maximum</small></button><div className="csv-help"><p>Columns: <code>name, phone, group, consent</code><br /><span>Only phone is required. Use true or false for consent.</span></p><button className="text-link" onClick={() => downloadCsv("trezad-contact-template.csv", [["name", "phone", "group", "consent"], ["Example contact", "08012345678", "Customers", "true"]])}>Get template <ArrowDownToLine size={14} /></button></div>{importText && <div className="import-preview"><strong>File loaded</strong><p>{(() => { try { return `${number(parseImport(importText, false, importGroup).length)} rows ready for validation. Duplicates and invalid numbers will be skipped.`; } catch { return "Please check the CSV formatting."; } })()}</p></div>}</> : <label className="field">Phone numbers<textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={"08012345678\n+234 803 456 7890\n07012345678"} /><small>One number per line. Nigerian local and international formats are accepted.</small></label>}<label className="field">{importTab === "manual" ? "Group" : "Default group"}<input value={importGroup} onChange={(e) => setImportGroup(e.target.value)} placeholder="e.g. Customers, Vendors, Members" maxLength={80} list="contact-groups" /><datalist id="contact-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>{importTab !== "manual" && <small>Used when a contact has no group in the file.</small>}</label><label className="checkbox-label checkbox-card"><input type="checkbox" checked={importConsent} onChange={(e) => setImportConsent(e.target.checked)} /><span><strong>These contacts have opted in to my messages</strong><small>I have permission to contact them and will honour opt-out requests.</small></span></label>{importResults && <div className="import-result" role="status"><div><span><strong>{importResults.inserted}</strong> added</span><span><strong>{importResults.duplicates}</strong> duplicates skipped</span><span><strong>{importResults.invalid}</strong> invalid</span></div>{importResults.errors?.length > 0 && <details><summary>Review import issues</summary><ul>{importResults.errors.slice(0, 20).map((err, i) => <li key={i}>{err}</li>)}</ul></details>}</div>}</div><div className="modal-footer"><Button className="secondary" onClick={closeImport} disabled={busy === "import"}>{importResults ? "Done" : "Cancel"}</Button><Button className="primary" busy={busy === "import"} disabled={!importConsent || authNeeded || !!busy} onClick={() => void handleImport()}><Plus size={16} />{importTab === "manual" ? "Add contact" : "Import contacts"}</Button></div></Modal>}
    {removeCredentialsOpen && <Modal title="Remove your Termii connection?" subtitle="Your saved API credentials will be removed and live sending will be disabled." onClose={closeRemoveCredentials} locked={busy === "provider-remove"}><div className="modal-body"><div className="remove-provider-summary"><span><LockKeyhole size={22} /></span><div><strong>Disconnect Termii</strong><p>You can reconnect at any time by saving and testing your API details again.</p></div></div><p className="field-hint">Your contacts, drafts and campaign history will stay in this workspace. Messages already submitted to Termii cannot be recalled.</p></div><div className="modal-footer"><Button className="secondary" disabled={!!busy} onClick={closeRemoveCredentials}>Keep connection</Button><Button className="danger" busy={busy === "provider-remove"} disabled={!!busy} onClick={() => void removeCredentials()}><Trash2 size={15} />Remove credentials</Button></div></Modal>}
    {deleteOpen && <Modal title="Delete selected contacts?" subtitle={`${number(selectedContacts.length)} contacts will be removed from your address book.`} onClose={() => setDeleteOpen(false)} locked={busy === "delete"}><div className="modal-body"><p className="muted">Campaign records are retained. To stop messages while preserving a contact, use Suppress instead.</p></div><div className="modal-footer"><Button className="secondary" onClick={() => setDeleteOpen(false)} disabled={!!busy}>Cancel</Button><Button className="danger" busy={busy === "delete"} onClick={() => void deleteContacts()}><Trash2 size={16} />Delete contacts</Button></div></Modal>}
    {detail && !confirmCampaign && <Modal title={detail.campaign.name} subtitle={`${campaignProviderName(detail.campaign)} · ${detail.campaign.senderId} · ${date(detail.campaign.createdAt)} WAT`} onClose={closeDetail} wide locked={!!busy}><div className="modal-body"><div className="detail-status-row"><Badge value={detail.campaign.mode === "preview" ? "preview" : detail.campaign.status} /><span>{detail.campaign.channel === "whatsapp" ? `${label(detail.campaign.whatsapp?.category || "marketing")} template` : `${detail.campaign.channel === "dnd" ? "Transactional" : "Promotional"} · ${detail.campaign.encoding}`}</span><Badge value={detail.campaign.channel === "whatsapp" ? "whatsapp" : "neutral"}>{detail.campaign.channel === "whatsapp" ? "WhatsApp" : "SMS"}</Badge><Badge value="neutral">{detail.campaign.audienceSource === "direct" ? "Typed numbers" : "Saved contacts"}</Badge><button className="text-link" onClick={() => duplicate(detail.campaign)}><Copy size={14} />Duplicate</button></div>{detail.campaign.mode === "preview" && <div className="notice notice-soft"><Eye size={17} /><span>Preview only. Recipients and message were validated; no message was sent.</span></div>}{detail.campaign.channel === "whatsapp" && detail.campaign.whatsapp && <div className="whatsapp-campaign-reference"><div><span>Device ID</span><code>{detail.campaign.whatsapp.deviceId}</code></div><div><span>Template ID</span><code>{detail.campaign.whatsapp.templateId}</code></div><p>Message below is a resolved reference from your copied template. Termii sends the actual approved template identified by this ID.</p></div>}<div className="detail-message">{detail.campaign.message}</div><div className="detail-stats"><div><strong>{number(detail.campaign.recipientCount)}</strong><span>Recipients</span></div><div><strong>{number(detail.campaign.summary.accepted)}</strong><span>Accepted</span></div><div><strong>{number(detail.campaign.summary.delivered)}</strong><span>Delivered</span></div><div><strong>{number(detail.campaign.summary.failed)}</strong><span>Failed</span></div><div><strong>{number(detail.campaign.summary.unknown)}</strong><span>Unknown</span></div></div>{["attention", "preparing"].includes(detail.campaign.status) && <div className="notice notice-warning"><AlertCircle size={17} /><span>This campaign needs a review in your {campaignProviderName(detail.campaign)} account. Sending is paused; resolve the provider outcome before creating another submission.</span><a className="text-link" href={campaignProviderDefinition(detail.campaign).website} target="_blank" rel="noreferrer">Review provider <ArrowUpRight size={13} /></a></div>}{detail.campaign.summary.unknown > 0 && <div className="notice notice-warning"><AlertCircle size={17} /><span>An outcome is uncertain. Check your provider account before any new submission. This app will not automatically resend uncertain messages.</span></div>}<div className="detail-report-heading"><h3>Recipient report</h3><div><Button className="secondary small" onClick={() => downloadCsv(`trezad-campaign-${detail.campaign.id}.csv`, [["name", "phone", "provider", "channel", "status", "provider_id", "reason", "updated_at"], ...detail.recipients.map((r) => [r.name, r.phone, campaignProviderName(detail.campaign), detail.campaign.channel === "whatsapp" ? "whatsapp" : "sms", r.status, r.providerId || "", r.reason || "", r.updatedAt])])}><ArrowDownToLine size={14} />Export</Button>{detail.campaign.mode === "live" && campaignProviderDefinition(detail.campaign).reports === "polling" && <Button className="secondary small" busy={busy === "refresh"} disabled={!!busy} onClick={() => void refreshReports()}><RefreshCw size={14} />Refresh status</Button>}</div></div><div className="table-scroll recipient-report"><table><thead><tr><th>Recipient</th><th>Status</th><th>Details</th></tr></thead><tbody>{detail.recipients.map((r) => <tr key={r.id}><td><strong>{r.name || (detail.campaign.audienceSource === "direct" ? "Typed number" : "Contact")}</strong><small className="cell-sub">{r.phone}</small></td><td><Badge value={r.status} /></td><td><span className="report-reason">{r.reason || (r.providerId ? `Provider ID: ${r.providerId}` : "—")}</span></td></tr>)}</tbody></table></div>{detail.batches.some((b) => b.error) && <details className="batch-errors"><summary>Submission notes</summary>{detail.batches.filter((b) => b.error).map((b) => <p key={b.id}>{b.error}</p>)}</details>}<p className="field-hint">Accepted means the provider received the message. Delivery requires a recipient-specific report. All times are shown in WAT.</p>{detail.campaign.mode === "live" && campaignProviderDefinition(detail.campaign).reports === "dashboard" && <div className="notice notice-soft"><CircleHelp size={16} /><span>{campaignProviderName(detail.campaign)} final delivery reports are available in its dashboard. Accepted messages here are not a delivery confirmation.</span><a className="text-link" href={campaignProviderDefinition(detail.campaign).website} target="_blank" rel="noreferrer">Open provider<ArrowUpRight size={13} /></a></div>}{detail.campaign.summary.pending > 0 && detail.campaign.mode !== "preview" && !canSendCampaign(detail.campaign) && <div className="send-lock"><LockKeyhole size={15} /><span>{campaignBlocker(detail.campaign)}</span></div>}</div><div className="modal-footer"><Button className="secondary" onClick={closeDetail} disabled={!!busy}>Close</Button><div>{detail.campaign.summary.pending > 0 && detail.campaign.mode !== "preview" && <Button className="danger-ghost" busy={busy === "cancel"} disabled={!!busy} onClick={() => void cancelCampaign()}>Cancel pending</Button>}{detail.campaign.summary.pending > 0 && detail.campaign.mode !== "preview" && <Button className="primary" disabled={!!busy || !canSendCampaign(detail.campaign)} onClick={() => void reviewCampaign(detail.campaign)}><Send size={15} />{detail.campaign.mode === "draft" ? "Review & send" : "Review & resume"}</Button>}</div></div></Modal>}
    {confirmCampaign && <Modal title="Review campaign" subtitle={`This action sends real ${confirmCampaign.channel === "whatsapp" ? "WhatsApp" : "SMS"} messages and uses your ${campaignProviderName(confirmCampaign)} account.`} onClose={closeConfirm} locked={busy === "send"}><div className="modal-body"><div className={`confirm-icon ${confirmCampaign.channel === "whatsapp" ? "whatsapp-confirm-icon" : ""}`}>{confirmCampaign.channel === "whatsapp" ? <MessageCircle size={25} /> : <Send size={25} />}</div><h3 className="confirm-name">{confirmCampaign.name}</h3>
      <div className="confirm-summary"><div><span>Provider account</span><strong>{campaignProviderName(confirmCampaign)}</strong></div><div><span>Delivery channel</span><Badge value={confirmCampaign.channel === "whatsapp" ? "whatsapp" : "neutral"}>{confirmCampaign.channel === "whatsapp" ? "WhatsApp" : "SMS"}</Badge></div><div><span>Audience source</span><strong>{confirmCampaign.audienceSource === "direct" ? "Typed or pasted numbers" : "Saved contacts"}</strong></div><div><span>To</span><strong>{number(confirmCampaign.summary.pending)} pending recipients</strong></div><div><span>{confirmCampaign.channel === "whatsapp" ? "Business" : "From"}</span><strong>{confirmCampaign.senderId}</strong></div><div><span>{confirmCampaign.channel === "whatsapp" ? "Template category" : "Route"}</span><strong>{confirmCampaign.channel === "whatsapp" ? label(confirmCampaign.whatsapp?.category || "marketing") : confirmCampaign.channel === "dnd" ? "Transactional" : "Promotional"}</strong></div><div><span>{confirmCampaign.channel === "whatsapp" ? "Messages per recipient" : "Segments per recipient"}</span><strong>{confirmCampaign.channel === "whatsapp" ? 1 : confirmCampaign.segments}</strong></div><div><span>Campaign cost estimate</span><strong>{money(confirmCampaign.estimatedCost)}</strong></div></div>
      {confirmCampaign.channel === "whatsapp" && confirmCampaign.whatsapp && <div className="whatsapp-campaign-reference"><div><span>Device ID</span><code>{confirmCampaign.whatsapp.deviceId}</code></div><div><span>Template ID</span><code>{confirmCampaign.whatsapp.templateId}</code></div><p>The message preview is based on your copied text and campaign variables. Termii’s actual approved template is authoritative. Verify that the ID, content and variables match before confirming.</p></div>}
      {(confirmCampaign.audienceSource === "direct" || confirmCampaign.channel === "whatsapp") && <div className="confirm-direct-audience"><div><Smartphone size={16} /><strong>Reviewed recipient numbers</strong><Badge value="neutral">{number(confirmRecipients.length)}</Badge></div><p>{confirmCampaign.audienceSource === "direct" ? "These are the actual saved campaign recipients. They have not been added to Contacts." : "These numbers come from this campaign’s saved recipient snapshot."}</p><div className="direct-phone-chips">{confirmRecipients.slice(0, 10).map((recipient) => <code key={recipient.id}>{recipient.phone}</code>)}{confirmRecipients.length > 10 && <span>+{number(confirmRecipients.length - 10)} more</span>}</div>{confirmRecipients.length === 0 && <p className="direct-error-message">No pending recipients are available. Close this review and refresh the campaign.</p>}</div>}
      <div className="detail-message">{confirmCampaign.message}</div><label className="checkbox-label checkbox-card"><input type="checkbox" checked={sendPermission} disabled={busy === "send"} onChange={(e) => setSendPermission(e.target.checked)} /><span><strong>I’m ready to send this {confirmCampaign.channel === "whatsapp" ? "WhatsApp template" : "message"}</strong><small>{confirmCampaign.channel === "whatsapp" ? `I have checked the recipients, their WhatsApp permission for ${confirmCampaign.senderId}, the approved template and its variables, and authorise the provider charges.` : "I have checked the recipients, message and sender, and authorise the provider charges."}</small></span></label>
      <div className="inline-note"><CircleHelp size={15} /><span>Keep this tab open while batches are submitted. You can pause after the current batch. Submitted messages cannot be recalled; delivery is confirmed separately by the provider.{confirmCampaign.channel === "whatsapp" ? " WhatsApp uses batches of up to 5 recipients and never falls back to SMS." : ""}</span></div>{dispatchProgress && <div className="dispatch-progress" role="status"><LoaderCircle size={17} className="spin" /><span>{dispatchProgress}{pauseRequested && <small>Pausing after the current batch finishes…</small>}</span></div>}</div><div className="modal-footer">{busy === "send" ? <Button className="secondary" disabled={pauseRequested} onClick={requestPause}><Pause size={15} />{pauseRequested ? "Pause requested" : "Pause after this batch"}</Button> : <Button className="secondary" onClick={closeConfirm}>Back</Button>}<Button className="primary" disabled={!sendPermission || !!busy || !canSendCampaign(confirmCampaign) || ((confirmCampaign.audienceSource === "direct" || confirmCampaign.channel === "whatsapp") && confirmRecipients.length === 0)} busy={busy === "send"} onClick={() => void dispatch()}><Send size={16} />{busy === "send" ? "Sending…" : "Confirm & send"}</Button></div></Modal>}

  </div>;
}
