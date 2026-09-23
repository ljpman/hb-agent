import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(filename = ':memory:') {
    this.transactionDepth = 0;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, tenant TEXT NOT NULL, owner TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS records_scope ON records(kind,tenant,owner);
      CREATE TABLE IF NOT EXISTS artifacts (job_id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (
        tenant TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
        request_hash TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(tenant,owner,key)
      );
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, actor TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_leases (
        job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
        expires INTEGER NOT NULL, heartbeat INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_resources (
        resource_key TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, acquired_at INTEGER NOT NULL
      );
    `);
  }
  put(kind, value) {
    this.db.prepare('INSERT INTO records(kind,id,tenant,owner,value) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, value.id, value.tenantId, value.ownerId, JSON.stringify(value));
    return value;
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.value) : null;
  }
  list(kind, actor) {
    const rows = actor
      ? actor.role === 'operator'
        ? this.db.prepare('SELECT value FROM records WHERE kind=? AND tenant=? ORDER BY rowid DESC').all(kind, actor.tenantId)
        : this.db.prepare('SELECT value FROM records WHERE kind=? AND tenant=? AND owner=? ORDER BY rowid DESC').all(kind, actor.tenantId, actor.id)
      : this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid DESC').all(kind);
    return rows.map(r => JSON.parse(r.value));
  }
  transaction(fn) {
    const nested = this.transactionDepth > 0;
    const savepoint = `hb_transaction_${this.transactionDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally { this.transactionDepth--; }
  }
  lease(jobId) { return this.db.prepare('SELECT * FROM job_leases WHERE job_id=?').get(jobId); }
  renewLease(lease, now, duration) {
    return this.db.prepare('UPDATE job_leases SET expires=?, heartbeat=? WHERE job_id=? AND owner=? AND token=? AND expires>?')
      .run(now + duration, now, lease.job_id, lease.owner, lease.token, now).changes === 1;
  }
  releaseLease(lease) {
    this.db.prepare('DELETE FROM job_leases WHERE job_id=? AND owner=? AND token=?').run(lease.job_id, lease.owner, lease.token);
  }
  artifact(jobId, bytes) { this.db.prepare('INSERT OR REPLACE INTO artifacts(job_id,bytes) VALUES(?,?)').run(jobId, bytes); }
  readArtifact(jobId) { const row = this.db.prepare('SELECT bytes FROM artifacts WHERE job_id=?').get(jobId); return row ? Buffer.from(row.bytes) : null; }
  close() { this.db.close(); }
}
