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

## Running without Docker

**Requirements:** Node.js 20+

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

## Reverse proxy with HAProxy (recommended)

If you are using OPNsense HAProxy for TLS termination, configure your backend to forward to `<server-ip>:7777` with plain `ws://`. HAProxy handles `wss://` on port 443 and passes plain WebSocket traffic through to the relay.

Key HAProxy backend settings for WebSocket:
- `timeout tunnel 3600s` — keeps long-lived WebSocket connections alive
- `timeout server 3600s` — matches tunnel timeout
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
