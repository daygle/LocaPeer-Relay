import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomBytes } from 'crypto';
import { saveEvent, getEvents, eventExists, acquireConnectionLease, renewConnectionLease, releaseConnectionLease, tryAcquireIpRate, pruneIpState, LeaseAcquireResult } from './db';
import { validateEvent, verifyEventId, verifySignature, serializeEvent } from './verify';
import { isTagFilterKey } from './filter';
import { NostrEvent, Filter, Subscription } from './types';
import { settings } from './settings';
import { log, error } from './log';

// Maximum consecutive rate-limit violations before a connection is closed.
const RATE_LIMIT_MAX_VIOLATIONS = 10;

// Connection leases: a row per accepted connection with an expiry, renewed
// periodically. Expired rows (crashed processes) are purged on the next
// acquire, so a hard-killed relay eventually frees its slots.
const CONN_LEASE_TTL_MS = 60_000;
const CONN_LEASE_HEARTBEAT_MS = 20_000;

// How often to prune idle per-IP rate state from the database.
const IP_STATE_PRUNE_INTERVAL_MS = 60_000;
const IP_STATE_IDLE_MS = 5 * 60_000;

interface Client {
  ws: WebSocket;
  subs: Map<string, Subscription>;
  ip: string;
  tokens: number;
  lastRefill: number;
  violations: number;
  // False between a ping and the client's pong; the keepalive loop terminates
  // clients that fail to answer.
  alive: boolean;
}

const clients = new Set<Client>();
const clientLeases = new Map<Client, string>();
let lastIpStatePrune = 0;
let maxConnectionsSeen = 0;

// Emitted whenever live stats change (connection open/close, event stored)
// so the admin panel can push instant updates over Server-Sent Events.
export const relayEvents = new EventEmitter();

function send(ws: WebSocket, msg: unknown[]): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// NIP-01 allows ids and authors to be full 64-char hex values or prefixes.
function matchesHexFilter(value: string, candidates: string[]): boolean {
  return candidates.some((c) => value.startsWith(c));
}

function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids?.length && !matchesHexFilter(event.id, filter.ids)) return false;
  if (filter.authors?.length && !matchesHexFilter(event.pubkey, filter.authors)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.since != null && event.created_at < filter.since) return false;
  if (filter.until != null && event.created_at > filter.until) return false;

  for (const [key, vals] of Object.entries(filter)) {
    if (!isTagFilterKey(key)) continue;
    const tagName = key.slice(1);
    const values = vals as string[];
    const found = event.tags.some(t => t[0] === tagName && values.includes(t[1]));
    if (!found) return false;
  }
  return true;
}

function matchesSubscription(event: NostrEvent, sub: Subscription): boolean {
  return sub.filters.some(f => matchesFilter(event, f));
}

