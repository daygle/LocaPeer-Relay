import fs from 'fs';
import path from 'path';
import { DB_PATH, getSettingsRows, setSettingValue } from './db';

// Definitions of the settings surfaced in the admin panel. Each key doubles
// as the environment variable name, so existing deployments keep working:
// the environment provides the initial default, and the database overrides
// it once a value is changed through the admin panel.
export interface SettingDef {
  key: string;
  kind: 'int' | 'string';
  default: number | string;
  min?: number;
  max?: number;
  group: string;
  label: string;
  help?: string;
  secret?: boolean;
  applyNote?: string;
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'MAX_CONNECTIONS',
    kind: 'int',
    default: 100,
    min: 1,
    max: 100000,
    group: 'Connections',
    label: 'Max Connections (Global)',
    help: 'Hard cap on concurrent connections, shared across all relay processes that use the same database.',
  },
  {
    key: 'MAX_CONNECTIONS_PER_IP',
    kind: 'int',
    default: 10,
    min: 1,
    max: 10000,
    group: 'Connections',
    label: 'Max Connections per IP',
    help: 'Concurrent connections allowed from a single address.',
  },
  {
    key: 'IP_CONNECT_RATE',
    kind: 'int',
    default: 5,
    min: 1,
    max: 100000,
    group: 'Connections',
    label: 'New Connections per Second per IP',
    help: 'Token refill rate for new connection attempts from one address.',
  },
  {
    key: 'IP_CONNECT_BURST',
    kind: 'int',
    default: 10,
    min: 1,
    max: 100000,
    group: 'Connections',
    label: 'New Connection Burst per IP',
    help: 'How many new connections an address may open at once before throttling starts.',
  },
  {
    key: 'RATE_LIMIT_MESSAGES',
    kind: 'int',
    default: 60,
    min: 1,
    max: 100000,
    group: 'Rate Limiting',
    label: 'Messages per Second per Connection',
    help: 'Token refill rate for inbound messages on one connection.',
  },
  {
    key: 'RATE_LIMIT_BURST',
    kind: 'int',
    default: 100,
    min: 1,
    max: 100000,
    group: 'Rate Limiting',
    label: 'Message Burst per Connection',
    help: 'How many messages a connection may send at once before throttling starts.',
  },
  {
    key: 'MAX_SUBS',
    kind: 'int',
    default: 20,
    min: 1,
    max: 1000,
    group: 'Events & Queries',
    label: 'Max Subscriptions per Connection',
  },
  {
    key: 'MAX_FILTERS',
    kind: 'int',
    default: 10,
    min: 1,
    max: 100,
    group: 'Events & Queries',
    label: 'Max Filters per REQ',
  },
  {
    key: 'MAX_EVENT_TAGS',
    kind: 'int',
    default: 2500,
    min: 1,
    max: 100000,
    group: 'Events & Queries',
    label: 'Max Tags per Event',
  },
  {
    key: 'MAX_FILTER_ARRAY',
    kind: 'int',
    default: 100,
    min: 1,
    max: 10000,
    group: 'Events & Queries',
    label: 'Max Values per Filter Array',
    help: 'Caps ids, authors, kinds and #tag arrays in REQ filters.',
  },
  {
    key: 'MAX_EVENT_SIZE',
    kind: 'int',
    default: 65536,
    min: 1024,
    max: 1048576,
    group: 'Events & Queries',
    label: 'Max Event Size (Bytes)',
    help: 'Largest serialized event that will be accepted.',
  },
  {
    key: 'WS_PING_INTERVAL_MS',
    kind: 'int',
    default: 30000,
    min: 1000,
    max: 3600000,
    group: 'Keepalive',
    label: 'WebSocket Ping Interval (ms)',
    help: 'How often the relay pings each connection. Keeps idle connections alive through Cloudflare and other intermediaries, and drops dead peers.',
  },
  {
    key: 'TUNNEL_TOKEN',
    kind: 'string',
    default: '',
    group: 'Cloudflare Tunnel',
    label: 'Cloudflare Tunnel Token',
    secret: true,
    applyNote: 'docker compose restart cloudflared',
    help: 'Written to tunnel.env next to the database so the cloudflared container picks it up on its next start.',
  },
];

