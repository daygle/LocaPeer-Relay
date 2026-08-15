# LocaPeer Relay

A self-hostable [Nostr](https://nostr.com) relay built for [LocaPeer](https://github.com/daygle/LocaPeer). Implements [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) and stores events in a local SQLite database.

## Quick start with Docker (recommended)

```bash
cd /opt
git clone https://github.com/daygle/locapeer-relay.git
cd locapeer-relay
docker compose up -d
```

The relay listens on `ws://localhost:7777` by default.

In the LocaPeer app go to **Settings → Relay** and enter `wss://relay.daygle.net`.

## Configuration

All settings are environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7777` | WebSocket port |
| `DB_PATH` | `relay.db` (cwd) | Path to SQLite database file |
| `MAX_SUBS` | `20` | Max concurrent subscriptions per connection |
| `MAX_FILTERS` | `10` | Max filters per REQ message |
| `MAX_EVENT_TAGS` | `2500` | Max tags per event |
| `MAX_FILTER_ARRAY` | `100` | Max values per filter array (`ids`, `authors`, `kinds`, `#tags`) |
| `MAX_EVENT_SIZE` | `65536` | Max serialized event size in bytes |
| `MAX_CONNECTIONS` | `100` | Global max concurrent connections across all relay processes sharing the same database; extra connections are rejected |
| `MAX_CONNECTIONS_PER_IP` | `10` | Max concurrent connections from a single IP across all relay processes sharing the database |
| `IP_CONNECT_RATE` | `5` | Max new connections per second from a single IP (token refill rate, shared across processes) |
| `IP_CONNECT_BURST` | `10` | Max burst of new connections from a single IP before throttling starts (shared across processes) |
| `RATE_LIMIT_MESSAGES` | `60` | Max messages per second per connection (token refill rate) |
| `RATE_LIMIT_BURST` | `100` | Max burst of messages per connection before throttling starts |
| `WS_PING_INTERVAL_MS` | `30000` | How often the relay sends WebSocket ping frames; clients that do not answer are disconnected. Keeps idle connections alive through intermediaries (e.g. Cloudflare) that drop silent connections |
| `ADMIN_PORT` | `8080` | Admin panel HTTP port (internal/LAN access only) |
| `ADMIN_HOST` | `0.0.0.0` | Address the admin panel binds to |
| `TUNNEL_ENV_PATH` | `<db dir>/tunnel.env` | Where the admin panel writes the Cloudflare tunnel token for the cloudflared container |

> The admin account and every tunable setting above live in the relay
> database, not in the environment. The environment value only seeds the
> initial default on first boot; after the first edit in the panel the
> database wins. The few variables that stay env-only (`PORT`, `DB_PATH`,
> `ADMIN_PORT`, `ADMIN_HOST`, `TUNNEL_ENV_PATH`) are bootstrap settings the
> process needs before it can serve anything.

> Most of these variables can be changed at runtime through the admin panel
> instead of the environment; see the [Admin panel](#admin-panel) section.
> The environment value seeds the initial default, and the database overrides
> it once a value is edited in the panel.

## Admin panel

The relay ships with a small admin panel for editing runtime settings and
watching live stats. It runs on its own HTTP port (`ADMIN_PORT`, default
8080) and is **intended for internal/LAN access only** - publish it on your
host and never route it through the Cloudflare tunnel or a public reverse
proxy. With Docker it is published on the host automatically:

```bash
docker compose up -d
# then open http://<your-host-ip>:8080
```

What you can do:

- **Edit limits** (connections, per-IP caps, rate limits, event/query caps,
  ping interval) - changes apply immediately, no restart.
- **Manage the Cloudflare tunnel token** - saving it writes `tunnel.env`
  next to the database so the cloudflared container picks it up on its next
  start (`docker compose restart cloudflared`).
- **Watch live stats** - active/peak connections, per-IP connection counts,
  events stored, database size, uptime, updated instantly via
  Server-Sent Events (no polling).

First run: the first time you open the panel it asks you to create the
admin username and password. The credentials are stored (scrypt-hashed with
a per-account salt) in the relay database - nothing sensitive lives in
`.env`. After that, every panel visit requires the login.

Security notes:

- The panel is plain HTTP, so only use it across your trusted LAN and never
  publish the port through the tunnel or a public proxy.
- Responses are served with a strict Content-Security-Policy (per-request
  nonce, no `unsafe-inline`), no-store caching, and anti-framing and
  referrer-leak headers.
- Settings and the admin credentials are stored in the `settings` table of
  the relay database; when multiple relay processes share a database, edits
  propagate to the others within about a minute.
- The panel is served by the relay process; if the admin port is already in
  use, the relay logs a warning and keeps running without the panel.

## Running without Docker

**Requirements:** Node.js 24+

```bash
npm install
npm run build
npm start
```

For development with live reload:

```bash
npm run dev
```

## Testing

The integration suite boots a real relay on `ws://localhost:7899` (override
with `TEST_PORT`) and exercises malformed REQ/EVENT payloads, signature and
ID verification, duplicates, and subscription round-trips:

```bash
npm test
```

The suite uses Node's built-in test runner (`node --test`) and requires no
additional dependencies. Test databases are created in `test/.tmp/` and
cleaned up after each run.

## Updating

Your event database persists across updates (it lives in the `relay-data`
Docker volume, or in the `DB_PATH` file when running without Docker), so
these steps upgrade the code without losing stored events. The database
schema is unchanged, so no migration is required.

### With Docker

```bash
cd /opt/locapeer-relay
git pull
docker compose up -d --build
```

The `--build` flag rebuilds the image so new dependencies and code are
picked up. To reclaim disk from the old image afterwards:

```bash
docker image prune -f
```

### Without Docker

```bash
cd locapeer-relay
git pull
npm install       # pick up any new dependencies
npm run build
npm start         # or restart your service (systemd, pm2, etc.)
```

> **Note:** Signature verification applies only to events received after the
> update. Events already stored from a previous version are not re-validated.

## Maintenance

### Backing up the database

The relay ships `scripts/backup.sh`, which uses better-sqlite3's online
backup API inside the running container - safe to run while the relay is up
(WAL mode keeps the backup consistent), and it pipes the result straight to
the host, so nothing is left in the volume:

```bash
./scripts/backup.sh            # writes ./backups/relay-<timestamp>.db
BACKUP_DIR=/mnt/backups ./scripts/backup.sh   # custom location
KEEP=14 ./scripts/backup.sh    # keep 14 backups instead of the default 7
```

Backups go to `backups/` (git-ignored) and are pruned to the newest `KEEP`
(default 7). Copy them off the box regularly - a cron job plus rclone or
syncthing is enough. The `relay-data` volume is the only place events live,
so a backup on a second disk (or machine) is what actually protects you.

### Restoring a backup

1. Stop the relay: `docker compose stop relay`.
2. Replace the database in the volume. With a named volume, run a one-off
   container to copy the file in:

   ```bash
   docker run --rm -v locapeer-relay_relay-data:/data \
     -v "$(pwd)/backups:/backup" alpine \
     sh -c 'cp /backup/relay-<timestamp>.db /data/relay.db'
   ```

3. Start it again: `docker compose start relay`.

The relay opens the database with WAL mode and never migrates it, so a
restored file from the same (or an older) version works as-is.

### Health checks

`docker compose ps` shows the relay's health status - the container runs a
healthcheck that probes `GET /api/health` on the admin port. The endpoint
is unauthenticated (it is LAN-only and also useful for uptime monitors)
and reports `ok`, the version, live connection count, and stored events.

### Admin login protection

The admin API throttles failed logins per IP: 5 failures in a row lock that
IP out for 15 minutes (a 429 with `Retry-After`). Successful logins reset
the counter.

## Reverse proxy with HAProxy (recommended)

If you are using OPNsense HAProxy for TLS termination, configure your backend to forward to `<server-ip>:7777` with plain `ws://`. HAProxy handles `wss://` on port 443 and passes plain WebSocket traffic through to the relay.

Key HAProxy backend settings for WebSocket:
- `timeout tunnel 3600s` - keeps long-lived WebSocket connections alive
- `timeout server 3600s` - matches tunnel timeout
- `http-reuse safe`
- HTTP/2 disabled

## Reverse proxy with nginx (HTTPS / WSS)

Alternatively, add a server block to your nginx config:

```nginx
server {
    listen 443 ssl;
    server_name relay.daygle.net;

    ssl_certificate     /etc/letsencrypt/live/relay.daygle.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.daygle.net/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

Obtain a certificate with Certbot:

```bash
certbot --nginx -d relay.daygle.net
```

## Cloudflare Tunnel (optional)

Instead of (or in addition to) a reverse proxy, you can expose the relay
through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
no port forwarding, no public origin IP, and free TLS at Cloudflare's edge.
Cloudflare proxies WebSockets on all plans, so `wss://` works out of the box.

1. Move `daygle.net` DNS to Cloudflare (proxied records require Cloudflare
   to be the authoritative nameserver).
2. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels →
   Create a tunnel**, choose the **Cloudflared** connector type, and copy the
   tunnel token.
3. Add the public hostname `relay.daygle.net` with service type **HTTP** and
   URL `http://relay:7777` - cloudflared reaches the relay by service name
   over Docker's internal network; the tunnel and the edge handle `wss://`.
4. Give cloudflared the token. Two ways:

   - **Preferred:** save it in the [admin panel](#admin-panel) (Settings →
     Cloudflare Tunnel). The relay writes it to `tunnel.env` in the data
     volume, then apply it with:

     ```bash
     docker compose restart cloudflared
     ```

   - Or put it in `.env` as a first-boot fallback (see `.env.example`):

     ```bash
     TUNNEL_TOKEN=your-tunnel-token
     ```

5. Start the stack with the tunnel profile:

   ```bash
   docker compose --profile tunnel up -d
   ```

Notes:

- Cloudflare closes WebSocket connections that are idle for roughly 100
  seconds. The relay now sends ping frames every `WS_PING_INTERVAL_MS`
  (default 30s) to keep connections alive through the tunnel.
- If the tunnel is your only public entry point, remove the `ports:` mapping
  from the `relay` service so port 7777 is not exposed on your LAN, and you
  can remove the relay backend from HAProxy.
- Clients connect exactly as before: `wss://relay.daygle.net`.

## Supported NIPs

| NIP | Description |
|---|---|
| [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol flow (EVENT, REQ, CLOSE, NOTICE, EOSE, OK) |

## LocaPeer event kinds

The relay stores all event kinds including LocaPeer's custom ones:

| Kind | Name |
|---|---|
| 1 | HEARTBEAT |
| 4 | ENCRYPTED_DM |
| 10001 | READ_RECEIPT |
| 10002 | TYPING |
| 10003 | PURGE_REQUEST |
| 10004 | MESSAGE_PURGE_REQUEST |
| 10005 | DELIVERY_ACK |
| 10006 | SUPERVISED_UNLOCK_REQUEST |
| 10007 | SUPERVISED_UNLOCK_RESPONSE |
| 30000 | SOS_ALERT |

## License

MIT
