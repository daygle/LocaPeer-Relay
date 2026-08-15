import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { NostrEvent, Filter } from './types';
import { isTagFilterKey } from './filter';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'relay.db');

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

const MAX_LIMIT = 500;

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
    const limit = Math.min(filter.limit ?? MAX_LIMIT, MAX_LIMIT);
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
    .slice(0, MAX_LIMIT);
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
