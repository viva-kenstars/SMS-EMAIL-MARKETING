import { env } from "cloudflare:workers";
import { normalizePhone, segmentInfo, validateSenderId, mapDeliveryStatus } from "./sms";
import { parseDirectNumbers, MAX_DIRECT_RECIPIENTS } from "./direct-numbers";
import { sendWhatsAppTemplate, ProviderError } from "./termii";
import { getProviderState, readProviderConfig, saveProviderSettings, removeProviderSettings, checkProviderConnection, ProviderSettingsError } from "./provider-settings";
import { getWhatsAppSettings, saveWhatsAppSettings, WhatsAppSettingsError, type WhatsAppPayload } from "./whatsapp-settings";
import { renderWhatsAppTemplate } from "./whatsapp";
import { dashboardBalance, senderIdsForAccount, selectApprovedSenderId, submitSenderIdRequest } from "./provider-account";
import { getSmsProviderDirectory, saveSmsProvider, removeSmsProvider, smsProviderBalance, activateSmsProvider, requireSmsCampaignConnection, readSmsConnection } from "./sms-provider-accounts";
import { getSmsProviderDefinition, validSmsSender, type SmsProviderId } from "./sms-provider-catalog";
import { smsAdapter, submitSms } from "./sms-providers";
import { handleEmailApi } from "./email/service";
import { emailRunnerStatus, handleEmailWorker } from "./email/runner";
import { handleMarketingApi, handleMarketingWorker } from "./email-marketing/service";

type Row = Record<string, any>;
type Summary = Record<string, number>;
const MAX_CONTACTS = 20000;
const MAX_CAMPAIGN = MAX_DIRECT_RECIPIENTS;
const MAX_BODY_BYTES = 1_500_000;
const STATUSES = ["pending", "sending", "accepted", "delivered", "failed", "unknown", "skipped", "validated"];

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function database(): D1Database {
  if (!env.DB) throw new AppError("The database is not ready. Please try again after deployment completes.", 503);
  return env.DB;
}

function identity(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!owner || !email) throw new AppError("Sign in to your private workspace to save contacts and campaigns.", 401);
  return owner;
}

async function bodyOf(request: Request): Promise<Row> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("Open this action from your SMS workspace.", 403);
  if (origin && origin !== new URL(request.url).origin && origin !== env.APP_ORIGIN) throw new AppError("This request came from a different website.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError("Use a JSON request.", 415);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new AppError("This upload is too large. Import up to 5,000 contacts at a time.", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AppError("This upload is too large.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AppError("The request contains invalid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Use a JSON object.");
  return body as Row;
}

const shortText = (value: unknown, fallback: string, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) || fallback : fallback;
const uuid = () => crypto.randomUUID();
const emptySummary = (): Summary => Object.fromEntries(STATUSES.map(status => [status, 0]));

async function executeBatches(db: D1Database, statements: D1PreparedStatement[]) {
  let changes = 0;
  for (let i = 0; i < statements.length; i += 80) {
    const results = await db.batch(statements.slice(i, i + 80));
    changes += results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
  }
  return changes;
}

async function settingsFor(db: D1Database, owner: string) {
  const row = await db.prepare("SELECT s.*,p.credential_revision AS current_credential_revision FROM settings s LEFT JOIN provider_settings p ON p.owner = s.owner WHERE s.owner = ?").bind(owner).first<Row>();
  const providerVerified = row?.sender_approval_source === "termii";
  const approved = !!row?.sender_approved && (!providerVerified || row.sender_credential_revision === (row.current_credential_revision ?? 0));
  return {
    senderId: row?.sender_id || "Trezad",
    senderApproved: approved,
    senderApprovalSource: approved ? providerVerified ? "termii" : "manual" : null,
    senderVerifiedAt: approved && providerVerified ? row.sender_verified_at : null,
    senderCredentialRevision: approved && providerVerified ? row.sender_credential_revision : null,
    ratePerSegment: row?.rate_per_segment ?? null,
    transactionalEnabled: !!row?.transactional_enabled,
  };
}

function contactDto(row: Row) {
  return { id: row.id, name: row.name, phone: row.phone, group: row.group_name, consent: !!row.consent, suppressed: !!row.suppressed, createdAt: row.created_at };
}

function campaignDto(row: Row, summary: Summary) {
  return {
    id: row.id, name: row.name, message: row.message, senderId: row.sender_id, channel: row.channel,
    mode: row.mode, status: row.status, audienceSource: row.audience_source || "contacts", recipientCount: row.recipient_count, segments: row.segments,
    encoding: row.encoding, estimatedCost: row.estimated_cost, createdAt: row.created_at, updatedAt: row.updated_at, summary,
    whatsapp: row.whatsapp_payload ? JSON.parse(row.whatsapp_payload) as WhatsAppPayload : null,
    smsProviderId: row.sms_provider_id || "termii", smsProviderName: getSmsProviderDefinition(row.sms_provider_id || "termii")?.name || "Termii",
    smsCredentialRevision: row.sms_credential_revision ?? null,
  };
}

async function campaignRow(db: D1Database, owner: string, id: string) {
  const row = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND owner = ?").bind(id, owner).first<Row>();
  if (!row) throw new AppError("Campaign not found in this workspace.", 404);
  return row;
}

async function campaignSummary(db: D1Database, id: string) {
  const results = await db.prepare("SELECT status, COUNT(*) AS total FROM recipients WHERE campaign_id = ? GROUP BY status").bind(id).all<Row>();
  const summary = emptySummary();
  for (const row of results.results) summary[row.status] = row.total;
  return summary;
}

