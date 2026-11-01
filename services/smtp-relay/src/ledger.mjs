import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './security.mjs';

export class Ledger {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        owner TEXT NOT NULL, delivery_id TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('attempting','accepted','failed','unknown','suppressed')),
        message_id TEXT, error TEXT, code TEXT, scope TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner, delivery_id));
      CREATE TABLE IF NOT EXISTS suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, email TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(owner,email));
      CREATE INDEX IF NOT EXISTS suppressions_owner_id ON suppressions(owner,id);
    `);
    const columns=this.db.prepare('PRAGMA table_info(deliveries)').all().map(row=>row.name);
    if(!columns.includes('code'))this.db.exec('ALTER TABLE deliveries ADD COLUMN code TEXT');
    if(!columns.includes('scope'))this.db.exec('ALTER TABLE deliveries ADD COLUMN scope TEXT');
    // Never release an interrupted intent for another send. Safe under multiple
    // processes too: a surviving sender may later finalize its existing intent.
    this.db.prepare("UPDATE deliveries SET state='unknown',code='smtp_unknown',error=?,updated_at=? WHERE state='attempting'")
      .run('Delivery outcome is uncertain. Check the SMTP provider before any manual resend.', new Date().toISOString());
  }
  claim(owner, id, digest) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM deliveries WHERE owner=? AND delivery_id=?').get(owner,id);
      if (row) {
        if (row.digest !== digest) throw new HttpError(409, 'This delivery ID already belongs to a different request.');
        this.db.exec('COMMIT');
        return {claimed:false, result:this.result(row)};
      }
      this.db.prepare("INSERT INTO deliveries(owner,delivery_id,digest,state,created_at,updated_at) VALUES(?,?,?,'attempting',?,?)").run(owner,id,digest,now,now);
      this.db.exec('COMMIT');
      return {claimed:true};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  result(row) {
    const status = row.state === 'attempting' ? 'unknown' : row.state;
    return {status, ...(row.message_id ? {messageId:row.message_id} : {}), ...(row.code?{code:row.code}:status==='unknown'?{code:'smtp_unknown'}:{}), ...(row.scope?{scope:row.scope}:{}), ...(row.error ? {error:row.error} : status === 'unknown' ? {error:'Delivery is in progress or uncertain. It will not be submitted again.'} : {})};
  }
  finish(owner, id, result) {
    this.db.prepare('UPDATE deliveries SET state=?,message_id=?,error=?,code=?,scope=?,updated_at=? WHERE owner=? AND delivery_id=?')
      .run(result.status,result.messageId??null,result.error??null,result.code??null,result.scope??null,new Date().toISOString(),owner,id);
    return result;
  }
  suppressed(owner, address) { return !!this.db.prepare('SELECT 1 FROM suppressions WHERE owner=? AND email=?').get(owner,address); }
  suppress(owner, address) { this.db.prepare('INSERT OR IGNORE INTO suppressions(owner,email,created_at) VALUES(?,?,?)').run(owner,address,new Date().toISOString()); }
  listSuppressions(owner, cursor = '0', limit = 100) {
    if (!/^\d{1,16}$/.test(String(cursor)) || !Number.isSafeInteger(Number(cursor))) throw new HttpError(400,'Invalid cursor.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400,'Limit must be 1–500.');
    const rows = this.db.prepare('SELECT id,email,created_at FROM suppressions WHERE owner=? AND id>? ORDER BY id LIMIT ?').all(owner,Number(cursor),limit+1);
    const items = rows.slice(0,limit);
    return {items:items.map(row=>({email:row.email,createdAt:row.created_at})),nextCursor:rows.length>limit?String(items.at(-1).id):null};
  }
  close() { this.db.close(); }
}
