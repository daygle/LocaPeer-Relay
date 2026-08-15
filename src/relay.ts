import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { saveEvent, getEvents, eventExists } from './db';
import { validateEvent, verifyEventId, verifySignature } from './verify';
import { NostrEvent, Filter, Subscription } from './types';

const MAX_SUBS_PER_CLIENT = parseInt(process.env.MAX_SUBS ?? '20');
const MAX_FILTERS_PER_SUB = parseInt(process.env.MAX_FILTERS ?? '10');
const MAX_EVENT_TAGS = parseInt(process.env.MAX_EVENT_TAGS ?? '2500');
const MAX_FILTER_ARRAY = parseInt(process.env.MAX_FILTER_ARRAY ?? '100');
const MAX_EVENT_SIZE = parseInt(process.env.MAX_EVENT_SIZE ?? '65536');

interface Client {
  ws: WebSocket;
  subs: Map<string, Subscription>;
  ip: string;
}

const clients = new Set<Client>();

function send(ws: WebSocket, msg: unknown[]): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids?.length && !filter.ids.includes(event.id)) return false;
  if (filter.authors?.length && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.since != null && event.created_at < filter.since) return false;
  if (filter.until != null && event.created_at > filter.until) return false;

  for (const [key, vals] of Object.entries(filter)) {
    if (!key.startsWith('#') || key.length !== 2) continue;
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
  for (const [key, value] of Object.entries(o)) {
    if (key === 'ids' || key === 'authors') {
      if (!isStringArray(value, MAX_FILTER_ARRAY)) return false;
    } else if (key === 'kinds') {
      if (!Array.isArray(value) || value.length > MAX_FILTER_ARRAY || !value.every(v => isInt(v))) return false;
    } else if (key === 'since' || key === 'until') {
      if (!isInt(value)) return false;
    } else if (key === 'limit') {
      if (!isInt(value) || value <= 0) return false;
    } else if (key.startsWith('#') && key.length === 2) {
      // NIP-01 tag filters
      if (!isStringArray(value, MAX_FILTER_ARRAY)) return false;
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

  if (JSON.stringify(event).length > MAX_EVENT_SIZE) {
    send(client.ws, ['OK', event.id, false, 'invalid: event too large']);
    return;
  }

  if (!verifyEventId(event)) {
    send(client.ws, ['OK', event.id, false, 'invalid: id does not match']);
    return;
  }

  if (!verifySignature(event)) {
    send(client.ws, ['OK', event.id, false, 'invalid: signature verification failed']);
    return;
  }

  if (event.tags.length > MAX_EVENT_TAGS) {
    send(client.ws, ['OK', event.id, false, 'invalid: too many tags']);
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
  }
}

function handleReq(client: Client, data: unknown[]): void {
  const subId = data[1];
  if (typeof subId !== 'string' || subId.length > 64) {
    send(client.ws, ['NOTICE', 'invalid: subscription id must be a string <= 64 chars']);
    return;
  }

  if (client.subs.size >= MAX_SUBS_PER_CLIENT && !client.subs.has(subId)) {
    send(client.ws, ['NOTICE', `error: max ${MAX_SUBS_PER_CLIENT} subscriptions per connection`]);
    return;
  }

  const rawFilters = data.slice(2);
  if (!rawFilters.length || rawFilters.length > MAX_FILTERS_PER_SUB) {
    send(client.ws, ['NOTICE', 'invalid: expected 1 to ' + MAX_FILTERS_PER_SUB + ' filters']);
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

function handleMessage(client: Client, raw: string): void {
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
    console.error(`[!] ${client.ip} handler error:`, err);
    send(client.ws, ['NOTICE', 'error: internal error']);
  }
}

export function createRelay(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const client: Client = { ws, subs: new Map(), ip };
    clients.add(client);
    console.log(`[+] ${ip} connected (total: ${clients.size})`);

    ws.on('message', (buf) => {
      handleMessage(client, buf.toString());
    });

    ws.on('close', () => {
      clients.delete(client);
      console.log(`[-] ${ip} disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      clients.delete(client);
      console.error(`[!] ${ip} error:`, err.message);
    });

    send(ws, ['NOTICE', 'welcome to locapeer-relay']);
  });

  return wss;
}