const DEFS_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

// How often to re-read the settings table so changes made by another relay
// process sharing the database propagate here.
const SETTINGS_RELOAD_INTERVAL_MS = 60_000;

class Settings {
  private values = new Map<string, string>();
  readonly tunnelEnvPath: string;
  lastReload = 0;

  constructor() {
    this.tunnelEnvPath =
      process.env.TUNNEL_ENV_PATH || path.join(path.dirname(DB_PATH), 'tunnel.env');
    // Seed from the environment (backwards compatible), then let the
    // database override values that were changed through the admin panel.
    for (const def of SETTING_DEFS) {
      const env = process.env[def.key];
      this.values.set(def.key, env !== undefined ? env : String(def.default));
    }
    this.reloadFromDb();
  }

  getInt(key: string): number {
    const def = DEFS_BY_KEY.get(key);
    if (!def || def.kind !== 'int') return 0;
    const n = Number(this.values.get(key));
    return Number.isInteger(n) ? n : (def.default as number);
  }

  getString(key: string): string {
    return this.values.get(key) ?? '';
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const def of SETTING_DEFS) {
      out[def.key] = this.getString(def.key);
    }
    return out;
  }

  // Apply a partial update. Returns a map of field -> error message; an empty
  // map means every value passed validation and was persisted.
  setMany(patch: Record<string, unknown>): Record<string, string> {
    const errors: Record<string, string> = {};
    const normalized: Record<string, string> = {};

    for (const [key, raw] of Object.entries(patch)) {
      const def = DEFS_BY_KEY.get(key);
      if (!def) {
        errors[key] = 'Unknown setting';
        continue;
      }
      const str = typeof raw === 'string' ? raw.trim() : String(raw);
      if (def.kind === 'int') {
        const n = Number(str);
        if (
          !Number.isInteger(n) ||
          n < (def.min ?? 0) ||
          n > (def.max ?? Number.MAX_SAFE_INTEGER)
        ) {
          errors[key] = `Must be an integer between ${def.min} and ${def.max}`;
          continue;
        }
      }
      normalized[key] = str;
    }
    if (Object.keys(errors).length > 0) return errors;

    for (const [key, value] of Object.entries(normalized)) {
      try {
        setSettingValue(key, value);
      } catch (err) {
        console.error(`[!] failed to persist setting ${key}:`, err);
        errors[key] = 'Could not persist';
        continue;
      }
      this.values.set(key, value);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'TUNNEL_TOKEN')) {
      this.writeTunnelEnv();
    }
    return errors;
  }

  // Re-read the settings table so changes made by another relay process
  // sharing the database show up here too.
  reloadFromDb(): void {
    try {
      for (const [key, value] of getSettingsRows()) {
        if (DEFS_BY_KEY.has(key)) this.values.set(key, value);
      }
    } catch (err) {
      console.error('[!] settings reload error:', err);
    }
    this.lastReload = Date.now();
  }

  reloadIfStale(): void {
    if (Date.now() - this.lastReload >= SETTINGS_RELOAD_INTERVAL_MS) {
      this.reloadFromDb();
    }
  }

  // Write the tunnel token to tunnel.env in the shared data volume so the
  // cloudflared wrapper container can source it on its next start. Written
  // atomically; owned by the cloudflared nonroot uid (65532) when possible.
  private writeTunnelEnv(): void {
    const token = this.getString('TUNNEL_TOKEN');
    const tmp = `${this.tunnelEnvPath}.tmp`;
    try {
      fs.writeFileSync(tmp, `TUNNEL_TOKEN=${token}\n`, { mode: 0o600 });
      try {
        fs.chownSync(tmp, 65532, 65532);
      } catch {
        // Not running as root (e.g. bare-metal dev): fall back to 0644 so
        // the cloudflared container can still read it.
        fs.chmodSync(tmp, 0o644);
      }
      fs.renameSync(tmp, this.tunnelEnvPath);
    } catch (err) {
      console.error('[!] failed to write tunnel.env:', err);
    }
  }
}

export const settings = new Settings();