async function campaignWithSummary(db: D1Database, owner: string, id: string) {
  const row = await campaignRow(db, owner, id);
  return campaignDto(row, await campaignSummary(db, id));
}

async function state(db: D1Database, owner: string) {
  const [contacts, campaigns, summaries, settings] = await Promise.all([
    db.prepare("SELECT * FROM contacts WHERE owner = ? ORDER BY created_at DESC LIMIT 20000").bind(owner).all<Row>(),
    db.prepare("SELECT * FROM campaigns WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 100").bind(owner).all<Row>(),
    db.prepare("SELECT r.campaign_id, r.status, COUNT(*) AS total FROM recipients r JOIN (SELECT id FROM campaigns WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 100) c ON c.id = r.campaign_id GROUP BY r.campaign_id, r.status").bind(owner).all<Row>(),
    settingsFor(db, owner),
  ]);
  const grouped: Record<string, Summary> = {};
  for (const row of summaries.results) (grouped[row.campaign_id] ??= emptySummary())[row.status] = row.total;
  const provider = await getProviderState(db, owner, settings);
  const [whatsapp, smsDirectory] = await Promise.all([getWhatsAppSettings(db, owner, provider), getSmsProviderDirectory(db, owner, settings, provider)]);
  return { contacts: contacts.results.map(contactDto), campaigns: campaigns.results.map(row => campaignDto(row, grouped[row.id] || emptySummary())), settings, provider, whatsapp, ...smsDirectory, preview: false };
}

async function importContacts(db: D1Database, owner: string, body: Row) {
  if (!Array.isArray(body.contacts) || body.contacts.length < 1 || body.contacts.length > 5000) throw new AppError("Import between 1 and 5,000 contacts at a time.");
  const existing = await db.prepare("SELECT phone FROM contacts WHERE owner = ?").bind(owner).all<Row>();
  const seen = new Set(existing.results.map(row => row.phone));
  let duplicates = 0, invalid = 0;
  const errors: string[] = [];
  const rows: unknown[][] = [];
  const now = Date.now();
  for (let i = 0; i < body.contacts.length; i++) {
    const row = body.contacts[i];
    const phone = normalizePhone(row?.phone);
    if (!phone) { invalid++; if (errors.length < 20) errors.push(`Row ${i + 1}: enter a valid Nigerian mobile number.`); continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    rows.push([uuid(), owner, shortText(row.name, "Contact", 100), phone, shortText(row.group, "General", 60), row.consent === true ? 1 : 0, 0, now]);
  }
  if (existing.results.length + rows.length > MAX_CONTACTS) throw new AppError("This workspace supports 20,000 contacts. Remove unused contacts before importing more.");
  const statements: D1PreparedStatement[] = [];
  // Bound JSON avoids hundreds of SQL statements and D1's parameter limit for
  // a full community import. The unique key still preserves existing opt-outs.
  for (let i = 0; i < rows.length; i += 250) {
    statements.push(db.prepare("INSERT INTO contacts (id,owner,name,phone,group_name,consent,suppressed,created_at) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]'),json_extract(value,'$[7]') FROM json_each(?) WHERE 1 ON CONFLICT(owner,phone) DO NOTHING").bind(JSON.stringify(rows.slice(i, i + 250))));
  }
  const inserted = await executeBatches(db, statements);
  return { inserted, duplicates: duplicates + rows.length - inserted, invalid, errors };
}

async function updateContact(db: D1Database, owner: string, body: Row) {
  if (typeof body.id !== "string") throw new AppError("Select a contact.");
  const current = await db.prepare("SELECT * FROM contacts WHERE id = ? AND owner = ?").bind(body.id, owner).first<Row>();
  if (!current) throw new AppError("Contact not found.", 404);
  const suppressed = typeof body.suppressed === "boolean" ? Number(body.suppressed) : current.suppressed;
  const consent = typeof body.consent === "boolean" ? Number(body.consent) : current.consent;
  await db.prepare("UPDATE contacts SET suppressed = ?, consent = ? WHERE id = ? AND owner = ?").bind(suppressed, consent, body.id, owner).run();
  return { updated: true };
}

async function deleteContacts(db: D1Database, owner: string, body: Row) {
  if (!Array.isArray(body.ids) || body.ids.length > 5000 || !body.ids.every((id: unknown) => typeof id === "string")) throw new AppError("Select valid contact IDs.");
  const result = await db.prepare("DELETE FROM contacts WHERE owner = ? AND id IN (SELECT value FROM json_each(?))").bind(owner, JSON.stringify(body.ids)).run();
  return { deleted: result.meta.changes };
}

async function saveSettings(db: D1Database, owner: string, body: Row) {
  const previous = await settingsFor(db, owner);
  const sender = typeof body.senderId === "string" ? body.senderId.trim() : previous.senderId;
  if (!validateSenderId(sender)) throw new AppError("Sender IDs must contain 3–11 letters, numbers or spaces, including at least one letter.");
  let rate = body.ratePerSegment === "" || body.ratePerSegment === null ? null : body.ratePerSegment ?? previous.ratePerSegment;
  if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 10000)) throw new AppError("Enter a valid naira rate per SMS segment, or leave it blank.");
  const approved = typeof body.senderApproved === "boolean" ? body.senderApproved : sender === previous.senderId && previous.senderApproved;
  const transactional = typeof body.transactionalEnabled === "boolean" ? body.transactionalEnabled : previous.transactionalEnabled;
  const keepProviderApproval = approved && sender === previous.senderId && previous.senderApproved && previous.senderApprovalSource === "termii";
  const approvalSource = approved ? keepProviderApproval ? "termii" : "manual" : null;
  await db.prepare("INSERT INTO settings (owner,sender_id,sender_approved,sender_approval_source,sender_verified_at,rate_per_segment,transactional_enabled,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET sender_id=excluded.sender_id,sender_approved=excluded.sender_approved,sender_approval_source=excluded.sender_approval_source,sender_credential_revision=CASE WHEN excluded.sender_approval_source='termii' THEN settings.sender_credential_revision ELSE NULL END,sender_verified_at=excluded.sender_verified_at,rate_per_segment=excluded.rate_per_segment,transactional_enabled=excluded.transactional_enabled,updated_at=excluded.updated_at").bind(owner, sender, Number(approved), approvalSource, keepProviderApproval ? previous.senderVerifiedAt : null, rate, Number(transactional), Date.now()).run();
  return settingsFor(db, owner);
}

