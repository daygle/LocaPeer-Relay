import { EventEmitter } from 'events';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomBytes } from 'crypto';
import { saveEvent, getEvents, eventExists, applyDeletion, isDeleted, DELETION_KIND, MAX_QUERY_LIMIT, acquireConnectionLease, renewConnectionLease, releaseConnectionLease, tryAcquireIpRate, pruneIpState, pruneOldEvents, LeaseAcquireResult } from './db';
import { validateEvent, verifyEventId, verifySignature, serializeEvent } from './verify';
import { isTagFilterKey } from './filter';
import { getClientIp } from './clientip';
import { strike, isBanned, STRIKE } from './bans';
import { NostrEvent, Filter, Subscription } from './types';
import { settings } from './settings';
import { log, error } from './log';

// Largest WebSocket frame accepted; also the ceiling for MAX_EVENT_SIZE.
const WS_MAX_PAYLOAD = 1024 * 1024;

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

// How often to check for old events to prune (retention policy).
const RETENTION_CHECK_INTERVAL_MS = 60 * 60_000; // check hourly
let lastRetentionCheck = 0;

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
  // Set once the connection was closed for flooding, so frames still in
  // flight don't add more strikes for the same offence.
  floodClosed: boolean;
}

const clients = new Set<Client>();
const clientLeases = new Map<Client, string>();
let lastIpStatePrune = 0;
let maxConnectionsSeen = 0;

// Emitted whenever live stats change (connection open/close, event stored)
// so the admin panel can push instant updates over Server-Sent Events.
export const relayEvents = new EventEmitter();

// Record an offence against the client's IP; if that bans it, drop every
// open connection from the IP.
function penalize(client: Client, reason: string, weight: number): void {
  if (strike(client.ip, reason, weight)) dropIp(client.ip);
}

function dropIp(ip: string): void {
  relayEvents.emit('stats');
  for (const c of clients) {
    if (c.ip !== ip) continue;
    send(c.ws, ['NOTICE', 'blocked: your address has been banned']);
    try {
      c.ws.terminate();
    } catch {
      // best-effort
    }
  }
}

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
    // Answer with OK when the id is readable so the publisher can settle the
    // event (NIP-01); otherwise there is nothing to correlate a reply with.
    const id = eventIdOf(raw);
    send(client.ws, id
      ? ['OK', id, false, 'invalid: event structure invalid']
      : ['NOTICE', 'invalid: event structure invalid']);
    penalize(client, 'invalid events', STRIKE.invalidEvent);
    return;
  }
  const event = raw as NostrEvent;

  // Cheap checks first: the serialized form is needed for both the size cap
  // and the id hash, so compute it once here.
  const serialized = serializeEvent(event);
  if (Buffer.byteLength(serialized, 'utf8') > settings.getInt('MAX_EVENT_SIZE')) {
    send(client.ws, ['OK', event.id, false, 'invalid: event too large']);
    return;
  }

  if (event.tags.length > settings.getInt('MAX_EVENT_TAGS')) {
    send(client.ws, ['OK', event.id, false, 'invalid: too many tags']);
    return;
  }

  if (!verifyEventId(event, serialized)) {
    send(client.ws, ['OK', event.id, false, 'invalid: id does not match']);
    penalize(client, 'invalid events', STRIKE.invalidEvent);
    return;
  }

  // Signature verification is the most expensive check; run it last.
  if (!verifySignature(event)) {
    send(client.ws, ['OK', event.id, false, 'invalid: signature verification failed']);
    penalize(client, 'invalid events', STRIKE.invalidEvent);
    return;
  }

  if (eventExists(event.id)) {
    send(client.ws, ['OK', event.id, true, 'duplicate: already have this event']);
    return;
  }

  if (isDeleted(event)) {
    send(client.ws, ['OK', event.id, false, 'blocked: event was deleted by its author']);
    return;
  }

  const saved = saveEvent(event);
  send(client.ws, ['OK', event.id, saved, saved ? '' : 'error: could not save event']);

  if (saved) {
    if (event.kind === DELETION_KIND) applyDeletion(event);
    broadcastEvent(event);
    relayEvents.emit('stats');
  }
}

