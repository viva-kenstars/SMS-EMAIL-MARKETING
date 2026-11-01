"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, ArrowUpRight, Check, Eye, EyeOff, LoaderCircle, LockKeyhole, MessageSquare, RefreshCw, Settings2, ShieldCheck, Trash2, Wallet, X } from "lucide-react";
import { validSmsSender, type SmsProviderBalance, type SmsProviderId, type SmsProviderState } from "../lib/sms-provider-catalog";

const REFRESH_MS = 5 * 60 * 1000;
const RECENT_BALANCE_MS = 30 * 1000;
type AccountError = Error & { status?: number; code?: string };
export type SmsBalanceEntry = { key: string; snapshot: SmsProviderBalance | null; loading: boolean; error: string };
export type SmsBalanceMap = Partial<Record<SmsProviderId, SmsBalanceEntry>>;
export type SmsProviderDirectoryState = { smsProviders: SmsProviderState[]; activeSmsProviderId: SmsProviderId | null; smsRoutingRevision: number };
type ConnectionCheck = SmsProviderBalance & { provider: SmsProviderState };
const connectionKey = (provider: SmsProviderState) => provider.configured ? `${provider.id}:${provider.credentialRevision}` : "";
const date = (value: number) => new Date(value).toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export function walletAmount(balance: SmsProviderBalance) {
  if (balance.unit === "credits") return `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 4 }).format(balance.balance)} credits`;
  try { return new Intl.NumberFormat("en-NG", { style: "currency", currency: balance.currency, maximumFractionDigits: 2 }).format(balance.balance); }
  catch { return `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 }).format(balance.balance)} ${balance.currency}`; }
}
async function accountApi<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { method: method || (body === undefined ? "GET" : "POST"), headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  let result: any;
  try { result = await response.json(); } catch { throw new Error("The server returned an unreadable response. Reload this page before trying again."); }
  if (!response.ok) { const error = new Error(typeof result.error === "string" ? result.error : "The provider settings could not be updated.") as AccountError; error.status = response.status; error.code = result.code; throw error; }
  return result as T;
}

