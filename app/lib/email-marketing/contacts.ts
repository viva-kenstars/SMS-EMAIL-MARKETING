import { cursorFor, cursorValue, integer, MarketingError, text, type Context, type Row } from "./common";
import type { EmailGroup } from "./types";

export async function groupRow(context: Pick<Context, "db" | "owner">, id: string) {
  const group = await context.db.prepare("SELECT g.*,(SELECT COUNT(*) FROM marketing_group_members m JOIN marketing_contacts c ON c.id=m.contact_id WHERE m.group_id=g.id AND c.owner=g.owner AND c.suppressed=0) AS contact_count FROM marketing_groups g WHERE g.id=? AND g.owner=?").bind(id, context.owner).first<Row>();
  if (!group) throw new MarketingError("Contact group not found in this workspace.", 404);
  return group;
}
export const groupDto = (row: Row): EmailGroup => ({ id: row.id, name: row.name, contactCount: row.contact_count || 0, createdAt: row.created_at, updatedAt: row.updated_at });
export async function listGroups(context: Context, rawCursor: string | null = null) {
  const cursor = cursorValue(rawCursor), params: unknown[] = [context.owner];
  if (cursor) params.push(cursor.t, cursor.t, cursor.id);
  const rows = (await context.db.prepare(`SELECT g.*,(SELECT COUNT(*) FROM marketing_group_members m JOIN marketing_contacts c ON c.id=m.contact_id WHERE m.group_id=g.id AND c.owner=g.owner AND c.suppressed=0) AS contact_count FROM marketing_groups g WHERE g.owner=? ${cursor ? "AND (g.created_at<? OR g.created_at=? AND g.id<?)" : ""} ORDER BY g.created_at DESC,g.id DESC LIMIT 101`).bind(...params).all<Row>()).results;
  const visible = rows.slice(0, 100);
  return { groups: visible.map(groupDto), nextCursor: rows.length > 100 ? cursorFor(visible[visible.length - 1]) : null };
}
export async function createGroup(context: Context, body: Row) {
  const name = text(body.name, "group title", 120);
  if (!name) throw new MarketingError("Give the contact group a title.");
  const id = crypto.randomUUID(), now = Date.now();
  const result = await context.db.prepare("INSERT INTO marketing_groups(id,owner,name,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner,name) DO NOTHING").bind(id, context.owner, name, now, now).run();
  if (result.meta.changes !== 1) throw new MarketingError("A group with this title already exists. Choose the existing group or use a different title.", 409);
  return { group: groupDto(await groupRow(context, id)) };
}
export async function importVerified(context: Context, id: string, body: Row) {
  await groupRow(context, id);
  if (typeof body.jobId !== "string") throw new MarketingError("Choose a completed email verification job.");
  const job = await context.db.prepare("SELECT * FROM email_jobs WHERE id=? AND owner=?").bind(body.jobId, context.owner).first<Row>();
  if (!job) throw new MarketingError("Verification job not found in this workspace.", 404);
  if (job.status !== "completed") throw new MarketingError("Wait for this verification job to complete before importing its verified valid results.", 409);
  const cursor = body.cursor === undefined || body.cursor === null || body.cursor === "" ? 0 : integer(Number(body.cursor), "import cursor", 0);
  const results = (await context.db.prepare("SELECT email,first_position,updated_at FROM email_targets WHERE job_id=? AND status='valid' AND first_position>? ORDER BY first_position LIMIT 501").bind(job.id, cursor).all<Row>()).results;
  const rows = results.slice(0, 500), now = Date.now();
  if (!rows.length) return { group: groupDto(await groupRow(context, id)), imported: 0, skipped: 0, nextCursor: null };
  const payload = JSON.stringify(rows.map(row => [crypto.randomUUID(), row.email, row.updated_at]));
  const changes = await context.db.batch([
    context.db.prepare("INSERT INTO marketing_contacts(id,owner,email,name,verified_at,source_job_id,suppressed,created_at,updated_at) SELECT json_extract(value,'$[0]'),?,json_extract(value,'$[1]'),'',json_extract(value,'$[2]'),?,0,?,? FROM json_each(?) WHERE 1 ON CONFLICT(owner,email) DO UPDATE SET verified_at=MAX(marketing_contacts.verified_at,excluded.verified_at),source_job_id=excluded.source_job_id,updated_at=excluded.updated_at").bind(context.owner, job.id, now, now, payload),
    context.db.prepare("INSERT INTO marketing_group_members(group_id,contact_id,created_at) SELECT ?,c.id,? FROM json_each(?) p CROSS JOIN marketing_contacts c ON c.owner=? AND c.email=json_extract(p.value,'$[1]') WHERE c.suppressed=0 ON CONFLICT(group_id,contact_id) DO NOTHING").bind(id, now, payload, context.owner),
    context.db.prepare("UPDATE marketing_groups SET updated_at=? WHERE id=? AND owner=?").bind(now, id, context.owner),
  ]);
  const imported = changes[1].meta.changes;
  return { group: groupDto(await groupRow(context, id)), imported, skipped: rows.length - imported, nextCursor: results.length > 500 ? String(rows[rows.length - 1].first_position) : null };
}
export async function listContacts(context: Context, groupId: string, cursor: string | null) {
  await groupRow(context, groupId);
  if (cursor && !/^[a-f0-9-]{36}$/.test(cursor)) throw new MarketingError("Invalid contact cursor.");
  const rows = (await context.db.prepare("SELECT c.* FROM marketing_contacts c JOIN marketing_group_members m ON m.contact_id=c.id WHERE m.group_id=? AND c.owner=? AND c.id>? ORDER BY c.id LIMIT 101").bind(groupId, context.owner, cursor || "").all<Row>()).results;
  return { contacts: rows.slice(0, 100).map(row => ({ id: row.id, email: row.email, name: row.name, verifiedAt: row.verified_at, suppressed: !!row.suppressed })), nextCursor: rows.length > 100 ? rows[99].id : null };
}
export async function suppressContact(context: Context, contactId: string) {
  const result = await context.db.prepare("UPDATE marketing_contacts SET suppressed=1,updated_at=? WHERE id=? AND owner=?").bind(Date.now(), contactId, context.owner).run();
  if (result.meta.changes !== 1) throw new MarketingError("Contact not found.", 404);
  return { suppressed: true };
}
