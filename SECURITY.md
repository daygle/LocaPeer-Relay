# Security Policy

## Supported Versions

LocaPeer Relay follows a single-mainline model. Only the latest commit on
`main` receives security fixes; there are no release branches.

| Version | Supported |
|---|---|
| Latest `main` | Yes |

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/daygle/LocaPeer-Relay/security/advisories/new)
(Security → Report a vulnerability). Do **not** open a public issue for
security bugs.

When reporting, include:

- A description of the issue and its impact
- Steps to reproduce (payloads or a minimal script)
- The commit you tested against
- A proposed fix, if you have one

Reports are acknowledged within a few days, and you should receive a
response with next steps (a fix, a mitigation, or a request for more
information) before any public disclosure.

## Scope

In scope:

- The relay server code in `src/` (protocol handling, event validation,
  storage)
- The Docker image and orchestration (`Dockerfile`, `docker-compose.yml`)
- The CI workflow (`.github/workflows/`)

Out of scope:

- The [LocaPeer](https://github.com/daygle/LocaPeer) mobile app
- Your deployment infrastructure (reverse proxy, TLS certificates, host OS)
- Third-party dependencies - report vulnerabilities in those to their
  respective projects; we track and update our own dependencies

## Security model

LocaPeer Relay is a public, self-hostable NIP-01 Nostr relay. There is no
authentication, authorization, or encryption at the relay level:

- **Anyone can read or write.** The relay has no concept of users and no
  NIP-42 authentication. Treat all content as public.
- **Events are verified before storage.** The event ID is recomputed and
  the Schnorr signature is validated against the `pubkey` before an event
  is accepted, stored, or relayed.
- **Limits bound resource use.** Message size, event size, tag count,
  filter cardinality, subscription count, query result count, connection
  count, per-connection message rate, and per-IP connection limits are all
  capped (see Configuration in the README) to blunt abuse and malformed
  input. The global connection cap, the per-IP concurrent cap, and the
  per-IP connection rate are all enforced across relay processes that share
  the same database, via expiring connection leases and a shared token
  bucket.
- **All database access is parameterized.** SQLite queries use prepared
  statements, so untrusted filter and event fields cannot inject SQL.
- **Malformed input is contained.** Parse and handler errors are caught
  per-message and answered with a `NOTICE`; a bad message never takes down
  the process.

## Hardening recommendations for operators

- **Terminate TLS at a reverse proxy** (HAProxy or nginx - see the README).
  The relay speaks plain `ws://`; exposing port 7777 directly means
  unencrypted traffic and no protection against abusive connections.
- **Restrict network access.** Bind the relay behind your proxy or firewall
  and only allow the proxy to reach port 7777.
- **Tune the limits for your expected load** (`MAX_SUBS`, `MAX_FILTERS`,
  `MAX_EVENT_TAGS`, `MAX_EVENT_SIZE`, `MAX_FILTER_ARRAY`,
  `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `IP_CONNECT_RATE`,
  `IP_CONNECT_BURST`, `RATE_LIMIT_MESSAGES`, `RATE_LIMIT_BURST`). The
  defaults are generous for a small self-hosted relay.
- **Back up the database.** Events live in the `relay-data` Docker volume
  (or the `DB_PATH` file) and are not recoverable otherwise.
- **Watch the logs.** Connection open/close and per-client error lines are
  written to stdout; forward them somewhere you can review.

## Known limitations

- The global `MAX_CONNECTIONS` cap, the per-IP concurrent cap, and the
  per-IP connection rate are shared across relay processes that use the
  same database, and all limits are intentionally generous by default. A
  distributed attacker rotating IPs can still open many connections from
  many addresses. Tighten the `MAX_*`, `IP_*`, and `RATE_LIMIT_*`
  variables, or put the relay behind a proxy, for stricter control.
- No content moderation or deletion. The relay implements NIP-01 only
  (no NIP-09 deletion, no NIP-42 auth), and events are stored forever.
- Events stored before an upgrade are not re-validated against newer
  verification logic.