function isStringArray(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string');
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function validateFilter(f: unknown): f is Filter {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return false;
  const o = f as Record<string, unknown>;
  const maxArray = settings.getInt('MAX_FILTER_ARRAY');
  for (const [key, value] of Object.entries(o)) {
    if (key === 'ids' || key === 'authors') {
      if (!isStringArray(value, maxArray)) return false;
    } else if (key === 'kinds') {
      if (!Array.isArray(value) || value.length > maxArray || !value.every(v => isInt(v))) return false;
    } else if (key === 'since' || key === 'until') {
      if (!isInt(value)) return false;
    } else if (key === 'limit') {
      if (!isInt(value) || value <= 0) return false;
    } else if (isTagFilterKey(key)) {
      // NIP-01 tag filters
      if (!isStringArray(value, maxArray)) return false;
    }
    // Unknown fields are allowed and ignored, per NIP-01.
  }
  return true;
}

function broadcastEvent(event: NostrEvent): void {
  for (const client of clients) {
    for (const sub of client.subs.values()) {
      if (matchesSubscription(event, sub)) {
        send(client.ws, ['EVENT', sub.id, event]);
        break;
      }
    }
  }
}

function handleEvent(client: Client, data: unknown[]): void {
  const raw = data[1];
  if (!validateEvent(raw)) {
    send(client.ws, ['NOTICE', 'invalid: event structure invalid']);
    return;
  }
  const event = raw as NostrEvent;

  // Cheap checks first: the serialized form is needed for both the size cap
  // and the id hash, so compute it once here.
  const serialized = serializeEvent(event);
  if (serialized.length > settings.getInt('MAX_EVENT_SIZE')) {
    send(client.ws, ['OK', event.id, false, 'invalid: event too large']);
    return;
  }

  if (event.tags.length > settings.getInt('MAX_EVENT_TAGS')) {
    send(client.ws, ['OK', event.id, false, 'invalid: too many tags']);
    return;
  }

  if (!verifyEventId(event, serialized)) {
    send(client.ws, ['OK', event.id, false, 'invalid: id does not match']);
    return;
  }

  // Signature verification is the most expensive check; run it last.
  if (!verifySignature(event)) {
    send(client.ws, ['OK', event.id, false, 'invalid: signature verification failed']);
    return;
  }

  if (eventExists(event.id)) {
    send(client.ws, ['OK', event.id, true, 'duplicate: already have this event']);
    return;
  }

  const saved = saveEvent(event);
  send(client.ws, ['OK', event.id, saved, saved ? '' : 'error: could not save event']);

  if (saved) {
    broadcastEvent(event);
    relayEvents.emit('stats');
  }
}

function handleReq(client: Client, data: unknown[]): void {
  const subId = data[1];
  if (typeof subId !== 'string' || subId.length > 64) {
    send(client.ws, ['NOTICE', 'invalid: subscription id must be a string <= 64 chars']);
    return;
  }

  const maxSubs = settings.getInt('MAX_SUBS');
  if (client.subs.size >= maxSubs && !client.subs.has(subId)) {
    send(client.ws, ['NOTICE', `error: max ${maxSubs} subscriptions per connection`]);
    return;
  }

  const rawFilters = data.slice(2);
  const maxFilters = settings.getInt('MAX_FILTERS');
  if (!rawFilters.length || rawFilters.length > maxFilters) {
    send(client.ws, ['NOTICE', 'invalid: expected 1 to ' + maxFilters + ' filters']);
    return;
  }

  const filters: Filter[] = [];
  for (const raw of rawFilters) {
    if (!validateFilter(raw)) {
      send(client.ws, ['NOTICE', 'invalid: malformed filter']);
      return;
    }
    filters.push(raw);
  }

  const sub: Subscription = { id: subId, filters };
  client.subs.set(subId, sub);

  const stored = getEvents(filters);
  for (const event of stored) {
    send(client.ws, ['EVENT', subId, event]);
  }
  send(client.ws, ['EOSE', subId]);
}

function handleClose(client: Client, data: unknown[]): void {
  const subId = data[1];
  if (typeof subId === 'string') {
    client.subs.delete(subId);
  }
}

// Token bucket: refill by elapsed time, reject messages once the bucket is
// empty, and close the connection after too many consecutive violations.
function enforceRateLimit(client: Client): boolean {
  const now = Date.now();
  client.tokens = Math.min(
    settings.getInt('RATE_LIMIT_BURST'),
    client.tokens + ((now - client.lastRefill) / 1000) * settings.getInt('RATE_LIMIT_MESSAGES')
  );
  client.lastRefill = now;

  if (client.tokens >= 1) {
    client.tokens -= 1;
    client.violations = 0;
    return true;
  }

  client.violations += 1;
  if (client.violations >= RATE_LIMIT_MAX_VIOLATIONS) {
    send(client.ws, ['NOTICE', 'error: rate limit exceeded, closing connection']);
    client.ws.close();
  } else {
    send(client.ws, ['NOTICE', 'error: rate limit exceeded']);
  }
  return false;
}

function handleMessage(client: Client, raw: string): void {
  if (!enforceRateLimit(client)) return;

  let data: unknown[];
  try {
    data = JSON.parse(raw);
  } catch {
    send(client.ws, ['NOTICE', 'error: failed to parse message']);
    return;
  }

  if (!Array.isArray(data) || data.length < 2) {
    send(client.ws, ['NOTICE', 'error: message must be a non-empty JSON array']);
    return;
  }

  const verb = data[0];
  try {
    switch (verb) {
      case 'EVENT': return handleEvent(client, data);
      case 'REQ':   return handleReq(client, data);
      case 'CLOSE': return handleClose(client, data);
      default:
        send(client.ws, ['NOTICE', `error: unknown message type "${verb}"`]);
    }
  } catch (err) {
    // Never let a single bad message take down the process.
    error(`[!] ${client.ip} handler error:`, err);
    send(client.ws, ['NOTICE', 'error: internal error']);
  }
}

function cleanupClient(client: Client, token: string): void {
  clients.delete(client);
  relayEvents.emit('stats');
  clientLeases.delete(client);
  try {
    releaseConnectionLease(token);
  } catch (err) {
    error('[!] lease release error:', err);
  }
}

export function createRelay(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 1024 * 1024 });

  // Keep leases for this process's connections alive, prune idle per-IP rate
  // state, and pick up settings changes made in another process. unref() so
  // the timer never keeps the process alive by itself.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    settings.reloadIfStale();
    if (now - lastIpStatePrune >= IP_STATE_PRUNE_INTERVAL_MS) {
      lastIpStatePrune = now;
      try {
        pruneIpState(now - IP_STATE_IDLE_MS);
      } catch (err) {
        error('[!] ip state prune error:', err);
      }
    }
    for (const [client, token] of clientLeases) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          renewConnectionLease(token, CONN_LEASE_TTL_MS);
        } catch (err) {
          error('[!] lease renew error:', err);
        }
      }
    }
  }, CONN_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  // WebSocket-level keepalive: ping every client, and terminate any that did
  // not answer the previous ping (gone or wedged). terminate() fires the
  // 'close' handler, which releases the connection lease and cleans up. The
  // interval is re-read from settings on every round, so admin panel changes
  // apply without a restart.
  function pingRound(): void {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.alive) {
        try {
          client.ws.terminate();
        } catch (err) {
          error('[!] keepalive terminate error:', err);
        }
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch (err) {
        error('[!] keepalive ping error:', err);
      }
    }
  }
  function scheduleNextPing(): void {
    const timer = setTimeout(() => {
      pingRound();
      scheduleNextPing();
    }, settings.getInt('WS_PING_INTERVAL_MS'));
    timer.unref();
  }
  scheduleNextPing();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';

    // Fast local pre-filter before any DB work.
    if (clients.size >= settings.getInt('MAX_CONNECTIONS')) {
      send(ws, ['NOTICE', 'error: server at max connections, try again later']);
      ws.close();
      return;
    }

    // Cross-process per-IP rate bucket for connection attempts.
    let rateOk = false;
    try {
      rateOk = tryAcquireIpRate(ip, settings.getInt('IP_CONNECT_RATE'), settings.getInt('IP_CONNECT_BURST'));
    } catch (err) {
      error('[!] ip rate error:', err);
    }
    if (!rateOk) {
      send(ws, ['NOTICE', 'error: connection rate limit exceeded, try again later']);
      ws.close();
      return;
    }

    // Cross-process global and per-IP concurrent caps, one atomic lease step.
    const leaseToken = randomBytes(16).toString('hex');
    let lease: LeaseAcquireResult = 'max-connections';
    try {
      lease = acquireConnectionLease({
        token: leaseToken,
        pid: process.pid,
        ip,
        ttlMs: CONN_LEASE_TTL_MS,
        maxConnections: settings.getInt('MAX_CONNECTIONS'),
        maxConnectionsPerIp: settings.getInt('MAX_CONNECTIONS_PER_IP'),
      });
    } catch (err) {
      error('[!] lease acquire error:', err);
    }
    if (lease !== 'ok') {
      const message = lease === 'max-per-ip'
        ? 'error: too many connections from your address'
        : 'error: server at max connections (global), try again later';
      send(ws, ['NOTICE', message]);
      ws.close();
      return;
    }

    const client: Client = {
      ws,
      subs: new Map(),
      ip,
      tokens: settings.getInt('RATE_LIMIT_BURST'),
      lastRefill: Date.now(),
      violations: 0,
      alive: true,
    };
    clients.add(client);
    if (clients.size > maxConnectionsSeen) {
      maxConnectionsSeen = clients.size;
    }
    clientLeases.set(client, leaseToken);
    relayEvents.emit('stats');
    log(`[+] ${ip} connected (total: ${clients.size})`);

    ws.on('message', (buf) => {
      handleMessage(client, buf.toString());
    });

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('close', () => {
      cleanupClient(client, leaseToken);
      log(`[-] ${ip} disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      cleanupClient(client, leaseToken);
      error(`[!] ${ip} error:`, err.message);
    });

    send(ws, ['NOTICE', 'welcome to locapeer-relay']);
  });

  return wss;
}

// Live stats for the admin panel.
export function getActiveConnections(): number {
  return clients.size;
}

export function getMaxConnectionsSeen(): number {
  return maxConnectionsSeen;
}

export function getConnectionsPerIp(): Record<string, number> {
  const byIp: Record<string, number> = {};
  for (const client of clients) {
    byIp[client.ip] = (byIp[client.ip] ?? 0) + 1;
  }
  return byIp;
}