export function useSmsProviderBalances(providers: SmsProviderState[], available: boolean, onConflict: () => Promise<unknown>) {
  const [balances, setBalances] = useState<SmsBalanceMap>({});
  const latest = useRef({ providers, available, onConflict });
  latest.current = { providers, available, onConflict };
  const requests = useRef(new Map<SmsProviderId, { key: string; token: number; task: Promise<void> }>());
  const snapshots = useRef(new Map<SmsProviderId, SmsProviderBalance>());
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; requests.current.clear(); }; }, []);
  const accept = useCallback((snapshot: SmsProviderBalance, verifiedProvider?: SmsProviderState) => {
    const saved = latest.current.providers.find(provider => provider.id === snapshot.providerId);
    const expected = verifiedProvider || saved;
    const cached = snapshots.current.get(snapshot.providerId);
    if (!alive.current || !latest.current.available || !expected?.configured || expected.id !== snapshot.providerId || expected.credentialRevision !== snapshot.credentialRevision || (saved && saved.credentialRevision > snapshot.credentialRevision) || (cached && cached.credentialRevision > snapshot.credentialRevision)) return;
    const key = connectionKey(expected);
    // A connection check already returned the balance. Ignore any earlier read
    // still in flight, including responses for the same credential generation.
    requests.current.delete(snapshot.providerId);
    if (!cached || cached.credentialRevision !== snapshot.credentialRevision || cached.fetchedAt <= snapshot.fetchedAt) snapshots.current.set(snapshot.providerId, snapshot);
    setBalances(previous => {
      const prior = previous[snapshot.providerId];
      const newest = prior?.key === key && prior.snapshot && prior.snapshot.fetchedAt > snapshot.fetchedAt ? prior.snapshot : snapshot;
      return { ...previous, [snapshot.providerId]: { key, snapshot: newest, loading: false, error: "" } };
    });
  }, []);
  const refresh = useCallback((providerId: SmsProviderId, force = false): Promise<void> => {
    const provider = latest.current.providers.find(item => item.id === providerId);
    if (!latest.current.available || !provider?.configured) return Promise.resolve();
    const key = connectionKey(provider), existing = requests.current.get(providerId);
    // Manual refreshes join the current request instead of duplicating it.
    if (existing?.key === key) return existing.task;
    const cached = snapshots.current.get(providerId);
    if (!force && cached?.credentialRevision === provider.credentialRevision && Date.now() - cached.fetchedAt < RECENT_BALANCE_MS) return Promise.resolve();
    const token = ++sequence.current;
    const current = () => { const saved = latest.current.providers.find(item => item.id === providerId); return alive.current && latest.current.available && !!saved && connectionKey(saved) === key && requests.current.get(providerId)?.token === token; };
    setBalances(previous => ({ ...previous, [providerId]: { key, snapshot: previous[providerId]?.key === key ? previous[providerId]?.snapshot || null : null, loading: true, error: "" } }));
    const task = (async () => {
      try {
        const snapshot = await accountApi<SmsProviderBalance>(`/api/sms/providers/${providerId}/balance`);
        if (!current()) return;
        if (snapshot.providerId !== providerId || snapshot.credentialRevision !== provider.credentialRevision) {
          snapshots.current.delete(providerId);
          setBalances(previous => ({ ...previous, [providerId]: { key, snapshot: null, loading: false, error: "The saved connection changed. Reloading provider settings…" } }));
          await latest.current.onConflict(); return;
        }
        const cached = snapshots.current.get(providerId);
        if (!cached || cached.credentialRevision !== snapshot.credentialRevision || cached.fetchedAt <= snapshot.fetchedAt) snapshots.current.set(providerId, snapshot);
        setBalances(previous => {
          const prior = previous[providerId];
          const newest = prior?.key === key && prior.snapshot && prior.snapshot.fetchedAt > snapshot.fetchedAt ? prior.snapshot : snapshot;
          return { ...previous, [providerId]: { key, snapshot: newest, loading: false, error: "" } };
        });
      } catch (error) {
        if (!current()) return;
        const changed = (error as AccountError).status === 409;
        if (changed) snapshots.current.delete(providerId);
        setBalances(previous => ({ ...previous, [providerId]: { key, snapshot: changed ? null : previous[providerId]?.key === key ? previous[providerId]?.snapshot || null : null, loading: false, error: (error as Error).message } }));
        if (changed) await latest.current.onConflict().catch(() => undefined);
      } finally {
        if (requests.current.get(providerId)?.token === token) requests.current.delete(providerId);
      }
    })();
    requests.current.set(providerId, { key, token, task });
    return task;
  }, []);
  const refreshAll = useCallback(async (force = false) => {
    const connected = latest.current.providers.filter(provider => provider.configured);
    // Small waves prevent a page with several accounts from creating a request burst.
    for (let index = 0; index < connected.length; index += 3) await Promise.allSettled(connected.slice(index, index + 3).map(provider => refresh(provider.id, force)));
  }, [refresh]);
  const signature = providers.map(provider => connectionKey(provider)).join("|");
  useEffect(() => {
    for (const [id, snapshot] of snapshots.current) if (!providers.some(provider => provider.id === id && provider.configured && provider.credentialRevision === snapshot.credentialRevision)) snapshots.current.delete(id);
    setBalances(previous => Object.fromEntries(Object.entries(previous).filter(([id, entry]) => providers.some(provider => provider.id === id && connectionKey(provider) === entry?.key))) as SmsBalanceMap);
    if (!available) return;
    const visible = () => { if (document.visibilityState === "visible") void refreshAll(); };
    visible(); const timer = window.setInterval(visible, REFRESH_MS);
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [signature, available, refreshAll]);
  return { balances, refresh, refreshAll, accept };
}

