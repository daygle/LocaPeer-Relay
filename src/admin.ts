import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { settings, SETTING_DEFS } from './settings';
import { countEvents, getDbSizeBytes } from './db';
import { getActiveConnections, getMaxConnectionsSeen, getConnectionsPerIp, relayEvents } from './relay';
import { isAdminConfigured, createAdminAccount, verifyAdmin } from './auth';

// The admin panel is meant to be reachable only from your internal network:
// publish this port on the host (compose does this) and do NOT route it
// through the tunnel or a public reverse proxy.
const ADMIN_HOST = process.env.ADMIN_HOST ?? '0.0.0.0';
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT ?? '8080', 10);
const INDEX_HTML_PATH = path.join(__dirname, '..', 'admin', 'index.html');
const FAVICON_PATH = path.join(__dirname, '..', 'admin', 'favicon.svg');

// Server-Sent Events clients for live stats. The relay emits 'stats' on
// connection open/close and event save; we push a fresh frame to every
// subscriber, plus a keepalive comment so idle connections survive NATs.
const sseClients = new Set<http.ServerResponse>();
const STARTED_AT = Date.now();
const SSE_HEARTBEAT_MS = 30_000;

function loadIndexHtml(): string {
  try {
    return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  } catch {
    return (
      '<!doctype html><meta charset="utf-8"><title>LocaPeer Relay Admin</title>' +
      `<p>Admin UI not found at ${INDEX_HTML_PATH}</p>`
    );
  }
}

let cachedFavicon: string | null = null;

function loadFavicon(): string {
  if (cachedFavicon === null) {
    try {
      cachedFavicon = fs.readFileSync(FAVICON_PATH, 'utf8');
    } catch {
      cachedFavicon = '';
    }
  }
  return cachedFavicon;
}

function parseBasicAuth(req: http.IncomingMessage): { username: string; password: string } | null {
  const match = /^Basic\s+(.+)$/.exec(req.headers.authorization ?? '');
  if (!match) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

// Security + caching headers applied to every admin response: never cache
// panel content, and refuse framing, MIME sniffing, and referrer leakage.
function writeHead(res: http.ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  writeHead(res, status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

// The panel is a single inline-script page, so the CSP uses a per-request
// nonce instead of 'unsafe-inline': the server injects the same random value
// into the header and into the page's <style>/<script> tags.
const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getVersion(): string {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    ) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // version stays 'unknown'
  }
  return version;
}

function getStats(): Record<string, unknown> {
  return {
    version: getVersion(),
    startedAt: STARTED_AT,
    connections: getActiveConnections(),
    maxConnectionsSeen: getMaxConnectionsSeen(),
    connectionsPerIp: getConnectionsPerIp(),
    events: countEvents(),
    dbSizeBytes: getDbSizeBytes(),
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
  };
}

function broadcastStats(): void {
  if (sseClients.size === 0) return;
  const frame = `event: stats\ndata: ${JSON.stringify(getStats())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      // The 'close' handler removes dead clients; ignore write failures.
    }
  }
}

relayEvents.on('stats', broadcastStats);

// Keep SSE connections alive through idle NAT/proxy timeouts and refresh
// slow-moving metrics (e.g. db size between writes).
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      // handled on 'close'
    }
  }
}, SSE_HEARTBEAT_MS).unref();

export function startAdminServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    try {
      // Public: the panel shell and the status probe (setup vs login).
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = loadIndexHtml().split(CSP_NONCE_PLACEHOLDER).join(nonce);
        writeHead(res, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': buildCsp(nonce),
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/favicon.svg') {
        writeHead(res, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        res.end(loadFavicon());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { setupRequired: !isAdminConfigured(), version: getVersion() });
        return;
      }

      // First-run account creation; only allowed before an account exists.
      if (req.method === 'POST' && pathname === '/api/setup') {
        if (isAdminConfigured()) {
          sendJson(res, 409, { error: 'Admin account already configured' });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { username?: unknown; password?: unknown };
        const errors = createAdminAccount(body.username, body.password);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything below requires the admin account.
      if (!isAdminConfigured()) {
        sendJson(res, 401, { error: 'Admin account not configured' });
        return;
      }
      const creds = parseBasicAuth(req);
      if (!creds || !verifyAdmin(creds.username, creds.password)) {
        writeHead(res, 401, { 'WWW-Authenticate': 'Basic realm="LocaPeer Relay Admin"' });
        res.end('Unauthorized');
        return;
      }

      if (req.method === 'GET' && pathname === '/api/stats/stream') {
        writeHead(res, 200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write(`event: stats\ndata: ${JSON.stringify(getStats())}\n\n`);
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
          res.end();
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/settings') {
        sendJson(res, 200, {
          defs: SETTING_DEFS,
          values: settings.snapshot(),
          tunnelEnvPath: settings.tunnelEnvPath,
        });
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/settings') {
        const body = JSON.parse(await readBody(req)) as { values?: Record<string, unknown> };
        const errors = settings.setMany(body.values ?? {});
        if (Object.keys(errors).length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        sendJson(res, 200, { values: settings.snapshot() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/stats') {
        sendJson(res, 200, getStats());
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    }
  });

  // Never take the relay down just because the admin port is unavailable
  // (e.g. two processes racing to bind, or another service on the port).
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[admin] port ${ADMIN_PORT} already in use - admin panel disabled`);
    } else {
      console.error('[admin] server error:', err);
    }
  });

  server.listen(ADMIN_PORT, ADMIN_HOST);
  console.log(`admin panel on http://${ADMIN_HOST}:${ADMIN_PORT}`);
  return server;
}
