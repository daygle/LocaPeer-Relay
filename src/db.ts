import Database from 'better-sqlite3';
import path from 'path';
import { NostrEvent, Filter } from './types';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'relay.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS tags (
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tags ON tags(name, value);
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig)
  VALUES (@id, @pubkey, @created_at, @kind, @tags, @content, @sig)
`);

const insertTag = db.prepare(`
  INSERT INTO tags (event_id, name, value) VALUES (?, ?, ?)
`);

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

export function getEvents(filters: Filter[]): NostrEvent[] {
  const results = new Map<string, NostrEvent>();
  const limit = Math.min(
    filters.reduce((m, f) => Math.min(m, f.limit ?? 500), 500),
    500
  );

  for (const filter of filters) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.ids?.length) {
      conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    if (filter.authors?.length) {
      conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.since != null) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until != null) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    const tagFilters = Object.entries(filter).filter(([k]) => k.startsWith('#') && k.length === 2);
    const tagJoins: string[] = [];
    tagFilters.forEach(([key, vals], i) => {
      const tagName = key.slice(1);
      const alias = `t${i}`;
      const values = vals as string[];
      tagJoins.push(
        `JOIN tags ${alias} ON ${alias}.event_id = e.id AND ${alias}.name = '${tagName}' AND ${alias}.value IN (${values.map(() => '?').join(',')})`
      );
      params.push(...values);
    });

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT e.* FROM events e ${tagJoins.join(' ')} ${where} ORDER BY e.created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as (Omit<NostrEvent, 'tags'> & { tags: string })[];
    for (const row of rows) {
      if (!results.has(row.id)) {
        results.set(row.id, { ...row, tags: JSON.parse(row.tags) });
      }
    }
  }

  return [...results.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

export function eventExists(id: string): boolean {
  const row = db.prepare('SELECT 1 FROM events WHERE id = ?').get(id);
  return row != null;
}