async function createCampaign(db: D1Database, owner: string, body: Row) {
  if (!["draft", "preview"].includes(body.mode)) throw new AppError("Save a draft or run a preview before sending.");
  const name = shortText(body.name, "", 120);
  if (!name) throw new AppError("Give this campaign a name.");
  if (!["generic", "dnd", "whatsapp"].includes(body.channel)) throw new AppError("Choose an SMS route or WhatsApp template delivery.");
  const isWhatsApp = body.channel === "whatsapp";
  const settings = await settingsFor(db, owner);
  const directory = await getSmsProviderDirectory(db, owner, settings);
  const smsProvider = directory.smsProviders.find(provider => provider.id === (isWhatsApp ? "termii" : directory.activeSmsProviderId || "termii"))!;
  if (!isWhatsApp && body.smsProviderId !== undefined && body.smsProviderId !== smsProvider.id) throw new AppError("The active SMS provider changed. Refresh and review the campaign with the current provider.", 409);
  if (!isWhatsApp && body.smsCredentialRevision !== undefined && body.smsCredentialRevision !== smsProvider.credentialRevision) throw new AppError("The SMS connection changed. Refresh and review a new draft.", 409);
  let message = typeof body.message === "string" ? body.message : "";
  let sender = typeof body.senderId === "string" ? body.senderId.trim() : "";
  let whatsapp: WhatsAppPayload | null = null;
  let ratePerMessage: number | null = smsProvider.ratePerSegment;
  if (isWhatsApp) {
    if (body.whatsappPermission !== true) throw new AppError("Confirm that these recipients gave your organisation permission to send this WhatsApp invitation.");
    const setup = await getWhatsAppSettings(db, owner, await getProviderState(db, owner, settings));
    if (!setup.configured) throw new AppError("Save your WhatsApp device, business name and template reference in Provider & settings before creating a campaign.", 409);
    try { message = renderWhatsAppTemplate(setup.templateBody, body.whatsappData); }
    catch (error) { throw new AppError(error instanceof Error ? error.message : "Complete the WhatsApp template variables."); }
    sender = setup.businessName;
    ratePerMessage = setup.ratePerMessage;
    whatsapp = { deviceId: setup.deviceId, businessName: setup.businessName, templateId: setup.templateId, templateBody: setup.templateBody, category: setup.category, data: { ...body.whatsappData } };
  } else {
    if (!message.trim() || message.length > smsProvider.maxMessageLength) throw new AppError(`Enter a message containing up to ${smsProvider.maxMessageLength.toLocaleString("en")} characters for ${smsProvider.name}.`);
    if (/\{\{?[^{}]+\}?\}|\[(?:name|customer|date|time|link|url|location|offer|code|amount|business|brand|event|order|phone)[^\]]*\]/i.test(message)) throw new AppError("Replace all template placeholders before saving this campaign.");
    if (!validSmsSender(smsProvider.id, sender)) throw new AppError(`Enter a sender name or permitted number supported by ${smsProvider.name}.`);
    if (body.channel === "dnd" && !smsProvider.supportsDnd) throw new AppError(`${smsProvider.name} uses the standard SMS route in this app. Choose that route before creating the campaign.`);
  }
  const audienceSource = body.audienceSource ?? "contacts";
  if (audienceSource !== "contacts" && audienceSource !== "direct") throw new AppError("Choose saved contacts or type numbers directly.");
  let audience: { id: string; name: string; phone: string }[];
  if (audienceSource === "direct") {
    if (body.contactIds !== undefined && (!Array.isArray(body.contactIds) || body.contactIds.length > 0)) throw new AppError("Choose either saved contacts or direct numbers for this campaign, then review the recipients.");
    if (body.directConsent !== true) throw new AppError("Confirm these are your own test numbers or that you have permission to message them.");
    if (typeof body.directNumbers !== "string") throw new AppError("Enter one or more complete Nigerian mobile numbers.");
    const parsed = parseDirectNumbers(body.directNumbers);
    if (parsed.error) throw new AppError(parsed.error);
    if (parsed.invalid.length) throw new AppError(`Fix the ${parsed.invalid.length} invalid phone number${parsed.invalid.length === 1 ? "" : "s"} before continuing. No campaign was created.`);
    if (!parsed.phones.length) throw new AppError("Enter at least one complete Nigerian mobile number.");
    const saved = await db.prepare("SELECT id,name,phone,consent,suppressed FROM contacts WHERE owner = ?").bind(owner).all<Row>();
    const byPhone = new Map(saved.results.map(contact => [contact.phone, contact]));
    const blocked = parsed.phones.filter(phone => { const contact = byPhone.get(phone); return contact && (!contact.consent || contact.suppressed); });
    if (blocked.length) throw new AppError(`${blocked.length} entered number${blocked.length === 1 ? " is" : "s are"} suppressed or does not have recorded permission in your contacts. Remove those numbers before continuing.`);
    audience = parsed.phones.map(phone => { const contact = byPhone.get(phone); return { id: contact?.id || "", name: contact?.name || "Direct number", phone }; });
  } else {
    if (body.directNumbers !== undefined && (typeof body.directNumbers !== "string" || body.directNumbers.trim())) throw new AppError("Choose either saved contacts or direct numbers for this campaign, then review the recipients.");
    if (!Array.isArray(body.contactIds) || !body.contactIds.length || body.contactIds.length > MAX_CAMPAIGN || !body.contactIds.every((id: unknown) => typeof id === "string")) throw new AppError("Select between 1 and 5,000 contacts.");
    const selected = new Set(body.contactIds);
    const contacts = await db.prepare("SELECT * FROM contacts WHERE owner = ? AND consent = 1 AND suppressed = 0 ORDER BY created_at, id").bind(owner).all<Row>();
    audience = contacts.results.filter(row => selected.has(row.id)).map(row => ({ id: row.id, name: row.name, phone: row.phone }));
    if (!audience.length) throw new AppError("No eligible contacts were selected. Contacts need recorded permission and must not be suppressed.");
    if (audience.length !== selected.size) throw new AppError("Some selected contacts are unavailable, suppressed or do not have permission. Refresh your audience before continuing.");
  }
  const info = isWhatsApp ? { segments: 1, encoding: "WhatsApp template" } : segmentInfo(message);
  const now = Date.now(), id = uuid();
  const preview = body.mode === "preview";
  const estimate = ratePerMessage === null ? null : Math.round(ratePerMessage * info.segments * audience.length * 100) / 100;
  const statements = [db.prepare("INSERT INTO campaigns (id,owner,name,message,sender_id,channel,mode,status,audience_source,direct_consent_at,whatsapp_payload,whatsapp_consent_at,sms_provider_id,sms_credential_revision,recipient_count,segments,encoding,estimated_cost,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, owner, name, message, sender, body.channel, body.mode, "preparing", audienceSource, audienceSource === "direct" ? now : null, whatsapp ? JSON.stringify(whatsapp) : null, isWhatsApp ? now : null, smsProvider.id, smsProvider.credentialRevision, audience.length, info.segments, info.encoding, estimate, now, now)];
  const batchSize = isWhatsApp ? 5 : smsProvider.batchSize;
  const batchRows: unknown[][] = [], recipientRows: unknown[][] = [];
  for (let i = 0; i < audience.length; i += batchSize) {
    const batchId = uuid(), chunk = audience.slice(i, i + batchSize);
    batchRows.push([batchId, id, i / batchSize, preview ? "validated" : "pending", now, now]);
    for (const contact of chunk) recipientRows.push([uuid(), id, batchId, contact.id, contact.name, contact.phone, preview ? "validated" : "pending", now]);
  }
  // D1 supports SQLite JSON functions. Bound JSON keeps 5,000 recipients under
  // the per-invocation query budget while preserving small provider batches.
  const inserts = [
    { table: "batches", columns: "id,campaign_id,batch_index,status,created_at,updated_at", rows: batchRows, width: 6 },
    { table: "recipients", columns: "id,campaign_id,batch_id,contact_id,name,phone,status,updated_at", rows: recipientRows, width: 8 },
  ];
  for (const insert of inserts) {
    for (let i = 0; i < insert.rows.length; i += 250) {
      const fields = Array.from({ length: insert.width }, (_, index) => `json_extract(value, '$[${index}]')`).join(",");
      statements.push(db.prepare(`INSERT INTO ${insert.table} (${insert.columns}) SELECT ${fields} FROM json_each(?)`).bind(JSON.stringify(insert.rows.slice(i, i + 250))));
    }
  }
  // A campaign remains unsendable until every recipient has been persisted.
  await executeBatches(db, statements);
  await db.prepare("UPDATE campaigns SET status = ? WHERE id = ? AND owner = ?").bind(preview ? "preview" : "draft", id, owner).run();
  return { campaign: await campaignWithSummary(db, owner, id) };
}

async function updateCampaignStatus(db: D1Database, owner: string, id: string) {
  const row = await campaignRow(db, owner, id);
  const s = await campaignSummary(db, id);
  const blocked = await db.prepare("SELECT id FROM batches WHERE campaign_id = ? AND status IN ('unknown','failed') LIMIT 1").bind(id).first();
  let status = row.status;
  if (row.mode === "live") {
    if (s.unknown || (blocked && s.pending)) status = "attention";
    else if (s.sending || s.pending) status = "processing";
    else if (s.delivered && !s.accepted && !s.failed && !s.skipped) status = "delivered";
    else if (s.failed && !s.accepted && !s.delivered) status = "failed";
    else if (s.failed || s.skipped) status = s.accepted || s.delivered ? "partial" : "cancelled";
    else status = "submitted";
  }
  await db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND owner = ?").bind(status, Date.now(), id, owner).run();
  return campaignDto({ ...row, status, updated_at: Date.now() }, s);
}

async function sendNextBatch(db: D1Database, owner: string, id: string, body: Row) {
  if (body.confirmed !== true) throw new AppError("Review and explicitly confirm this campaign before sending.", 409);
  const campaign = await campaignRow(db, owner, id);
  if (campaign.mode === "preview") throw new AppError("Preview campaigns cannot send messages. Create a new draft to send.", 409);
  if (["preparing", "cancelled"].includes(campaign.status)) throw new AppError("This campaign is not available for sending.", 409);
  if (campaign.audience_source === "direct" && !campaign.direct_consent_at) throw new AppError("Permission for these direct numbers has not been confirmed. Create and review a new campaign.", 409);
  const isWhatsApp = campaign.channel === "whatsapp";
  const smsConnection = isWhatsApp ? null : await requireSmsCampaignConnection(db, owner, campaign);
  let whatsapp: WhatsAppPayload | null = null;
  let config: Awaited<ReturnType<typeof readProviderConfig>> | null = null;
  if (isWhatsApp) {
    const provider = await getProviderState(db, owner, await settingsFor(db, owner));
    if (!campaign.whatsapp_consent_at || !campaign.whatsapp_payload) throw new AppError("WhatsApp permission and template details must be recorded in a new campaign before sending.", 409);
    const setup = await getWhatsAppSettings(db, owner, provider);
    if (!setup.liveEnabled) throw new AppError("WhatsApp live sending is not active. Complete the account and template setup in Provider & settings.", 409);
    whatsapp = JSON.parse(campaign.whatsapp_payload) as WhatsAppPayload;
    if (["deviceId", "businessName", "templateId", "templateBody", "category"].some(key => whatsapp![key as keyof WhatsAppPayload] !== setup[key as keyof typeof setup])) throw new AppError("The WhatsApp account or template changed after this campaign was created. Review a new draft with the current approved template.", 409);
    config = await readProviderConfig(db, owner, false, provider.revision);
  } else {
    if (campaign.channel === "generic" && smsConnection!.provider.id === "termii") {
      const hour = Number(new Intl.DateTimeFormat("en", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Lagos" }).format(new Date()));
      if (hour < 8 || hour >= 20) throw new AppError("Promotional campaigns can be sent between 08:00 and 20:00 WAT. This avoids Termii's documented MTN quiet hours.", 409);
    }
  }
  const now = Date.now();
  // Interrupted submissions are not safe to replay. Reconcile them in the provider dashboard.
  await db.batch([
    db.prepare("UPDATE recipients SET status = 'unknown', reason = 'Submission interrupted. Check provider history before resending.', updated_at = ? WHERE campaign_id = ? AND status = 'sending' AND updated_at < ?").bind(now, id, now - 120000),
    db.prepare("UPDATE batches SET status = 'unknown', error = 'Submission interrupted. Check provider history before resending.', updated_at = ? WHERE campaign_id = ? AND status = 'sending' AND updated_at < ?").bind(now, id, now - 120000),
  ]);
  const active = await db.prepare("SELECT status FROM batches WHERE campaign_id = ? AND status IN ('sending','unknown','failed') LIMIT 1").bind(id).first<Row>();
  if (active) {
    const current = await updateCampaignStatus(db, owner, id);
    return { campaign: current, remaining: current.summary.pending, halted: true, message: active.status === "sending" ? "A batch is already being submitted. Wait for it to finish." : "Sending stopped after an uncertain or rejected batch. Review its result before starting another campaign." };
  }
  // One atomic update serializes every batch for this campaign, including duplicate clicks.
  const batch = await db.prepare("UPDATE batches SET status = 'sending', updated_at = ? WHERE id = (SELECT id FROM batches WHERE campaign_id = ? AND status = 'pending' ORDER BY batch_index LIMIT 1) AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM batches WHERE campaign_id = ? AND status IN ('sending','unknown','failed')) RETURNING *").bind(now, id, id).first<Row>();
  if (!batch) {
    const current = await updateCampaignStatus(db, owner, id);
    const stillActive = current.summary.pending > 0 || current.summary.sending > 0;
    return { campaign: current, remaining: current.summary.pending, halted: stillActive, ...(stillActive ? { message: "A batch is already in progress. Wait before resuming this campaign." } : {}) };
  }
  await db.prepare("UPDATE campaigns SET mode = 'live', status = 'processing', updated_at = ? WHERE id = ? AND owner = ?").bind(now, id, owner).run();
  // Recheck suppression/permission immediately before the external submission.
  if (campaign.audience_source === "direct") {
    // Direct entry cannot override existing opt-outs, including a saved contact
    // added or changed after this draft was created. Matched contacts also retain
    // the normal deletion and permission checks.
    await db.prepare("UPDATE recipients SET status = 'skipped', reason = 'Number removed, suppressed or permission withdrawn before sending.', updated_at = ? WHERE batch_id = ? AND status = 'pending' AND ((contact_id <> '' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = recipients.contact_id AND c.owner = ? AND c.phone = recipients.phone AND c.consent = 1 AND c.suppressed = 0)) OR EXISTS (SELECT 1 FROM contacts c WHERE c.owner = ? AND c.phone = recipients.phone AND (c.consent = 0 OR c.suppressed = 1)))").bind(now, batch.id, owner, owner).run();
  } else {
    await db.prepare("UPDATE recipients SET status = 'skipped', reason = 'Contact removed, suppressed or permission withdrawn before sending.', updated_at = ? WHERE batch_id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = recipients.contact_id AND c.owner = ? AND c.phone = recipients.phone AND c.consent = 1 AND c.suppressed = 0)").bind(now, batch.id, owner).run();
  }
  await db.prepare("UPDATE recipients SET status = 'sending', updated_at = ? WHERE batch_id = ? AND status = 'pending'").bind(now, batch.id).run();
  const recipients = await db.prepare("SELECT id,phone FROM recipients WHERE batch_id = ? AND status = 'sending'").bind(batch.id).all<Row>();
  let halted = false, note: string | undefined;
  if (!recipients.results.length) {
    await db.prepare("UPDATE batches SET status = 'skipped', updated_at = ? WHERE id = ?").bind(Date.now(), batch.id).run();
  } else if (whatsapp) {
    const payload = whatsapp;
    // The template API accepts one number. Settle every request in this bounded
    // batch and persist each outcome; never reuse one recipient's ID for another.
    const results = await Promise.allSettled(recipients.results.map(async recipient => {
      try {
        const result = await sendWhatsAppTemplate(config!, { phone: recipient.phone.replace(/^\+/, ""), deviceId: payload.deviceId, templateId: payload.templateId, data: payload.data });
        await db.prepare("UPDATE recipients SET status = 'accepted', provider_id = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(result.providerId, Date.now(), recipient.id).run();
        return { status: "accepted", reason: undefined as string | undefined };
      } catch (error) {
        const status = error instanceof ProviderError && error.outcome === "rejected" ? "failed" : "unknown";
        const reason = error instanceof ProviderError ? error.message : "Submission could not be confirmed. Check provider history before resending.";
        await db.prepare("UPDATE recipients SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(status, reason, Date.now(), recipient.id).run();
        return { status, reason };
      }
    }));
    const unknown = results.some(result => result.status === "rejected" || result.value.status === "unknown");
    const failed = results.some(result => result.status === "fulfilled" && result.value.status === "failed");
    halted = unknown || failed;
    if (halted) note = unknown ? "Some WhatsApp submissions could not be confirmed. Check each recipient in Termii before resending. Later batches have stopped." : "Termii rejected at least one WhatsApp message. Review the recipient results before starting another campaign. Later batches have stopped.";
    await db.batch([
      db.prepare("UPDATE recipients SET status = 'unknown', reason = 'Submission could not be recorded. Check provider history before resending.', updated_at = ? WHERE batch_id = ? AND status = 'sending'").bind(Date.now(), batch.id),
      db.prepare("UPDATE batches SET status = ?, error = ?, updated_at = ? WHERE id = ?").bind(unknown ? "unknown" : failed ? "failed" : "accepted", note ?? null, Date.now(), batch.id),
    ]);
  } else {
    let submissionAttempted = false;
    try {
      // Recheck routing after claiming the batch. A provider switch must never
      // redirect this frozen campaign to another account or trigger a failover.
      const current = await requireSmsCampaignConnection(db, owner, campaign);
      if (current.provider.credentialRevision !== smsConnection!.provider.credentialRevision) throw new ProviderSettingsError("The SMS credentials changed before submission. Review a new draft.", 409);
      submissionAttempted = true;
      const results = await submitSms(current.provider.id, current.credentials, { phones: recipients.results.map(row => row.phone), senderId: campaign.sender_id, message: campaign.message, channel: campaign.channel });
      const unknown = results.some(result => result.status === "unknown"), failed = results.some(result => result.status === "failed");
      halted = unknown || failed;
      if (halted) note = unknown ? "Some submissions could not be confirmed. Check this provider’s message history before resending. Later batches have stopped." : "The provider rejected one or more recipients. Review the results before starting another campaign. Later batches have stopped.";
      const ids = [...new Set(results.map(result => result.providerId).filter(Boolean))];
      // Persist all recipient outcomes and their batch atomically. Bound JSON
      // keeps native bulk providers inside D1's per-request query budget.
      await db.batch([
        db.prepare("UPDATE recipients SET status=json_extract(result.value,'$.status'),provider_id=json_extract(result.value,'$.providerId'),reason=json_extract(result.value,'$.reason'),updated_at=? FROM json_each(?) AS result WHERE recipients.batch_id=? AND recipients.phone=json_extract(result.value,'$.phone') AND recipients.status='sending'").bind(Date.now(), JSON.stringify(results), batch.id),
        db.prepare("UPDATE batches SET status=?,provider_id=?,error=?,updated_at=? WHERE id=?").bind(unknown ? "unknown" : failed ? "failed" : "accepted", ids.length === 1 ? ids[0] : null, note ?? null, Date.now(), batch.id),
      ]);
    } catch (error) {
      note = error instanceof ProviderError || error instanceof ProviderSettingsError ? error.message : "Submission could not be confirmed. Check provider history before resending.";
      halted = true;
      if (!submissionAttempted && error instanceof ProviderSettingsError) {
        // The final configuration guard failed before any external submission.
        // Release only this unsent claim, preserving suppressions and a concurrent
        // cancellation. Once submitSms starts, an uncertain request is never replayed.
        note += " This batch was not submitted. Review the saved setup before resuming.";
        const cancelled = "EXISTS (SELECT 1 FROM campaigns WHERE id=? AND status='cancelled')";
        await db.batch([
          db.prepare(`UPDATE recipients SET status=CASE WHEN ${cancelled} THEN 'skipped' ELSE 'pending' END,reason=CASE WHEN ${cancelled} THEN 'Cancelled before submission.' ELSE NULL END,updated_at=? WHERE batch_id=? AND status='sending' AND provider_id IS NULL`).bind(id, id, Date.now(), batch.id),
          db.prepare(`UPDATE batches SET status=CASE WHEN ${cancelled} THEN 'cancelled' ELSE 'pending' END,error=?,updated_at=? WHERE id=? AND status='sending' AND provider_id IS NULL`).bind(id, note, Date.now(), batch.id),
        ]);
      } else {
        const status = error instanceof ProviderError && error.outcome === "rejected" ? "failed" : "unknown";
        await db.batch([
          db.prepare("UPDATE batches SET status = ?, error = ?, updated_at = ? WHERE id = ?").bind(status, note, Date.now(), batch.id),
          db.prepare("UPDATE recipients SET status = ?, reason = ?, updated_at = ? WHERE batch_id = ? AND status = 'sending'").bind(status, note, Date.now(), batch.id),
        ]);
      }
    }
  }
  const updated = await updateCampaignStatus(db, owner, id);
  return { campaign: updated, remaining: updated.summary.pending, halted, ...(note ? { message: note } : {}) };
}

async function campaignDetail(db: D1Database, owner: string, id: string) {
  const campaign = await campaignWithSummary(db, owner, id);
  const [recipients, batches] = await Promise.all([
    db.prepare("SELECT id,name,phone,status,provider_id,reason,updated_at FROM recipients WHERE campaign_id = ? ORDER BY rowid").bind(id).all<Row>(),
    db.prepare("SELECT id,status,provider_id,error,created_at FROM batches WHERE campaign_id = ? ORDER BY batch_index").bind(id).all<Row>(),
  ]);
  return { campaign, recipients: recipients.results.map(row => ({ id: row.id, name: row.name, phone: row.phone, status: row.status, providerId: row.provider_id, reason: row.reason, updatedAt: row.updated_at })), batches: batches.results.map(row => ({ id: row.id, status: row.status, providerId: row.provider_id, error: row.error, createdAt: row.created_at })) };
}

async function refreshReports(db: D1Database, owner: string, id: string, body: Row) {
  const campaign = await campaignRow(db, owner, id);
  if (campaign.mode !== "live") throw new AppError("Delivery reports are only available for live campaigns.", 409);
  const providerId = (campaign.sms_provider_id || "termii") as SmsProviderId;
  const definition = getSmsProviderDefinition(providerId)!;
  const connection = await readSmsConnection(db, owner, providerId, campaign.sms_credential_revision ?? undefined);
  const adapter = smsAdapter(providerId);
  if (!adapter.reports) return { campaign: await campaignWithSummary(db, owner, id), updated: 0, nextCursor: null, warnings: [`Final delivery reports for ${definition.name} are available in the provider dashboard. Accepted means submitted to the provider, not delivered to the handset.`] };
  // SMS can share a submission ID; WhatsApp has one per number. A stable rowid
  // cursor keeps pages correct as completed groups disappear. Return only one
  // bounded page plus lookahead instead of materializing every ID on every call.
  const cursor = Number.isSafeInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  const batches = await db.prepare("SELECT batch_id AS id,provider_id,MIN(rowid) AS report_cursor FROM recipients WHERE campaign_id = ? AND provider_id IS NOT NULL GROUP BY batch_id,provider_id HAVING MIN(rowid)>? AND SUM(CASE WHEN status!='delivered' THEN 1 ELSE 0 END)>0 ORDER BY MIN(rowid) LIMIT 11").bind(id, cursor).all<Row>();
  const selected = batches.results.slice(0, 10);
  let updated = 0, halted = false;
  const warnings: string[] = [];
  for (let i = 0; i < selected.length; i += 5) {
    const group = selected.slice(i, i + 5);
    const results = await Promise.allSettled(group.map(batch => adapter.reports!(connection.credentials, batch.provider_id)));
    const updates: { batchId: string; providerId: string; phone: string; status: string; reason: string | null }[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        if (result.reason instanceof ProviderError && (result.reason.reason === "rate_limited" || result.reason.reason === "authentication")) {
          // These adapter-controlled messages are safe to show. Stop after this
          // already-started wave instead of walking hundreds of blocked pages.
          warnings.push(`${result.reason.message} Report refresh paused. Existing statuses have been preserved.`);
          halted = true;
        } else warnings.push("Some delivery reports could not be refreshed. Existing statuses have been preserved.");
        return;
      }
      for (const report of result.value) {
        const phone = normalizePhone(report.phone);
        if (!phone) continue;
        const status = mapDeliveryStatus(report.status);
        // Never regress a confirmed handset delivery or overwrite a final failure with a queued report.
        updates.push({ batchId: group[index].id, providerId: report.providerId, phone, status, reason: status === "failed" || status === "unknown" ? report.status.slice(0, 160) : null });
      }
    });
    if (updates.length) {
      const result = await db.prepare("UPDATE recipients SET status=json_extract(result.value,'$.status'),reason=json_extract(result.value,'$.reason'),updated_at=? FROM json_each(?) AS result WHERE recipients.campaign_id=? AND recipients.batch_id=json_extract(result.value,'$.batchId') AND recipients.provider_id=json_extract(result.value,'$.providerId') AND recipients.phone=json_extract(result.value,'$.phone') AND recipients.status!='delivered' AND (recipients.status!='failed' OR json_extract(result.value,'$.status')='delivered') AND recipients.status NOT IN ('pending','skipped','validated')").bind(Date.now(), JSON.stringify(updates), id).run();
      updated += result.meta.changes;
    }
    if (halted) break;
  }
  const nextCursor = !halted && batches.results.length > selected.length ? selected[selected.length - 1].report_cursor as number : null;
  return { campaign: await updateCampaignStatus(db, owner, id), updated, nextCursor, warnings: [...new Set(warnings)], ...(halted ? { halted: true } : {}) };
}

async function cancelCampaign(db: D1Database, owner: string, id: string) {
  const row = await campaignRow(db, owner, id);
  if (row.mode === "preview") throw new AppError("Preview campaigns do not send messages.", 409);
  await db.batch([
    db.prepare("UPDATE recipients SET status = 'skipped', reason = 'Cancelled before submission.', updated_at = ? WHERE campaign_id = ? AND status = 'pending'").bind(Date.now(), id),
    db.prepare("UPDATE batches SET status = 'cancelled', updated_at = ? WHERE campaign_id = ? AND status = 'pending'").bind(Date.now(), id),
    db.prepare("UPDATE campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner = ?").bind(Date.now(), id, owner),
  ]);
  return { campaign: await campaignWithSummary(db, owner, id), message: "Unsubmitted recipients were cancelled. Messages already submitted cannot be recalled." };
}

export async function handleApi(request: Request): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/email/worker") return await handleEmailWorker(request, {
      db: database(), masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, tokenHash: env.EMAIL_WORKER_TOKEN_SHA256,
    });
    if (pathname === "/api/marketing/worker") return await handleMarketingWorker(request, {
      db: database(), masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, workerTokenHash: env.EMAIL_WORKER_TOKEN_SHA256, appOrigin: env.APP_ORIGIN,
    });
    const owner = identity(request);
    const db = database();
    if (pathname.startsWith("/api/marketing/")) {
      const response = await handleMarketingApi(request, { db, owner, masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, workerTokenHash: env.EMAIL_WORKER_TOKEN_SHA256, appOrigin: env.APP_ORIGIN });
      if (response) return response;
      throw new AppError("This email marketing action is not available.", 404);
    }
    if (pathname === "/api/email/runner" && request.method === "GET") return json(await emailRunnerStatus({
      db, masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, tokenHash: env.EMAIL_WORKER_TOKEN_SHA256,
    }));
    if (pathname.startsWith("/api/email/")) {
      const response = await handleEmailApi(request, { db, owner, masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, appOrigin: env.APP_ORIGIN });
      if (response) return response;
      throw new AppError("This email verification action is not available.", 404);
    }
    const path = new URL(request.url).pathname.replace(/^\/api\//, "").split("/");
    const method = request.method;
    const body = method === "GET" ? {} : await bodyOf(request);
    if (path[0] === "state" && method === "GET") return json(await state(db, owner));
    if (path[0] === "sms" && path[1] === "providers") {
      if (path.length === 2 && method === "GET") return json(await getSmsProviderDirectory(db, owner));
      if (path[2] === "active" && path.length === 3 && method === "POST") return json(await activateSmsProvider(db, owner, body));
      if (path.length === 4) {
        const id = path[2];
        if (path[3] === "settings" && method === "POST") return json(await saveSmsProvider(db, owner, id, body));
        if (path[3] === "settings" && method === "DELETE") return json(await removeSmsProvider(db, owner, id, body));
        if (path[3] === "balance" && method === "GET") return json(await smsProviderBalance(db, owner, id));
        if (path[3] === "check" && method === "POST") return json(await smsProviderBalance(db, owner, id, true, body.credentialRevision));
      }
    }
    if (path[0] === "contacts") {
      if (method === "POST") return json(await importContacts(db, owner, body));
      if (method === "PATCH") return json(await updateContact(db, owner, body));
      if (method === "DELETE") return json(await deleteContacts(db, owner, body));
    }
    if (path[0] === "settings" && method === "POST") return json(await saveSettings(db, owner, body));
    if (path[0] === "whatsapp" && path[1] === "settings" && method === "POST") return json(await saveWhatsAppSettings(db, owner, body, await getProviderState(db, owner, await settingsFor(db, owner))));
    if (path[0] === "provider" && path[1] === "check" && method === "POST") return json(await checkProviderConnection(db, owner, await settingsFor(db, owner)));
    if (path[0] === "provider" && path[1] === "balance" && path.length === 2 && method === "GET") return json(await dashboardBalance(db, owner));
    if (path[0] === "provider" && path[1] === "sender-ids") {
      if (path.length === 2 && method === "GET") return json(await senderIdsForAccount(db, owner));
      if (path.length === 3 && path[2] === "select" && method === "POST") {
        await selectApprovedSenderId(db, owner, body);
        const settings = await settingsFor(db, owner);
        return json({ settings, provider: await getProviderState(db, owner, settings) });
      }
      if (path.length === 3 && path[2] === "request" && method === "POST") return json(await submitSenderIdRequest(db, owner, body), 201);
    }
    if (path[0] === "provider" && path[1] === "settings") {
      if (method === "POST") return json(await saveProviderSettings(db, owner, body, await settingsFor(db, owner)));
      if (method === "DELETE") return json(await removeProviderSettings(db, owner, body, await settingsFor(db, owner)));
    }
    if (path[0] === "campaigns") {
      if (!path[1] && method === "POST") return json(await createCampaign(db, owner, body), 201);
      const id = path[1];
      if (id && /^[a-f0-9-]{36}$/.test(id)) {
        if (!path[2] && method === "GET") return json(await campaignDetail(db, owner, id));
        if (path[2] === "send" && method === "POST") return json(await sendNextBatch(db, owner, id, body));
        if (path[2] === "refresh" && method === "POST") return json(await refreshReports(db, owner, id, body));
        if (path[2] === "cancel" && method === "POST") return json(await cancelCampaign(db, owner, id));
      }
    }
    throw new AppError("This action is not available.", 404);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    if (error instanceof ProviderSettingsError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    if (error instanceof WhatsAppSettingsError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    if (error instanceof ProviderError) {
      // Only return adapter-controlled classifications, never provider response bodies,
      // redirect locations, request URLs, or raw exceptions that may contain credentials.
      return json({
        error: error.message,
        outcome: error.outcome,
        code: `provider_${error.operation}_${error.reason}`,
        diagnostic: {
          operation: error.operation,
          reason: error.reason,
          ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
          ...(error.contentType === undefined ? {} : { contentType: error.contentType }),
        },
      }, 502);
    }
    // Database/fetch errors can contain private data or connection details; do not echo them.
    return json({ error: "The operation could not be completed. Refresh your workspace and try again. No automatic message resend was attempted." }, 500);
  }
}