function Balance({ provider, entry, onRefresh, available, compact = false }: { provider: SmsProviderState; entry?: SmsBalanceEntry; onRefresh: () => void; available: boolean; compact?: boolean }) {
  const current = entry?.key === connectionKey(provider) ? entry : undefined;
  const snapshot = available ? current?.snapshot : null;
  const stale = !!snapshot && (!!current?.error || Date.now() - snapshot.fetchedAt >= REFRESH_MS);
  return <div className={`sms-wallet ${compact ? "sms-wallet-compact" : ""}`} aria-busy={current?.loading || false}>
    <div className="sms-wallet-top"><span><Wallet size={14} />Account balance</span>{snapshot && <span className={stale ? "sms-wallet-stale" : ""}>{stale ? "Last known" : snapshot.unit === "credits" ? "Provider credits" : snapshot.currency}</span>}<button type="button" className="icon-button" aria-label={`Refresh ${provider.name} balance`} disabled={!available || !provider.configured || current?.loading} onClick={onRefresh}>{current?.loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
    <strong>{snapshot ? walletAmount(snapshot) : "—"}</strong>
    <small>{!available ? "Connect your workspace to view balances." : !provider.configured ? "Add credentials to load this balance." : snapshot ? `${stale ? "Last fetched" : "Fetched"} ${date(snapshot.fetchedAt)} WAT` : current?.loading ? "Fetching balance…" : current?.error ? "Balance unavailable" : "Balance not loaded"}</small>
    {available && current?.error && <p className="sms-wallet-error" role="status"><AlertCircle size={13} /><span>{current.error}{snapshot ? " The amount shown is the last successful result." : ""}</span></p>}
  </div>;
}

export function SmsProviderBalances({ providers, activeId, balances, available, onRefresh, onRefreshAll, onManage }: { providers: SmsProviderState[]; activeId: SmsProviderId | null; balances: SmsBalanceMap; available: boolean; onRefresh: (id: SmsProviderId) => void; onRefreshAll: () => void; onManage: () => void }) {
  const connected = providers.filter(provider => provider.configured).sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  const active = providers.find(provider => provider.id === activeId);
  return <section className="panel sms-wallet-overview" aria-label="Provider balances">
    <div className="panel-heading"><div><h2>Provider balances</h2><p>{active ? <>New SMS campaigns use <strong>{active.name}</strong>. WhatsApp uses Termii.</> : "SMS sending is paused. Choose an active provider in settings."}</p></div><div className="sms-wallet-overview-actions"><button className="button secondary small" type="button" disabled={!available || !connected.length} onClick={onRefreshAll}><RefreshCw size={14} />Refresh all</button><button type="button" className="text-link" onClick={onManage}>Manage providers<ArrowRight size={14} /></button></div></div>
    {connected.length ? <div className="sms-wallet-grid">{connected.map(provider => <div className={`sms-wallet-tile ${provider.id === activeId ? "is-active" : ""}`} key={provider.id}><div className="sms-wallet-provider"><strong>{provider.name}</strong><span className={`badge ${provider.id === activeId ? "badge-active" : "badge-neutral"}`}>{provider.id === activeId ? "Active SMS" : "Saved account"}</span></div><Balance provider={provider} entry={balances[provider.id]} available={available} onRefresh={() => onRefresh(provider.id)} compact /></div>)}</div> : <div className="sms-wallet-empty"><span className="section-icon"><Wallet size={23} /></span><div><strong>Your provider accounts, in one place</strong><p>Save an account to see its balance here. Each account keeps its own credentials and balance.</p></div><button type="button" className="button secondary small" onClick={onManage}>Add a provider<ArrowRight size={14} /></button></div>}
    <p className="sms-wallet-footnote">Balances refresh every 5 minutes while this tab is visible. Amounts retain each provider’s currency or credit unit.</p>
  </section>;
}

type DirectoryProps = { providers: SmsProviderState[]; activeId: SmsProviderId | null; routingRevision: number; termiiSource?: "app" | "environment" | "none"; balances: SmsBalanceMap; available: boolean; busy: string; setBusy: (value: string) => void; onReload: () => Promise<SmsProviderDirectoryState>; onRefresh: (id: SmsProviderId, force?: boolean) => Promise<void>; onBalance: (balance: SmsProviderBalance, provider?: SmsProviderState) => void; onNotify: (message: string, error?: boolean) => void; onTermiiConfigure: (section?: string) => void };
type FormState = { credentials: Record<string, string>; senderId: string; senderApproved: boolean; ratePerSegment: string; transactionalEnabled: boolean };
const makeForm = (provider: SmsProviderState): FormState => ({ credentials: Object.fromEntries(provider.fields.map(field => [field.key, field.secret ? "" : provider.publicValues[field.key] || ""])), senderId: provider.senderId || "", senderApproved: provider.senderApproved, ratePerSegment: provider.ratePerSegment == null ? "" : String(provider.ratePerSegment), transactionalEnabled: provider.transactionalEnabled });

export function SmsProviderDirectory({ providers, activeId, routingRevision, termiiSource, balances, available, busy, setBusy, onReload, onRefresh, onBalance, onNotify, onTermiiConfigure }: DirectoryProps) {
  const [editing, setEditing] = useState<SmsProviderId | null>(null), [form, setForm] = useState<FormState | null>(null), [showSecrets, setShowSecrets] = useState(false), [removeId, setRemoveId] = useState<SmsProviderId | null>(null), [error, setError] = useState("");
  const [errorProvider, setErrorProvider] = useState<SmsProviderId | null>(null);
  const editRevision = useRef(0);
  const edit = (provider: SmsProviderState) => {
    if (provider.id === "termii") { onTermiiConfigure(); return; }
    if (editing === provider.id) { setEditing(null); setForm(null); return; }
    setEditing(provider.id); setForm(makeForm(provider)); setShowSecrets(false); setRemoveId(null); setError(""); editRevision.current = provider.revision;
  };
  const fail = async (caught: unknown, providerId: SmsProviderId, reloaded = false) => {
    const message = (caught as Error).message; setError(message); setErrorProvider(providerId); onNotify(message, true);
    if ((caught as AccountError).status === 409) { if (!reloaded) await onReload().catch(() => undefined); setEditing(null); setForm(null); }
  };
  const toggle = async (provider: SmsProviderState, verify = false) => {
    setBusy(`sms-active:${provider.id}`); setError("");
    try {
      const off = activeId === provider.id;
      let currentProvider = provider, currentRoutingRevision = routingRevision;
      if (verify && !off) {
        const checked = await accountApi<ConnectionCheck>(`/api/sms/providers/${provider.id}/check`, { credentialRevision: provider.credentialRevision });
        const directory = await onReload();
        const current = directory.smsProviders.find(item => item.id === provider.id);
        onBalance(checked, checked.provider);
        const migratedEnvironment = provider.id === "termii" && termiiSource === "environment" && provider.revision === 0 && provider.credentialRevision === 0 && checked.credentialRevision === 1 && current?.credentialRevision === 1 && checked.provider.publicValues.baseUrl === provider.publicValues.baseUrl;
        if (!current || (!migratedEnvironment && (current.credentialRevision !== provider.credentialRevision || checked.credentialRevision !== provider.credentialRevision))) throw new Error("This account's credentials changed during the connection check. Review the saved account, then activate it again.");
        if (directory.smsRoutingRevision !== routingRevision) throw new Error("The active SMS provider changed during the connection check. Review the provider list before switching accounts.");
        if (current.senderId !== provider.senderId) throw new Error("The saved sender changed during the connection check. Review its approval before activating this account.");
        if (!current.configured || !current.verifiedAt || !current.senderApproved || !validSmsSender(current.id, current.senderId)) throw new Error(current.readiness.join(" ") || "Complete this provider's sender setup before activating it.");
        currentProvider = current; currentRoutingRevision = directory.smsRoutingRevision;
      }
      await accountApi("/api/sms/providers/active", { providerId: off ? null : provider.id, routingRevision: currentRoutingRevision, ...(off ? {} : { credentialRevision: currentProvider.credentialRevision }) });
      await onReload();
      onNotify(off ? "SMS sending paused. Your saved provider accounts are unchanged." : `${provider.name} is now the active SMS provider. New campaigns use this account.`);
    } catch (caught) { await fail(caught, provider.id); } finally { setBusy(""); }
  };
  const check = async (provider: SmsProviderState) => {
    setBusy(`sms-check:${provider.id}`); setError("");
    try { const result = await accountApi<ConnectionCheck>(`/api/sms/providers/${provider.id}/check`, { credentialRevision: provider.credentialRevision }); await onReload(); onBalance(result, result.provider); onNotify(`${provider.name} connection verified with a balance check. No message was sent.`); }
    catch (caught) { await onReload().catch(() => undefined); await fail(caught, provider.id, true); } finally { setBusy(""); }
  };
  const finishSetup = (provider: SmsProviderState) => {
    if (!provider.configured) { edit(provider); return; }
    if (!provider.senderApproved || !validSmsSender(provider.id, provider.senderId)) {
      if (provider.id === "termii") onTermiiConfigure("settings-sender-ids"); else edit(provider);
      return;
    }
    void toggle(provider, !provider.verifiedAt);
  };
  const save = async (provider: SmsProviderState, test: boolean) => {
    if (!form) return;
    setBusy(`sms-save:${provider.id}`); setError(""); let saved = false;
    try {
      if (form.senderId.trim() && !validSmsSender(provider.id, form.senderId.trim())) throw new Error(provider.senderHelp);
      const rate = form.ratePerSegment === "" ? null : Number(form.ratePerSegment);
      if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 10000)) throw new Error("Enter a positive NGN estimate up to 10,000 per segment, or leave it blank.");
      const result = await accountApi<{ provider: SmsProviderState }>(`/api/sms/providers/${provider.id}/settings`, { revision: editRevision.current, credentials: form.credentials, senderId: form.senderId.trim(), senderApproved: form.senderApproved, ratePerSegment: rate, transactionalEnabled: provider.supportsDnd && form.transactionalEnabled });
      saved = true; setShowSecrets(false); setForm(makeForm(result.provider)); editRevision.current = result.provider.revision;
      await onReload();
      if (test) { const checked = await accountApi<ConnectionCheck>(`/api/sms/providers/${provider.id}/check`, { credentialRevision: result.provider.credentialRevision }); await onReload(); onBalance(checked, checked.provider); }
      setEditing(null); setForm(null);
      const senderReady = result.provider.senderApproved && validSmsSender(provider.id, result.provider.senderId);
      onNotify(`${provider.name} settings saved${test ? " and connection verified" : ""}. ${senderReady ? test ? "Turn on its Active switch when ready." : "Use Verify & activate when ready." : "Choose and confirm an approved sender before activating."}`);
    } catch (caught) { if (saved) { await onReload().catch(() => undefined); const message = `Settings were saved, but setup could not finish: ${(caught as Error).message}`; setError(message); setErrorProvider(provider.id); onNotify(message, true); if ((caught as AccountError).status === 409) { setEditing(null); setForm(null); } } else await fail(caught, provider.id); }
    finally { setBusy(""); }
  };
  const remove = async (provider: SmsProviderState) => {
    setBusy(`sms-remove:${provider.id}`); setError("");
    try { await accountApi(`/api/sms/providers/${provider.id}/settings`, { revision: provider.revision }, "DELETE"); setEditing(null); setForm(null); setRemoveId(null); await onReload(); onNotify(`${provider.name} credentials removed. Contacts and campaign history are retained.`); }
    catch (caught) { await fail(caught, provider.id); } finally { setBusy(""); }
  };
  const active = providers.find(provider => provider.id === activeId);
  return <section className="sms-provider-directory" id="settings-providers" aria-label="SMS providers">
    <div className="sms-routing-summary"><span className={`sms-routing-icon ${active ? "is-active" : ""}`}><MessageSquare size={21} /></span><div><span>ACTIVE SMS PROVIDER</span><h2>{active ? active.name : "SMS sending paused"}</h2><p>{active ? "One provider handles new SMS campaigns. Turning on another provider switches this one off." : "Save and test a provider, confirm its sender, then turn on its Active switch."}</p></div><span className={`badge ${active ? "badge-active" : "badge-neutral"}`}>{active ? "Ready for reviewed campaigns" : "No active provider"}</span></div>
    <div className="sms-directory-intro"><div><h2>Your SMS providers <span>{providers.length}</span></h2><p>Connect the services you want to use. Every account keeps its own sender, credentials and balance.</p></div><span><LockKeyhole size={14} />Credentials encrypted</span></div>
    <div className="sms-provider-grid">{providers.map(provider => {
      const active = activeId === provider.id, expanded = editing === provider.id && !!form;
      const senderReady = provider.senderApproved && validSmsSender(provider.id, provider.senderId);
      const ready = provider.configured && !!provider.verifiedAt && senderReady;
      const readinessId = `sms-readiness-${provider.id}`;
      const nextAction = !provider.configured ? "Add credentials" : !senderReady ? provider.id === "termii" ? "Choose approved sender" : "Confirm sender" : !provider.verifiedAt ? "Verify & activate" : "Activate SMS";
      const readinessMessage = !provider.configured ? "Save this account's API credentials to get started." : !senderReady ? provider.id === "termii" ? "Choose an active Nigerian Sender ID from your Termii account. Saving API credentials alone does not confirm a sender." : provider.senderId && !validSmsSender(provider.id, provider.senderId) ? provider.senderHelp : "Save a valid sender and confirm that this provider has approved it for your account." : !provider.verifiedAt ? "Your sender is confirmed. Verify the saved API connection and activate this account in one step." : active ? "This account is active for new SMS campaigns." : "Ready to activate. This will replace the current SMS provider.";
      return <article className={`panel sms-provider-card ${active ? "is-active" : ""} ${expanded ? "is-expanded" : ""}`} key={provider.id}>
        <div className="sms-provider-card-heading"><div className="sms-provider-identity"><span className="sms-provider-monogram">{provider.name.split(/\s+/).map(word => word[0]).slice(0, 2).join("")}</span><div><h3>{provider.name}</h3><span className={`sms-provider-status ${provider.verifiedAt ? "is-verified" : ""}`}>{provider.verifiedAt ? <ShieldCheck size={12} /> : <span className="status-dot" />}{provider.verifiedAt ? "Connection verified" : provider.configured ? "Credentials saved" : "Not connected"}</span></div></div><div className="sms-active-control"><span>{active ? "Active" : ready ? "Ready" : "Setup needed"}</span><button type="button" role="switch" aria-checked={active} aria-describedby={readinessId} aria-label={active || ready ? `Use ${provider.name} for SMS` : `${nextAction} for ${provider.name}`} title={active ? "Pause SMS sending" : nextAction} className={`live-switch ${active ? "is-on" : ""}`} disabled={!available || !!busy || expanded || (!active && !provider.configurationAvailable)} onClick={() => active || ready ? void toggle(provider) : finishSetup(provider)}><span>{busy === `sms-active:${provider.id}` && <LoaderCircle size={12} className="spin" />}</span></button></div></div>
        <p className="sms-provider-description">{provider.description}</p>
        <Balance provider={provider} entry={balances[provider.id]} available={available} onRefresh={() => void onRefresh(provider.id, true)} />
        <div className="sms-provider-sender"><span>Sender</span><strong>{provider.senderId || "Not configured"}</strong><span className={`badge ${senderReady ? "badge-neutral" : "badge-setup"}`}>{senderReady ? "Confirmed" : "Needs setup"}</span></div>
        <p className="sms-provider-report-note">{provider.reports === "polling" ? "Delivery reports available in this app." : "Check final delivery reports in the provider dashboard."}</p>
        <div className={`sms-provider-readiness ${ready ? "is-ready" : ""}`} id={readinessId}>
          <div className="sms-readiness-steps" role="list" aria-label={`${provider.name} activation requirements`}>{[{ label: "Credentials saved", complete: provider.configured }, { label: "Connection verified", complete: !!provider.verifiedAt }, { label: "Sender confirmed", complete: senderReady }].map(step => <span role="listitem" className={step.complete ? "complete" : ""} key={step.label} aria-label={`${step.label}: ${step.complete ? "complete" : "required"}`}>{step.complete ? <Check size={12} aria-hidden="true" /> : <span className="requirement-dot" aria-hidden="true" />}{step.label}</span>)}</div>
          <p>{!provider.configurationAvailable && !active ? "Secure account configuration is temporarily unavailable. Try again when the connection is restored." : readinessMessage}</p>
          {provider.configured && !active && !expanded && <button className={`button ${ready || senderReady ? "primary" : "secondary"} small`} type="button" disabled={!available || !!busy || !provider.configurationAvailable} onClick={() => finishSetup(provider)}>{busy === `sms-active:${provider.id}` ? <LoaderCircle size={14} className="spin" /> : ready || senderReady ? <ShieldCheck size={14} /> : <ArrowRight size={14} />}{busy === `sms-active:${provider.id}` ? ready ? "Activating…" : "Verifying & activating…" : nextAction}</button>}
        </div>
        <div className="sms-provider-actions"><button type="button" className="button secondary small" disabled={!available || !!busy || !provider.configurationAvailable} onClick={() => edit(provider)}>{expanded ? <X size={14} /> : <Settings2 size={14} />}{expanded ? "Close settings" : provider.configured ? "Configure" : "Add credentials"}</button><button type="button" className="text-link" disabled={!available || !!busy || !provider.configured || expanded} onClick={() => void check(provider)}>{busy === `sms-check:${provider.id}` ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Test connection</button></div>
        {!expanded && error && errorProvider === provider.id && <div className="account-inline-error sms-provider-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
        {expanded && form && <div className="sms-provider-config"><div className="sms-provider-config-heading"><div><h4>Configure {provider.name}</h4><p>{provider.setupHelp}</p></div><a className="text-link" href={provider.docsUrl} target="_blank" rel="noreferrer">API docs<ArrowUpRight size={13} /></a></div>
          <div className="sms-provider-fields">{provider.fields.map(field => <label className="field" key={field.key}>{field.label}<input value={form.credentials[field.key] || ""} onChange={event => setForm(previous => previous ? { ...previous, credentials: { ...previous.credentials, [field.key]: event.target.value } } : previous)} type={field.secret && !showSecrets ? "password" : "text"} name={`new-${provider.id}-${field.key}`} autoComplete={field.secret ? "new-password" : "off"} autoCapitalize="none" spellCheck={false} placeholder={field.secret && provider.credentialsConfigured[field.key] ? "Saved securely; leave blank to keep" : field.placeholder || `Enter ${field.label.toLowerCase()}`} disabled={!!busy} /><small>{field.secret ? provider.credentialsConfigured[field.key] ? "Leave blank to keep the saved credential." : "Stored encrypted; never returned to this page." : "Use the exact value from your provider account."}</small></label>)}</div>
          {provider.fields.some(field => field.secret) && <button type="button" className="text-link sms-show-secrets" aria-pressed={showSecrets} disabled={!!busy} onClick={() => setShowSecrets(previous => !previous)}>{showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}{showSecrets ? "Hide entered credentials" : "Show entered credentials"}</button>}
          <div className="field-row"><label className="field">Sender ID / sending number<input value={form.senderId} onChange={event => setForm(previous => previous ? { ...previous, senderId: event.target.value, senderApproved: event.target.value.trim() === provider.senderId ? provider.senderApproved : false } : previous)} maxLength={provider.senderType === "flexible" ? 32 : 11} placeholder={provider.senderType === "flexible" ? "Approved name or +234…" : "Your approved brand name"} disabled={!!busy} /><small>{provider.senderHelp} You can save credentials first and configure the sender later.</small></label><label className="field">Estimate per SMS segment (₦)<input type="number" min="0.01" max="10000" step="0.01" value={form.ratePerSegment} onChange={event => setForm(previous => previous ? { ...previous, ratePerSegment: event.target.value } : previous)} placeholder="Optional NGN estimate" disabled={!!busy} /><small>Enter your own NGN estimate. The account balance above retains the provider’s billing unit.</small></label></div>
          <label className="checkbox-label checkbox-card"><input type="checkbox" checked={form.senderApproved} disabled={!!busy || !form.senderId.trim()} onChange={event => setForm(previous => previous ? { ...previous, senderApproved: event.target.checked } : previous)} /><span><strong>I confirm this sender is allowed for my account and Nigerian recipients</strong><small>Confirm the exact sender with {provider.name}. This records your confirmation; a balance check does not verify sender approval.</small></span></label>
          {provider.supportsDnd && <label className="checkbox-label checkbox-card"><input type="checkbox" checked={form.transactionalEnabled} disabled={!!busy} onChange={event => setForm(previous => previous ? { ...previous, transactionalEnabled: event.target.checked } : previous)} /><span><strong>My transactional route has been activated</strong><small>Use only for service and account messages supported by your provider.</small></span></label>}
          {error && errorProvider === provider.id && <div className="account-inline-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
          <p className="sms-provider-config-note"><LockKeyhole size={14} />Changing credentials pauses this provider and requires a new connection test. Existing campaigns keep their original provider and credential version.</p>
          <div className="sms-provider-config-actions"><button type="button" className="button secondary" disabled={!!busy} onClick={() => void save(provider, false)}>Save settings</button><button type="button" className="button primary" disabled={!!busy} onClick={() => void save(provider, true)}>{busy === `sms-save:${provider.id}` ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}Save & test connection</button></div>
          <div className="sms-provider-account-links"><a href={provider.website} className="text-link" target="_blank" rel="noreferrer">Open {provider.name}<ArrowUpRight size={13} /></a>{provider.configured && <button type="button" className="text-link remove-credentials-link" disabled={!!busy} onClick={() => setRemoveId(provider.id)}><Trash2 size={13} />Remove credentials</button>}</div>
          {removeId === provider.id && <div className="sms-remove-confirm"><p>Remove this account’s saved credentials? Any pending campaigns for it will stay paused.</p><div><button type="button" className="button secondary small" disabled={!!busy} onClick={() => setRemoveId(null)}>Keep account</button><button type="button" className="button danger small" disabled={!!busy} onClick={() => void remove(provider)}>{busy === `sms-remove:${provider.id}` && <LoaderCircle size={14} className="spin" />}Remove credentials</button></div></div>}
        </div>}
      </article>;
    })}</div>
    <div className="sms-routing-footnote"><ShieldCheck size={16} /><p>Sender requirements depend on the provider and recipient network. Switching providers does not carry over sender approvals. Existing campaigns retain their original provider; reactivate that provider to resume them. There is no automatic provider failover.</p></div>
  </section>;
}
