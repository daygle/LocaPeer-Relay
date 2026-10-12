import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { NostrEvent, Filter } from './types';
import { isTagFilterKey } from './filter';

export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'relay.db');

// Ensure the database directory exists before better-sqlite3 tries to open the file.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL,
    sig TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_kind_created ON events(kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_pubkey_created ON events(pubkey, created_at);

  CREATE TABLE IF NOT EXISTS tags (
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tags ON tags(name, value);

  CREATE TABLE IF NOT EXISTS conn_leases (
    token TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    ip TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conn_leases_expires ON conn_leases(expires_at);

  CREATE TABLE IF NOT EXISTS ip_state (
    ip TEXT PRIMARY KEY,
    tokens REAL NOT NULL,
    last_refill INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    ip TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS bans (
    ip TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    strikes INTEGER NOT NULL,
    ban_count INTEGER NOT NULL,
    banned_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bans_expires ON bans(expires_at);
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig)
  VALUES (@id, @pubkey, @created_at, @kind, @tags, @content, @sig)
`);

const insertTag = db.prepare(`
  INSERT INTO tags (event_id, name, value) VALUES (?, ?, ?)
`);

// Cache prepared statements so repeated REQ shapes don't recompile SQL.
// The explicit instantiation keeps the statement type concrete so `.all(...)`
// accepts spread arguments.
type Prepared = ReturnType<typeof db.prepare<unknown[], unknown>>;
const stmtCache = new Map<string, Prepared>();

function prepare(sql: string): Prepared {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    if (stmtCache.size >= 128) stmtCache.clear();
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

const storeEvent = db.transaction((event: NostrEvent) => {
  const result = insertEvent.run({
    ...event,
    tags: JSON.stringify(event.tags),
  });
  if (result.changes > 0) {
    for (const tag of event.tags) {
      if (tag.length >= 2 && tag[0].length === 1) {
        insertTag.run(event.id, tag[0], tag[1]);
      }
    }
  }
  return result.changes > 0;
});

export function saveEvent(event: NostrEvent): boolean {
  return storeEvent(event) as boolean;
}

// LocaPeer's heartbeat catch-up asks for up to 1000 events in one REQ; a
// lower cap would silently drop the oldest part of an offline gap.
export const MAX_QUERY_LIMIT = 1000;

// NIP-01 allows ids and authors to be full 64-char hex values or prefixes.
// Full-length values use an exact IN lookup (index-friendly); shorter values
// match by prefix. Multiple candidates are OR'd together to match the
// in-memory matcher in relay.ts.
function buildPrefixCondition(column: string, values: string[] | undefined): { sql: string; params: (string | number)[] } | null {
  if (!values?.length) return null;
  const conds: string[] = [];
  const params: (string | number)[] = [];
  const exact = values.filter((v) => v.length === 64);
  if (exact.length) {
    conds.push(`${column} IN (${exact.map(() => '?').join(',')})`);
    params.push(...exact);
  }
  for (const prefix of values.filter((v) => v.length !== 64)) {
    conds.push(`substr(${column}, 1, ${prefix.length}) = ?`);
    params.push(prefix);
  }
  return { sql: `(${conds.join(' OR ')})`, params };
}

export function getEvents(filters: Filter[]): NostrEvent[] {
  const results = new Map<string, NostrEvent>();

  for (const filter of filters) {
    const limit = Math.min(filter.limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const conditions: string[] = [];
    // Params for the JOIN clauses and the WHERE clause are collected
    // separately because JOINs appear before WHERE in the SQL text, and
    // positional placeholders are bound in that textual order.
    const joinParams: (string | number)[] = [];
    const whereParams: (string | number)[] = [];

    const idCond = buildPrefixCondition('id', filter.ids);
    if (idCond) {
      conditions.push(idCond.sql);
      whereParams.push(...idCond.params);
    }
    const authorCond = buildPrefixCondition('pubkey', filter.authors);
    if (authorCond) {
      conditions.push(authorCond.sql);
      whereParams.push(...authorCond.params);
    }
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      whereParams.push(...filter.kinds);
    }
    if (filter.since != null) {
      conditions.push('created_at >= ?');
      whereParams.push(filter.since);
    }
    if (filter.until != null) {
      conditions.push('created_at <= ?');
      whereParams.push(filter.until);
    }

    const tagFilters = Object.entries(filter).filter(([k]) => isTagFilterKey(k));
    const tagJoins: string[] = [];
    tagFilters.forEach(([key, vals], i) => {
      const tagName = key.slice(1);
      const alias = `t${i}`;
      const values = vals as string[];
      tagJoins.push(
        `JOIN tags ${alias} ON ${alias}.event_id = e.id AND ${alias}.name = ? AND ${alias}.value IN (${values.map(() => '?').join(',')})`
      );
      joinParams.push(tagName, ...values);
    });

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT e.* FROM events e ${tagJoins.join(' ')} ${where} ORDER BY e.created_at DESC LIMIT ?`;
    const params = [...joinParams, ...whereParams, limit];

    const rows = prepare(sql).all(...params) as (Omit<NostrEvent, 'tags'> & { tags: string })[];
    for (const row of rows) {
      if (!results.has(row.id)) {
        results.set(row.id, { ...row, tags: JSON.parse(row.tags) });
      }
    }
  }

  return [...results.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_QUERY_LIMIT);
}

// ---------------------------------------------------------------------------
// NIP-09 event deletion
//
// A kind-5 event deletes the events its "e" tags reference, but only those
// signed by the same pubkey. The kind-5 event itself is kept (LocaPeer
// replays deletions to devices that were offline when they were sent), and a
// deleted event re-published later is refused.
// ---------------------------------------------------------------------------

export const DELETION_KIND = 5;

const deleteReferencedEvent = db.prepare(
  `DELETE FROM events WHERE id = ? AND pubkey = ? AND kind != ${DELETION_KIND}`
);
const deletionExists = db.prepare(`
  SELECT 1 FROM tags t JOIN events e ON e.id = t.event_id
  WHERE t.name = 'e' AND t.value = ? AND e.kind = ${DELETION_KIND} AND e.pubkey = ?
  LIMIT 1
`);

export const applyDeletion = db.transaction((event: NostrEvent): number => {
  let deleted = 0;
  for (const tag of event.tags) {
    if (tag[0] === 'e' && typeof tag[1] === 'string') {
      deleted += deleteReferencedEvent.run(tag[1], event.pubkey).changes;
    }
  }
  return deleted;
}) as (event: NostrEvent) => number;

export function isDeleted(event: NostrEvent): boolean {
  if (event.kind === DELETION_KIND) return false;
  return deletionExists.get(event.id, event.pubkey) != null;
}

export function eventExists(id: string): boolean {
  const row = db.prepare('SELECT 1 FROM events WHERE id = ?').get(id);
  return row != null;
}

// ---------------------------------------------------------------------------
// Global connection leases
//
// Multiple relay processes sharing the same database coordinate a total
// connection cap through a lease table (SQLite WAL mode is multi-process
// safe). Each connection holds a row with an expiry; rows left behind by a
// crashed process expire naturally and are purged on the next acquire.
// ---------------------------------------------------------------------------

const connLeaseInsert = db.prepare(`
  INSERT OR REPLACE INTO conn_leases (token, pid, ip, expires_at)
  VALUES (?, ?, ?, ?)
`);
const connLeasePurge = db.prepare('DELETE FROM conn_leases WHERE expires_at <= ?');
const connLeaseCount = db.prepare('SELECT COUNT(*) AS n FROM conn_leases WHERE expires_at > ?');
const connLeaseCountByIp = db.prepare('SELECT COUNT(*) AS n FROM conn_leases WHERE ip = ? AND expires_at > ?');
const connLeaseRemove = db.prepare('DELETE FROM conn_leases WHERE token = ?');
const connLeaseRenew = db.prepare('UPDATE conn_leases SET expires_at = ? WHERE token = ?');

const ipStateGet = db.prepare('SELECT tokens, last_refill FROM ip_state WHERE ip = ?');
const ipStateUpsert = db.prepare(`
  INSERT INTO ip_state (ip, tokens, last_refill) VALUES (?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET tokens = excluded.tokens, last_refill = excluded.last_refill
`);
const ipStatePrune = db.prepare('DELETE FROM ip_state WHERE last_refill < ?');

export type LeaseAcquireResult = 'ok' | 'max-connections' | 'max-per-ip';

export interface LeaseRequest {
  token: string;
  pid: number;
  ip: string;
  ttlMs: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
}

// Runs in a write transaction so concurrent processes see a consistent count.
// Enforces both the global cap and the per-IP concurrent cap in one atomic
// step; per-IP counts come from live (unexpired) leases, so a crashed
// process's connections stop counting once their leases expire.
export function acquireConnectionLease(req: LeaseRequest): LeaseAcquireResult {
  return db.transaction(() => {
    const now = Date.now();
    connLeasePurge.run(now);
    const total = (connLeaseCount.get(now) as { n: number }).n;
    if (total >= req.maxConnections) return 'max-connections';
    const byIp = (connLeaseCountByIp.get(req.ip, now) as { n: number }).n;
    if (byIp >= req.maxConnectionsPerIp) return 'max-per-ip';
    connLeaseInsert.run(req.token, req.pid, req.ip, now + req.ttlMs);
    return 'ok';
  })();
}

export function renewConnectionLease(token: string, ttlMs: number): void {
  connLeaseRenew.run(Date.now() + ttlMs, token);
}

export function releaseConnectionLease(token: string): void {
  connLeaseRemove.run(token);
}

// Cross-process per-IP token bucket for connection attempts. The bucket state
// lives in the shared database, so all relay processes throttle the same
// address together. A token is consumed per accepted attempt (attempts that
// fail the concurrent/global caps still burn a token).
export function tryAcquireIpRate(ip: string, rate: number, burst: number): boolean {
  return db.transaction(() => {
    const now = Date.now();
    const row = ipStateGet.get(ip) as { tokens: number; last_refill: number } | undefined;
    const tokens = row
      ? Math.min(burst, row.tokens + ((now - row.last_refill) / 1000) * rate)
      : burst;
    if (tokens < 1) {
      // Persist the refilled-but-still-empty bucket so a throttled IP stays
      // throttled across processes.
      ipStateUpsert.run(ip, tokens, now);
      return false;
    }
    ipStateUpsert.run(ip, tokens - 1, now);
    return true;
  })();
}

// Drop state for IPs that have been idle long enough that their bucket would
// have refilled to full anyway; keeps the table bounded.
export function pruneIpState(olderThan: number): void {
  ipStatePrune.run(olderThan);
}

// ---------------------------------------------------------------------------
// Admin settings
//
// Key/value settings editable through the admin panel. The relay seeds each
// key from its environment variable (for backwards compatibility), then the
// database overrides it once a value is changed through the admin API.
// ---------------------------------------------------------------------------

const settingGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const settingSet = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const settingAll = db.prepare('SELECT key, value FROM settings');
const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events');

export function getSettingValue(key: string): string | undefined {
  const row = settingGet.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSettingValue(key: string, value: string): void {
  settingSet.run(key, value);
}

export function getSettingsRows(): Array<[string, string]> {
  return (settingAll.all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]);
}

// Stats helpers for the admin panel.
export function countEvents(): number {
  return (eventCount.get() as { n: number }).n;
}

export function getDbSizeBytes(): number {
  try {
    return fs.statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Event retention pruning
// ---------------------------------------------------------------------------

const deleteOldEvents = db.prepare(`
  DELETE FROM events WHERE created_at < ?
`);

export function pruneOldEvents(olderThanSeconds: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  const result = deleteOldEvents.run(cutoff);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const insertAudit = db.prepare(
  'INSERT INTO audit_log (ts, action, ip, detail) VALUES (?, ?, ?, ?)'
);
const recentAudit = db.prepare(
  'SELECT ts, action, ip, detail FROM audit_log ORDER BY id DESC LIMIT ?'
);
const pruneAudit = db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1000)');

export function auditLog(action: string, ip: string | null, detail: string | null): void {
  insertAudit.run(Math.floor(Date.now() / 1000), action, ip, detail);
  // Keep the table bounded.
  pruneAudit.run();
}

export function getAuditLog(limit: number = 100): Array<{ ts: number; action: string; ip: string | null; detail: string | null }> {
  return recentAudit.all(Math.min(limit, 500)) as Array<{ ts: number; action: string; ip: string | null; detail: string | null }>;
}


// ---------------------------------------------------------------------------
// IP bans
//
// Bans live in the shared database so every relay process (and a restart)
// honours them. Expired rows are kept for BAN_MEMORY_MS so a repeat offender
// gets a longer ban; a manual unban deletes the row and resets that history.
// ---------------------------------------------------------------------------

const BAN_MEMORY_MS = 7 * 24 * 60 * 60_000;

export interface BanRow {
  ip: string;
  reason: string;
  strikes: number;
  banCount: number;
  bannedAt: number;
  expiresAt: number;
}

const banGet = db.prepare('SELECT ban_count, expires_at FROM bans WHERE ip = ?');
const banUpsert = db.prepare(`
  INSERT INTO bans (ip, reason, strikes, ban_count, banned_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, strikes = excluded.strikes,
    ban_count = excluded.ban_count, banned_at = excluded.banned_at, expires_at = excluded.expires_at
`);
const banActive = db.prepare('SELECT 1 FROM bans WHERE ip = ? AND expires_at > ?');
const banListActive = db.prepare(`
  SELECT ip, reason, strikes, ban_count AS banCount, banned_at AS bannedAt, expires_at AS expiresAt
  FROM bans WHERE expires_at > ? ORDER BY banned_at DESC
`);
const banCountActive = db.prepare('SELECT COUNT(*) AS n FROM bans WHERE expires_at > ?');
const banDelete = db.prepare('DELETE FROM bans WHERE ip = ?');
const banPrune = db.prepare('DELETE FROM bans WHERE expires_at <= ?');

// Ban (or re-ban) an IP. Each ban within BAN_MEMORY_MS of the previous one
// doubles the duration, capped at maxMs. Returns the stored row.
export const banIp = db.transaction(
  (ip: string, reason: string, strikes: number, baseMs: number, maxMs: number): BanRow => {
    const now = Date.now();
    const prev = banGet.get(ip) as { ban_count: number; expires_at: number } | undefined;
    const banCount = prev && prev.expires_at > now - BAN_MEMORY_MS ? prev.ban_count + 1 : 1;
    const duration = Math.min(baseMs * 2 ** (banCount - 1), Math.max(baseMs, maxMs));
    const expiresAt = now + duration;
    banUpsert.run(ip, reason, strikes, banCount, now, expiresAt);
    return { ip, reason, strikes, banCount, bannedAt: now, expiresAt };
  }
) as (ip: string, reason: string, strikes: number, baseMs: number, maxMs: number) => BanRow;

export function isIpBanned(ip: string): boolean {
  return banActive.get(ip, Date.now()) != null;
}

export function listActiveBans(): BanRow[] {
  return banListActive.all(Date.now()) as BanRow[];
}

export function countActiveBans(): number {
  return (banCountActive.get(Date.now()) as { n: number }).n;
}

export function unbanIp(ip: string): boolean {
  return banDelete.run(ip).changes > 0;
}

export function pruneBans(): void {
  banPrune.run(Date.now() - BAN_MEMORY_MS);
}
