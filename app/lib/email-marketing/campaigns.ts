import { accountRow, relayConnection, releaseAccount, settingsRow, smtpCredentials } from "./accounts";
import { cleanHtml, plainText, renderMessage } from "./content";
import { conflict, cursorFor, cursorValue, day, digest, email, emptySummary, integer, MarketingError, text, type Context, type Row } from "./common";
import { sendRelay } from "./relay";
import type { CampaignSummary, EmailCampaign, EmailDelivery } from "./types";

export async function campaignRow(context: Pick<Context, "db" | "owner">, id: string) {
  const row = await context.db.prepare("SELECT * FROM marketing_campaigns WHERE id=? AND owner=?").bind(id, context.owner).first<Row>();
  if (!row) throw new MarketingError("Email campaign not found in this workspace.", 404);
  return row;
}
export async function summary(context: Pick<Context, "db">, id: string): Promise<CampaignSummary> {
  const result = emptySummary();
  const rows = (await context.db.prepare("SELECT status,COUNT(*) AS count FROM marketing_recipients WHERE campaign_id=? GROUP BY status").bind(id).all<Row>()).results;
  for (const row of rows) if (row.status in result) result[row.status as keyof CampaignSummary] = row.count;
  return result;
}
export function campaignDto(row: Row, counts: CampaignSummary = emptySummary()): EmailCampaign {
  return { id: row.id, name: row.name, subject: row.subject, preheader: row.preheader, html: row.html || "", text: row.text_content || "", status: row.status, revision: row.revision, recipientCount: row.recipient_count, summary: counts,
    groupIds: JSON.parse(row.group_ids), accountIds: JSON.parse(row.account_ids), intervalSeconds: row.interval_seconds, scheduledAt: row.scheduled_at, nextSendAt: row.next_send_at, startedAt: row.started_at, completedAt: row.completed_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}
export const detail = async (context: Context, id: string) => campaignDto(await campaignRow(context, id), await summary(context, id));
export function deliveryDto(row: Row): EmailDelivery {
  return { id: row.id, email: row.email, name: row.name || "", status: row.status, accountId: row.account_id || null, messageId: row.message_id || null, error: row.error || null, updatedAt: row.updated_at };
}
export async function listCampaigns(context: Context, rawCursor: string | null = null) {
  const cursor = cursorValue(rawCursor), params: unknown[] = [context.owner];
  if (cursor) params.push(cursor.t, cursor.t, cursor.id);
  const rows = (await context.db.prepare(`SELECT id,owner,name,subject,preheader,status,revision,recipient_count,group_ids,account_ids,interval_seconds,scheduled_at,next_send_at,started_at,completed_at,last_error,created_at,updated_at FROM marketing_campaigns WHERE owner=? ${cursor ? "AND (created_at<? OR created_at=? AND id<?)" : ""} ORDER BY created_at DESC,id DESC LIMIT 101`).bind(...params).all<Row>()).results;
  const visible = rows.slice(0, 100), grouped: Record<string, CampaignSummary> = {};
  if (visible.length) {
    const aggregates = (await context.db.prepare("SELECT campaign_id,status,COUNT(*) AS count FROM marketing_recipients WHERE campaign_id IN(SELECT value FROM json_each(?)) GROUP BY campaign_id,status").bind(JSON.stringify(visible.map(row => row.id))).all<Row>()).results;
    for (const row of aggregates) if (row.status in emptySummary()) (grouped[row.campaign_id] ??= emptySummary())[row.status as keyof CampaignSummary] = row.count;
  }
  return { campaigns: visible.map(row => campaignDto(row, grouped[row.id])), nextCursor: rows.length > 100 ? cursorFor(visible[visible.length - 1]) : null };
}
export async function saveCampaign(context: Context, body: Row) {
  const previous = body.id ? await campaignRow(context, String(body.id)) : null;
  if (body.revision !== (previous?.revision ?? 0)) throw conflict();
  if (previous && previous.status !== "draft") throw new MarketingError("Duplicate a launched campaign to edit its content or audience.", 409);
  const name = text(body.name, "campaign name", 160, previous?.name || "");
  const subject = text(body.subject, "subject", 300, previous?.subject || "");
  if (!name || !subject) throw new MarketingError("Enter the campaign name and email subject.");
  const preheader = text(body.preheader, "preview text", 300, previous?.preheader || "");
  const html = cleanHtml(body.html ?? previous?.html);
  const rawText = body.text ?? previous?.text_content ?? plainText(html);
  if (typeof rawText !== "string" || rawText.length > 200_000 || /\u0000/.test(rawText)) throw new MarketingError("Use plain text of at most 200,000 characters.");
  const id = previous?.id || crypto.randomUUID(), now = Date.now();
  const values = [name, subject, preheader, html, rawText, (previous?.revision || 0) + 1, now];
  const changed = previous
    ? await context.db.prepare("UPDATE marketing_campaigns SET name=?,subject=?,preheader=?,html=?,text_content=?,revision=?,updated_at=? WHERE id=? AND owner=? AND revision=? AND status='draft'").bind(...values, id, context.owner, previous.revision).run()
    : await context.db.prepare("INSERT INTO marketing_campaigns(name,subject,preheader,html,text_content,revision,updated_at,id,owner,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(...values, id, context.owner, now).run();
  if (changed.meta.changes !== 1) throw conflict();
  return { campaign: await detail(context, id) };
}
export async function duplicateCampaign(context: Context, id: string) {
  const current = await campaignRow(context, id);
  return saveCampaign(context, { name: `${current.name.slice(0, 150)} (copy)`, subject: current.subject, preheader: current.preheader, html: current.html, text: current.text_content, revision: 0 });
}
function ids(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new MarketingError(`Choose between 1 and 1,000 ${label} for this campaign.`);
  return [...new Set(value)] as string[];
}
export async function launchCampaign(context: Context, id: string, body: Row) {
  const campaign = await campaignRow(context, id);
  if (campaign.revision !== body.revision) throw conflict();
  if (campaign.status !== "draft") throw new MarketingError("This campaign has already been launched. Resume it or duplicate it to send a new campaign.", 409);
  if (body.acknowledgeConsent !== true) throw new MarketingError("Confirm that the selected contacts may receive this campaign before launching.");
  const groups = ids(body.groupIds, "contact groups"), accounts = ids(body.accountIds, "SMTP accounts");
  const interval = integer(body.intervalSeconds, "sending interval in seconds", 1, 86_400);
  const now = Date.now();
  const scheduledAt = body.scheduledAt === undefined || body.scheduledAt === null ? null : integer(body.scheduledAt, "scheduled time", now - 60_000, now + 366 * 86_400_000);
  const settings = await settingsRow(context);
  if (!settings?.relay_verified_at) throw new MarketingError("Save and test the SMTP service before launching a campaign.", 409);
  if (!settings.postal_address) throw new MarketingError("Add your business mailing address in Email marketing settings before sending.", 409);
  await relayConnection(context, settings);
  const selectedGroups = (await context.db.prepare("SELECT id FROM marketing_groups WHERE owner=? AND id IN(SELECT value FROM json_each(?))").bind(context.owner, JSON.stringify(groups)).all<Row>()).results;
  if (selectedGroups.length !== groups.length) throw new MarketingError("One or more selected groups are no longer available.", 409);
  const selectedAccounts = (await context.db.prepare("SELECT id,credential_revision FROM smtp_accounts WHERE owner=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL AND enabled=1 AND verified_at IS NOT NULL").bind(context.owner, JSON.stringify(accounts)).all<Row>()).results;
  if (selectedAccounts.length !== accounts.length) throw new MarketingError("Test and enable every selected SMTP account before launching.", 409);
  const count = await context.db.prepare("SELECT COUNT(DISTINCT c.id) AS count FROM marketing_contacts c JOIN marketing_group_members m ON m.contact_id=c.id WHERE c.owner=? AND c.suppressed=0 AND m.group_id IN(SELECT value FROM json_each(?))").bind(context.owner, JSON.stringify(groups)).first<Row>();
  if (!count?.count) throw new MarketingError("The selected groups contain no verified, unsuppressed contacts.", 409);
  const token = crypto.randomUUID(), snapshots = accounts.map(accountId => ({ id: accountId, credentialRevision: selectedAccounts.find(account => account.id === accountId)!.credential_revision }));
  const statements = [
    context.db.prepare("UPDATE marketing_campaigns SET status='queued',revision=revision+1,group_ids=?,account_ids=?,account_snapshot=?,relay_revision=?,postal_address=?,interval_seconds=?,scheduled_at=?,next_send_at=?,started_at=?,launch_token=?,last_error=NULL,updated_at=? WHERE id=? AND owner=? AND revision=? AND status='draft'").bind(JSON.stringify(groups), JSON.stringify(accounts), JSON.stringify(snapshots), settings.credential_revision, settings.postal_address, interval, scheduledAt, Math.max(now, scheduledAt || now), now, token, now, id, context.owner, campaign.revision),
    context.db.prepare("INSERT INTO marketing_recipients(id,campaign_id,contact_id,email,name,status,updated_at) SELECT lower(hex(randomblob(16))),?,c.id,c.email,c.name,'pending',? FROM marketing_contacts c WHERE c.owner=? AND c.suppressed=0 AND EXISTS(SELECT 1 FROM marketing_group_members m WHERE m.contact_id=c.id AND m.group_id IN(SELECT value FROM json_each(?))) AND EXISTS(SELECT 1 FROM marketing_campaigns WHERE id=? AND launch_token=?) ON CONFLICT(campaign_id,email) DO NOTHING").bind(id, now, context.owner, JSON.stringify(groups), id, token),
    context.db.prepare("UPDATE marketing_campaigns SET recipient_count=(SELECT COUNT(*) FROM marketing_recipients WHERE campaign_id=?) WHERE id=? AND launch_token=?").bind(id, id, token),
  ];
  const results = await context.db.batch(statements);
  if (results[0].meta.changes !== 1) throw conflict();
  return { campaign: await detail(context, id) };
}
export async function campaignAction(context: Context, id: string, action: string, body: Row) {
  const current = await campaignRow(context, id);
  if (current.revision !== body.revision) throw conflict();
  const allowed: Record<string, string[]> = { pause: ["queued", "running", "needs_attention"], resume: ["paused", "needs_attention"], cancel: ["draft", "queued", "running", "paused", "needs_attention"] };
  if (!allowed[action]?.includes(current.status)) throw new MarketingError("This action does not apply to the current campaign state.", 409);
  if (action === "resume") {
    const settings = await settingsRow(context);
    if (!settings?.relay_verified_at || settings.credential_revision !== current.relay_revision) throw new MarketingError("The SMTP service changed. Duplicate this campaign and review its remaining recipients before a new launch.", 409);
    const snapshots = JSON.parse(current.account_snapshot) as Array<{ id: string; credentialRevision: number }>;
    const matching = (await context.db.prepare("SELECT id,credential_revision FROM smtp_accounts WHERE owner=? AND deleted_at IS NULL AND enabled=1 AND verified_at IS NOT NULL AND id IN(SELECT value FROM json_each(?))").bind(context.owner, current.account_ids).all<Row>()).results;
    if (!matching.some(row => snapshots.some(account => account.id === row.id && account.credentialRevision === row.credential_revision))) throw new MarketingError("Enable a verified original SMTP account to resume the remaining recipients.", 409);
  }
  const status = action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled";
  const now = Date.now();
  const result = await context.db.prepare("UPDATE marketing_campaigns SET status=?,revision=revision+1,last_error=NULL,next_send_at=CASE WHEN ?='queued' THEN MAX(COALESCE(next_send_at,?),?) ELSE next_send_at END,updated_at=? WHERE id=? AND owner=? AND revision=? AND status=?").bind(status, status, now, now, now, id, context.owner, current.revision, current.status).run();
  if (result.meta.changes !== 1) throw conflict();
  return { campaign: await detail(context, id) };
}
export async function recipientPage(context: Context, id: string, cursor: string | null) {
  await campaignRow(context, id);
  if (cursor && !/^[a-f0-9]{32}$/.test(cursor)) throw new MarketingError("Invalid delivery cursor.");
  const rows = (await context.db.prepare("SELECT * FROM marketing_recipients WHERE campaign_id=? AND id>? ORDER BY id LIMIT 101").bind(id, cursor || "").all<Row>()).results;
  return { recipients: rows.slice(0, 100).map(deliveryDto), nextCursor: rows.length > 100 ? rows[99].id : null };
}
export async function testCampaign(context: Context, id: string, body: Row) {
  const campaign = await campaignRow(context, id), account = await accountRow(context, String(body.accountId || ""));
  if (!account.verified_at) throw new MarketingError("Successfully test this SMTP connection first.", 409);
  const target = email(body.email, "test email address");
  if (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId)) throw new MarketingError("Supply a fresh test request ID.");
  const requestDigest = await digest(JSON.stringify([id, campaign.revision, account.id, account.credential_revision, target]));
  const existing = await context.db.prepare("SELECT * FROM marketing_tests WHERE owner=? AND request_id=?").bind(context.owner, body.requestId).first<Row>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new MarketingError("This test request ID was already used for different content. Review the saved test before starting another.", 409);
    if (existing.status === "sending" && existing.updated_at < Date.now() - 180_000) {
      await context.db.prepare("UPDATE marketing_tests SET status='unknown',error='The previous test was interrupted. Check SMTP history before sending another test.',updated_at=? WHERE id=? AND status='sending'").bind(Date.now(), existing.id).run();
      return { delivery: deliveryDto((await context.db.prepare("SELECT * FROM marketing_tests WHERE id=?").bind(existing.id).first<Row>())!) };
    }
    return { delivery: deliveryDto(existing) };
  }
  const settings = await settingsRow(context), connection = await relayConnection(context, settings), credentials = await smtpCredentials(context, account);
  if (!settings?.relay_verified_at || !settings.postal_address) throw new MarketingError("Test the SMTP service and add your business mailing address before sending a test.", 409);
  const testId = crypto.randomUUID(), now = Date.now(), token = crypto.randomUUID();
  const reserved = await context.db.prepare("INSERT INTO marketing_tests(id,owner,request_id,request_digest,email,account_id,status,updated_at) VALUES(?,?,?,?,?,?,'sending',?) ON CONFLICT(owner,request_id) DO NOTHING").bind(testId, context.owner, body.requestId, requestDigest, target, account.id, now).run();
  if (reserved.meta.changes !== 1) {
    const repeated = await context.db.prepare("SELECT * FROM marketing_tests WHERE owner=? AND request_id=?").bind(context.owner, body.requestId).first<Row>();
    if (repeated!.request_digest !== requestDigest) throw conflict();
    return { delivery: deliveryDto(repeated!) };
  }
  const suppressed = await context.db.prepare("SELECT 1 AS ok FROM marketing_contacts WHERE owner=? AND email=? AND suppressed=1").bind(context.owner, target).first<Row>();
  if (suppressed) {
    await context.db.prepare("UPDATE marketing_tests SET status='suppressed',error='This test address is suppressed. No email was sent.',updated_at=? WHERE id=?").bind(Date.now(), testId).run();
    return { delivery: deliveryDto((await context.db.prepare("SELECT * FROM marketing_tests WHERE id=?").bind(testId).first<Row>())!) };
  }
  const claimed = await context.db.prepare("UPDATE smtp_accounts SET sent_today=CASE WHEN sent_day=? THEN sent_today+1 ELSE 1 END,sent_day=?,next_available_at=?,reservation_token=?,send_lease_until=? WHERE id=? AND owner=? AND deleted_at IS NULL AND verified_at IS NOT NULL AND credential_revision=? AND COALESCE(next_available_at,0)<=? AND COALESCE(send_lease_until,0)<=? AND (sent_day<>? OR sent_today<daily_limit)").bind(day(), day(), now + account.min_interval_seconds * 1000, token, now + 180_000, account.id, context.owner, account.credential_revision, now, now, day()).run();
  let outcome;
  if (claimed.meta.changes !== 1) outcome = { status: "failed", messageId: null, error: "The account is cooling down, reached its daily limit, or changed. No test was submitted." };
  else {
    const message = renderMessage(campaign as any, { email: target });
    outcome = await sendRelay(context, connection, { deliveryId: testId, owner: context.owner, account: credentials, message: { ...message, subject: `[Test] ${message.subject}` }, postalAddress: settings.postal_address }, async () => {
      const valid = await context.db.prepare("SELECT 1 AS ok FROM smtp_accounts a JOIN marketing_settings s ON s.owner=a.owner WHERE a.id=? AND a.owner=? AND a.deleted_at IS NULL AND a.verified_at IS NOT NULL AND a.credential_revision=? AND a.reservation_token=? AND a.send_lease_until>? AND s.credential_revision=? AND s.relay_verified_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM marketing_contacts c WHERE c.owner=a.owner AND c.email=? AND c.suppressed=1)").bind(account.id, context.owner, account.credential_revision, token, Date.now(), settings.credential_revision, target).first<Row>();
      return !!valid;
    });
    await releaseAccount(context, account, token, outcome.status !== "not_submitted");
  }
  if (outcome.status === "not_submitted") outcome = { ...outcome, status: "failed" };
  await context.db.prepare("UPDATE marketing_tests SET status=?,message_id=?,error=?,updated_at=? WHERE id=?").bind(outcome.status, outcome.messageId, outcome.error, Date.now(), testId).run();
  return { delivery: deliveryDto((await context.db.prepare("SELECT * FROM marketing_tests WHERE id=?").bind(testId).first<Row>())!) };
}
