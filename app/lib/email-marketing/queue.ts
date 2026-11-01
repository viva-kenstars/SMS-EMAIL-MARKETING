import { relayConnection, releaseAccount, settingsRow, smtpCredentials } from "./accounts";
import { assertKey, day, nextDay, type Context, type Row } from "./common";
import { renderMessage } from "./content";
import { sendRelay } from "./relay";

const LEASE_MS = 180_000;
type Options = { owner?: string; campaignId?: string; fetch?: typeof globalThis.fetch };
async function attention(db: D1Database, campaign: Row, message: string) {
  await db.prepare("UPDATE marketing_campaigns SET status='needs_attention',last_error=?,updated_at=? WHERE id=? AND lease_token=? AND status IN('queued','running')").bind(message, Date.now(), campaign.id, campaign.lease_token).run();
}
async function finishIfEmpty(db: D1Database, campaign: Row) {
  await db.prepare("UPDATE marketing_campaigns SET status='completed',completed_at=?,next_send_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_token=? AND status IN('queued','running') AND NOT EXISTS(SELECT 1 FROM marketing_recipients WHERE campaign_id=? AND status IN('pending','sending'))").bind(Date.now(), Date.now(), campaign.id, campaign.lease_token, campaign.id).run();
}
async function advanceCampaign(db: D1Database, key: string, campaign: Row, fetcher?: typeof fetch) {
  const context: Context = { db, owner: campaign.owner, masterKey: key, fetch: fetcher };
  // A new lease cannot infer whether an interrupted SMTP operation was accepted.
  const recovered = await db.prepare("UPDATE marketing_recipients SET status='unknown',error='The previous sending operation stopped before its acknowledgement was saved. Check SMTP history; this address will not be retried automatically.',updated_at=? WHERE campaign_id=? AND status='sending'").bind(Date.now(), campaign.id).run();
  if (recovered.meta.changes) { await attention(db, campaign, "An interrupted SMTP operation needs review. Uncertain recipients will not be resent; resume only the remaining pending recipients."); return; }
  await db.prepare("UPDATE marketing_recipients SET status='suppressed',error='This contact was suppressed before dispatch.',updated_at=? WHERE campaign_id=? AND status='pending' AND EXISTS(SELECT 1 FROM marketing_contacts c WHERE c.id=marketing_recipients.contact_id AND c.suppressed=1)").bind(Date.now(), campaign.id).run();
  const recipient = await db.prepare("SELECT * FROM marketing_recipients WHERE campaign_id=? AND status='pending' ORDER BY id LIMIT 1").bind(campaign.id).first<Row>();
  if (!recipient) { await finishIfEmpty(db, campaign); return; }
  const settings = await settingsRow(context);
  if (!settings?.relay_verified_at || settings.credential_revision !== campaign.relay_revision) { await attention(db, campaign, "The SMTP service changed. Review its settings before preparing a new campaign for the remaining contacts."); return; }
  const connection = await relayConnection(context, settings);
  const snapshots = JSON.parse(campaign.account_snapshot) as Array<{ id: string; credentialRevision: number }>;
  const accounts = (await db.prepare("SELECT * FROM smtp_accounts WHERE owner=? AND deleted_at IS NULL AND enabled=1 AND verified_at IS NOT NULL AND id IN(SELECT value FROM json_each(?))").bind(campaign.owner, campaign.account_ids).all<Row>()).results;
  const eligible = new Map(accounts.filter(row => snapshots.some(saved => saved.id === row.id && saved.credentialRevision === row.credential_revision)).map(row => [row.id, row]));
  if (!eligible.size) { await attention(db, campaign, "Every selected SMTP account is off, unverified or changed. Enable a verified original account to resume."); return; }
  let chosen: Row | null = null, due = Number.MAX_SAFE_INTEGER;
  for (let offset = 0; offset < snapshots.length; offset++) {
    const index = (campaign.rotation_index + offset) % snapshots.length, account = eligible.get(snapshots[index].id);
    if (!account) continue;
    const now = Date.now();
    const available = Math.max(account.next_available_at || 0, account.send_lease_until || 0, account.sent_day === day() && account.sent_today >= account.daily_limit ? nextDay() : 0);
    due = Math.min(due, available);
    if (available > now) continue;
    const token = crypto.randomUUID();
    // D1 batch is transactional. A shared account reservation prevents overlapping
    // campaigns from exceeding that account's interval or UTC daily attempt cap.
    const result = await db.batch([
      db.prepare("UPDATE smtp_accounts SET sent_today=CASE WHEN sent_day=? THEN sent_today+1 ELSE 1 END,sent_day=?,next_available_at=?,reservation_token=?,send_lease_until=? WHERE id=? AND owner=? AND deleted_at IS NULL AND enabled=1 AND verified_at IS NOT NULL AND credential_revision=? AND COALESCE(next_available_at,0)<=? AND COALESCE(send_lease_until,0)<=? AND (sent_day<>? OR sent_today<daily_limit) AND EXISTS(SELECT 1 FROM marketing_campaigns WHERE id=? AND lease_token=? AND status='running') AND EXISTS(SELECT 1 FROM marketing_recipients WHERE id=? AND status='pending')").bind(day(), day(), now + account.min_interval_seconds * 1000, token, now + LEASE_MS, account.id, campaign.owner, account.credential_revision, now, now, day(), campaign.id, campaign.lease_token, recipient.id),
      db.prepare("UPDATE marketing_recipients SET status='sending',account_id=?,account_revision=?,attempted_at=?,updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM smtp_accounts WHERE id=? AND reservation_token=?) AND EXISTS(SELECT 1 FROM marketing_campaigns WHERE id=? AND lease_token=? AND status='running')").bind(account.id, account.credential_revision, now, now, recipient.id, account.id, token, campaign.id, campaign.lease_token),
      db.prepare("UPDATE marketing_campaigns SET next_send_at=?,rotation_index=?,updated_at=? WHERE id=? AND lease_token=? AND status='running' AND EXISTS(SELECT 1 FROM smtp_accounts WHERE id=? AND reservation_token=?) AND EXISTS(SELECT 1 FROM marketing_recipients WHERE id=? AND status='sending' AND account_id=?)").bind(now + campaign.interval_seconds * 1000, (index + 1) % snapshots.length, now, campaign.id, campaign.lease_token, account.id, token, recipient.id, account.id),
    ]);
    if (result[0].meta.changes === 1 && result[1].meta.changes === 1) { chosen = { ...account, reservation_token: token }; break; }
  }
  if (!chosen) {
    await db.prepare("UPDATE marketing_campaigns SET next_send_at=?,updated_at=? WHERE id=? AND lease_token=? AND status='running'").bind(Math.max(Date.now() + 1000, due === Number.MAX_SAFE_INTEGER ? Date.now() + 5000 : due), Date.now(), campaign.id, campaign.lease_token).run();
    return;
  }
  let credentials;
  try { credentials = await smtpCredentials(context, chosen); }
  catch {
    await db.prepare("UPDATE marketing_recipients SET status='pending',account_id=NULL,account_revision=NULL,attempted_at=NULL,error=NULL WHERE id=? AND status='sending'").bind(recipient.id).run();
    await attention(db, campaign, "The chosen SMTP account could not be opened. Replace and test its credentials.");
    await releaseAccount(context, chosen, chosen.reservation_token, false);
    return;
  }
  const outcome = await sendRelay(context, connection, {
    deliveryId: recipient.id, owner: campaign.owner, account: credentials,
    message: renderMessage(campaign as any, { email: recipient.email, name: recipient.name }), postalAddress: campaign.postal_address,
  }, async () => {
    const valid = await db.prepare("SELECT 1 AS ok FROM marketing_campaigns c JOIN smtp_accounts a ON a.id=? JOIN marketing_contacts contact ON contact.id=? WHERE c.id=? AND c.lease_token=? AND c.status='running' AND a.owner=c.owner AND a.deleted_at IS NULL AND a.enabled=1 AND a.verified_at IS NOT NULL AND a.credential_revision=? AND a.reservation_token=? AND a.send_lease_until>? AND contact.suppressed=0 AND EXISTS(SELECT 1 FROM marketing_settings s WHERE s.owner=c.owner AND s.credential_revision=c.relay_revision)").bind(chosen!.id, recipient.contact_id, campaign.id, campaign.lease_token, chosen!.credential_revision, chosen!.reservation_token, Date.now()).first<Row>();
    return !!valid;
  });
  await releaseAccount(context, chosen, chosen.reservation_token, outcome.status !== "not_submitted");
  if (outcome.status === "not_submitted") {
    await db.prepare("UPDATE marketing_recipients SET status='pending',account_id=NULL,account_revision=NULL,attempted_at=NULL,error=NULL,updated_at=? WHERE id=? AND status='sending'").bind(Date.now(), recipient.id).run();
    await attention(db, campaign, outcome.error || "Sending stopped before SMTP submission. Review the account and resume pending recipients.");
    return;
  }
  await db.prepare("UPDATE marketing_recipients SET status=?,message_id=?,error=?,updated_at=? WHERE id=? AND status IN('sending','unknown') AND account_id=? AND account_revision=?").bind(outcome.status, outcome.messageId, outcome.error, Date.now(), recipient.id, chosen.id, chosen.credential_revision).run();
  await db.prepare("UPDATE marketing_campaigns SET next_send_at=MAX(COALESCE(next_send_at,0),?) WHERE id=? AND lease_token=?").bind(Date.now() + campaign.interval_seconds * 1000, campaign.id, campaign.lease_token).run();
  if (outcome.status === "suppressed") await db.prepare("UPDATE marketing_contacts SET suppressed=1,updated_at=? WHERE id=? AND owner=?").bind(Date.now(), recipient.contact_id, campaign.owner).run();
  if (outcome.status === "failed" || outcome.status === "unknown") {
    await db.prepare("UPDATE smtp_accounts SET last_error=? WHERE id=? AND owner=? AND credential_revision=?").bind(outcome.error, chosen.id, campaign.owner, chosen.credential_revision).run();
    await attention(db, campaign, outcome.status === "unknown" ? "SMTP acceptance is uncertain. Check its history; this address will not be retried. Resume only the remaining pending recipients after review." : "SMTP rejected a message. Check the account and recipient report before resuming the remaining contacts.");
  } else await finishIfEmpty(db, campaign);
}
export async function advanceMarketingQueue(db: D1Database, masterKey?: string, options: Options = {}) {
  assertKey(masterKey);
  const now = Date.now(), token = crypto.randomUUID(), params: unknown[] = [];
  let filter = "";
  if (options.owner) { filter += " AND owner=?"; params.push(options.owner); }
  if (options.campaignId) { filter += " AND id=?"; params.push(options.campaignId); }
  const campaign = await db.prepare(`UPDATE marketing_campaigns SET status='running',lease_token=?,lease_until=? WHERE id=(SELECT id FROM marketing_campaigns WHERE status IN('queued','running') AND started_at IS NOT NULL AND COALESCE(next_send_at,0)<=? AND (lease_until IS NULL OR lease_until<?) ${filter} ORDER BY COALESCE(next_send_at,0),created_at LIMIT 1) AND status IN('queued','running') AND (lease_until IS NULL OR lease_until<?) RETURNING *`).bind(token, now + LEASE_MS, now, now, ...params, now).first<Row>();
  if (campaign) {
    try { await advanceCampaign(db, masterKey, campaign, options.fetch); }
    catch { await attention(db, campaign, "The sending worker could not finish this step. Saved progress has been retained; check the report before resuming."); }
    finally { await db.prepare("UPDATE marketing_campaigns SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(campaign.id, token).run(); }
  }
  const next = await db.prepare(`SELECT MIN(MAX(COALESCE(next_send_at,0),COALESCE(lease_until,0))) AS due FROM marketing_campaigns WHERE status IN('queued','running')${options.owner ? " AND owner=?" : ""}`).bind(...(options.owner ? [options.owner] : [])).first<Row>();
  return { advanced: campaign ? 1 : 0, nextDueAt: next?.due ?? null };
}