function handleReq(client: Client, data: unknown[]): void {
  const subId = data[1];
  if (typeof subId !== 'string' || subId.length > 64) {
    send(client.ws, ['NOTICE', 'invalid: subscription id must be a string <= 64 chars']);
    penalize(client, 'malformed messages', STRIKE.malformedMessage);
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
    penalize(client, 'malformed messages', STRIKE.malformedMessage);
    return;
  }

  const filters: Filter[] = [];
  for (const raw of rawFilters) {
    if (!validateFilter(raw)) {
      send(client.ws, ['NOTICE', 'invalid: malformed filter']);
      penalize(client, 'malformed messages', STRIKE.malformedMessage);
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

// A 64-char hex event id from an EVENT payload, if it has one.
function eventIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

// Token bucket: refill by elapsed time, reject messages once the bucket is
// empty, and close the connection after too many consecutive violations.
// A throttled EVENT is answered with OK false "rate-limited:" (NIP-01) so the
// publisher keeps it queued and retries, instead of waiting for an OK that
// never comes and assuming the event was delivered.
function enforceRateLimit(client: Client, data: unknown): boolean {
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
  const eventId = Array.isArray(data) && data[0] === 'EVENT' ? eventIdOf(data[1]) : null;
  if (eventId) {
    send(client.ws, ['OK', eventId, false, 'rate-limited: slow down']);
  }
  if (client.violations >= RATE_LIMIT_MAX_VIOLATIONS) {
    send(client.ws, ['NOTICE', 'error: rate limit exceeded, closing connection']);
    client.ws.close();
    if (!client.floodClosed) {
      client.floodClosed = true;
      penalize(client, 'message flooding', STRIKE.floodClosed);
    }
  } else {
    send(client.ws, ['NOTICE', 'error: rate limit exceeded']);
  }
  return false;
}

function handleMessage(client: Client, raw: string): void {
  // Parse before rate limiting so a throttled EVENT can be answered with OK.
  // ws already caps frames at maxPayload, which bounds the parse cost.
  let data: unknown[];
  try {
    data = JSON.parse(raw);
  } catch {
    if (!enforceRateLimit(client, null)) return;
    send(client.ws, ['NOTICE', 'error: failed to parse message']);
    penalize(client, 'malformed messages', STRIKE.malformedMessage);
    return;
  }

  if (!enforceRateLimit(client, data)) return;

  if (!Array.isArray(data) || data.length < 2) {
    send(client.ws, ['NOTICE', 'error: message must be a non-empty JSON array']);
    penalize(client, 'malformed messages', STRIKE.malformedMessage);
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
        penalize(client, 'malformed messages', STRIKE.malformedMessage);
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

// Build NIP-11 relay information response.
function buildNip11(): object {
  return {
    name: settings.getString('RELAY_NAME') || 'LocaPeer Relay',
    description: settings.getString('RELAY_DESCRIPTION') || 'A self-hosted Nostr relay.',
    contact: settings.getString('RELAY_CONTACT') || undefined,
    supported_nips: [1, 9, 11],
    software: 'locapeer-relay',
    version: require('../package.json').version || 'unknown',
    limitation: {
      max_message_length: WS_MAX_PAYLOAD,
      max_subscriptions: settings.getInt('MAX_SUBS'),
      max_filters: settings.getInt('MAX_FILTERS'),
      max_limit: MAX_QUERY_LIMIT,
      max_subid_length: 64,
      max_event_tags: settings.getInt('MAX_EVENT_TAGS'),
      max_content_length: settings.getInt('MAX_EVENT_SIZE'),
      auth_required: false,
      payment_required: false,
    },
  };
}

export function createRelay(port: number): http.Server {
  // Create an HTTP server so we can handle NIP-11 requests before the
  // WebSocket upgrade. ws attaches to the 'upgrade' event.
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

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
    // Retention: prune events older than RETENTION_DAYS (if > 0).
    if (now - lastRetentionCheck >= RETENTION_CHECK_INTERVAL_MS) {
      lastRetentionCheck = now;
      const days = settings.getInt('RETENTION_DAYS');
      if (days > 0) {
        try {
          const deleted = pruneOldEvents(days * 86400);
          if (deleted > 0) log(`[retention] pruned ${deleted} events older than ${days}d`);
        } catch (err) {
          error('[!] retention prune error:', err);
        }
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

  // Handle HTTP requests: NIP-11 relay information.
  httpServer.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      // Check for NIP-11 Accept header.
      if (req.headers.accept === 'application/nostr+json') {
        res.writeHead(200, {
          'Content-Type': 'application/nostr+json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(buildNip11()));
        return;
      }
      // Regular HTTP request - return 426 Upgrade Required.
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('426 Upgrade Required');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  });

  // Handle WebSocket upgrades, passing to ws.
  httpServer.on('upgrade', (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    // Refuse banned addresses before the WebSocket handshake. A 403 makes
    // clients back off (LocaPeer treats it as a failed connect), whereas an
    // accepted-then-closed socket would invite an immediate reconnect.
    if (isBanned(getClientIp(req))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = getClientIp(req);

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
      if (strike(ip, 'connection flooding', STRIKE.connectRateLimited)) dropIp(ip);
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
      floodClosed: false,
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

  // Start listening on the HTTP server (which also handles upgrades).
  httpServer.listen(port, () => {
    log(`locapeer-relay listening on ws://0.0.0.0:${port}`);
  });

  return httpServer;
}

// Terminate all connections for shutdown.
export function terminateAllConnections(): void {
  for (const client of clients) {
    try {
      client.ws.terminate();
    } catch {
      // best-effort
    }
  }
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
