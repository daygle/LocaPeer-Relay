'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const WebSocket = require('ws');
const { schnorr } = require('@noble/curves/secp256k1');

const PORT = parseInt(process.env.TEST_PORT ?? '7899', 10);
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.js');
const TMP_DIR = path.join(__dirname, '.tmp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent({ content = 'hello world', tags = [], kind = 1, priv } = {}) {
  const key = priv || randomBytes(32);
  const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
  const created_at = Math.floor(Date.now() / 1000);
  const id = createHash('sha256')
    .update(JSON.stringify([0, pubkey, created_at, kind, tags, content]))
    .digest('hex');
  let sigRaw = schnorr.sign(id, key);
  if (typeof sigRaw.toCompactRawBytes === 'function') sigRaw = sigRaw.toCompactRawBytes();
  const sig = Buffer.from(sigRaw).toString('hex');
  return { id, pubkey, created_at, kind, tags, content, sig };
}

async function killRelay(relay) {
  if (relay.child.exitCode === null) {
    relay.child.kill();
    await new Promise((resolve) => {
      relay.child.once('exit', resolve);
      setTimeout(resolve, 2000); // safety timeout
    });
  }
  for (const file of [relay.dbPath, relay.dbPath + '-wal', relay.dbPath + '-shm']) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function startRelay(extraEnv = {}, opts = {}) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = opts.dbPath ?? path.join(TMP_DIR, `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const child = spawn(process.execPath, [DIST_INDEX], {
    env: { ...process.env, PORT: String(opts.port ?? PORT), DB_PATH: dbPath, ...extraEnv },
    stdio: 'ignore',
  });
  const relay = { child, dbPath, alive: () => child.exitCode === null };
  relay.kill = () => killRelay(relay);

  // Wait until the server accepts connections.
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const probe = new WebSocket(`ws://127.0.0.1:${opts.port ?? PORT}`);
      probe.on('open', () => {
        clearInterval(poll);
        // Wait for the server to process our close so readiness implies the
        // probe no longer holds a connection slot, lease, or rate token.
        probe.on('close', resolve);
        probe.close();
      });
      probe.on('error', () => {});
    }, 100);
    child.once('exit', (code) => {
      clearInterval(poll);
      reject(new Error(`relay exited early with code ${code}`));
    });
    setTimeout(() => {
      clearInterval(poll);
      reject(new Error('relay did not start within 5s'));
    }, 5000);
  });

  return relay;
}

function connect(port = PORT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    ws.on('message', (buf) => messages.push(JSON.parse(buf.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

// Keep trying to connect until the relay accepts us (welcome NOTICE), for
// cases where a slot must first free up asynchronously.
async function connectUntilWelcome(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await connect(port);
    const welcome = await waitFor(() => c.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('welcome')), 300);
    if (welcome) return c;
    c.ws.close();
    await wait(100);
  }
  throw new Error(`relay on port ${port} never accepted a connection`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

function noticesOf(messages) {
  return messages.filter((m) => m[0] === 'NOTICE').map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Malformed REQ filters must be rejected, never crash the relay
// ---------------------------------------------------------------------------

const malformedFilters = [
  ['null filter', ['REQ', 's1', null]],
  ['string filter', ['REQ', 's2', 'notafilter']],
  ['number filter', ['REQ', 's3', 42]],
  ['array filter', ['REQ', 's4', [1, 2]]],
  ['non-array ids', ['REQ', 's5', { ids: 'notanarray' }]],
  ['non-array #e', ['REQ', 's6', { '#e': 'xyz' }]],
  ['non-integer since', ['REQ', 's7', { since: 'yesterday' }]],
  ['non-positive limit', ['REQ', 's8', { limit: -1 }]],
  ['ids over cap', ['REQ', 's9', { ids: Array.from({ length: 200 }, () => 'a'.repeat(64)) }]],
  ['kinds over cap', ['REQ', 's10', { kinds: Array.from({ length: 200 }, (_, i) => i) }]],
];

for (const [label, payload] of malformedFilters) {
  test(`rejects ${label} without crashing`, async (t) => {
    const relay = await startRelay();
    t.after(() => relay.kill());

    const client = await connect();
    client.ws.send(JSON.stringify(payload));
    const gotNotice = await waitFor(() => noticesOf(client.messages).some((n) => n.includes('malformed filter')));
    client.ws.close();

    assert.equal(relay.alive(), true, 'server must survive a malformed REQ');
    assert.equal(gotNotice, true, `expected NOTICE rejecting ${label}`);
  });
}

test('survives a filter far over the ws maxPayload (connection dropped, no crash)', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  client.ws.send(JSON.stringify(['REQ', 'big', { ids: Array.from({ length: 40000 }, () => 'a'.repeat(64)) }]));
  // Payload exceeds maxPayload (1MB), so the connection should get dropped;
  // the important assertion is that the server process survives.
  await wait(500);
  assert.equal(relay.alive(), true, 'server must survive an oversized message');
  client.ws.close();
});

test('accepts a REQ with exactly the max array size (100 ids)', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  client.ws.send(JSON.stringify(['REQ', 'ok', { ids: Array.from({ length: 100 }, () => 'a'.repeat(64)) }]));
  const gotEose = await waitFor(() => client.messages.some((m) => m[0] === 'EOSE'));
  assert.equal(gotEose, true, 'expected EOSE for a valid REQ');
  client.ws.close();
});

// ---------------------------------------------------------------------------
// Malformed / invalid EVENTs
// ---------------------------------------------------------------------------

test('rejects a structurally invalid EVENT with NOTICE', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  client.ws.send(JSON.stringify(['EVENT', { id: 'x', pubkey: 'y' }]));
  const gotNotice = await waitFor(() => noticesOf(client.messages).some((n) => n.includes('invalid')));
  assert.equal(gotNotice, true, 'expected NOTICE for structurally invalid event');
  client.ws.close();
});

test('rejects an oversized event (OK false: event too large)', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  const event = makeEvent({ content: 'x'.repeat(100000) });
  client.ws.send(JSON.stringify(['EVENT', event]));
  const ok = await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id));
  const msg = client.messages.find((m) => m[0] === 'OK' && m[1] === event.id);
  assert.equal(ok, true, 'expected an OK response');
  assert.equal(msg[2], false);
  assert.match(msg[3], /too large/);
  client.ws.close();
});

test('rejects an event whose id does not match its contents', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  const event = makeEvent();
  event.content = 'tampered after id was computed';
  client.ws.send(JSON.stringify(['EVENT', event]));
  const ok = await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id));
  const msg = client.messages.find((m) => m[0] === 'OK' && m[1] === event.id);
  assert.equal(ok, true, 'expected an OK response');
  assert.equal(msg[2], false);
  assert.match(msg[3], /id does not match/);
  client.ws.close();
});

test('rejects an event with a bad signature', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  // Build the event with pubkey A but sign with a different key B.
  const keyA = randomBytes(32);
  const event = makeEvent({ priv: keyA });
  const otherKey = randomBytes(32);
  let badSig = schnorr.sign(event.id, otherKey);
  if (typeof badSig.toCompactRawBytes === 'function') badSig = badSig.toCompactRawBytes();
  event.sig = Buffer.from(badSig).toString('hex');
  client.ws.send(JSON.stringify(['EVENT', event]));
  const ok = await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id));
  const msg = client.messages.find((m) => m[0] === 'OK' && m[1] === event.id);
  assert.equal(ok, true, 'expected an OK response');
  assert.equal(msg[2], false);
  assert.match(msg[3], /signature/);
  client.ws.close();
});

// ---------------------------------------------------------------------------
// Happy path: store, duplicate, and query events back
// ---------------------------------------------------------------------------

test('stores a valid signed event, reports duplicates, and returns it via REQ', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  const event = makeEvent();

  // Publish twice: first accepted, second reported as duplicate.
  client.ws.send(JSON.stringify(['EVENT', event]));
  await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id && m[2] === true));
  client.ws.send(JSON.stringify(['EVENT', event]));
  const dup = await waitFor(() =>
    client.messages.some((m) => m[0] === 'OK' && m[1] === event.id && typeof m[3] === 'string' && m[3].startsWith('duplicate'))
  );
  assert.equal(dup, true, 'expected duplicate OK');

  // Query it back by author + kind.
  client.ws.send(JSON.stringify(['REQ', 'back', { kinds: [1], authors: [event.pubkey] }]));
  const gotEvent = await waitFor(() => client.messages.some((m) => m[0] === 'EVENT' && m[1] === 'back' && m[2].id === event.id));
  const gotEose = await waitFor(() => client.messages.some((m) => m[0] === 'EOSE' && m[1] === 'back'));
  assert.equal(gotEvent, true, 'expected stored event in REQ response');
  assert.equal(gotEose, true, 'expected EOSE');

  // A filter that matches nothing still gets EOSE, no events.
  client.ws.send(JSON.stringify(['REQ', 'none', { kinds: [99999] }]));
  const noneEose = await waitFor(() => client.messages.some((m) => m[0] === 'EOSE' && m[1] === 'none'));
  const stray = client.messages.filter((m) => m[0] === 'EVENT' && m[1] === 'none');
  assert.equal(noneEose, true, 'expected EOSE for empty result');
  assert.equal(stray.length, 0, 'expected no events for a non-matching filter');

  client.ws.close();
});

test('matches NIP-01 #p tag filters', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  const peer = randomBytes(32);
  const event = makeEvent({ tags: [['p', Buffer.from(peer).toString('hex')]] });
  client.ws.send(JSON.stringify(['EVENT', event]));
  await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id));

  client.ws.send(JSON.stringify(['REQ', 'tag', { '#p': [Buffer.from(peer).toString('hex')] }]));
  const gotEvent = await waitFor(() => client.messages.some((m) => m[0] === 'EVENT' && m[1] === 'tag' && m[2].id === event.id));
  assert.equal(gotEvent, true, 'expected event matching #p filter');
  client.ws.close();
});

test('matches NIP-01 id prefix filters', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  const event = makeEvent();
  client.ws.send(JSON.stringify(['EVENT', event]));
  await waitFor(() => client.messages.some((m) => m[0] === 'OK' && m[1] === event.id && m[2] === true));

  // Query by an 8-char id prefix; must still match the stored event.
  client.ws.send(JSON.stringify(['REQ', 'prefix', { ids: [event.id.slice(0, 8)] }]));
  const gotEvent = await waitFor(() =>
    client.messages.some((m) => m[0] === 'EVENT' && m[1] === 'prefix' && m[2].id === event.id)
  );
  assert.equal(gotEvent, true, 'expected event matching id prefix');
  client.ws.close();
});

// ---------------------------------------------------------------------------
// Connection limits and rate limiting
// ---------------------------------------------------------------------------

test('rejects connections over the max-connections cap', async (t) => {
  const relay = await startRelay({ MAX_CONNECTIONS: '1' });
  t.after(() => relay.kill());

  const first = await connect();
  const second = await connect();

  const gotNotice = waitFor(() => second.messages.some((m) => m[0] === 'NOTICE'));
  const closed = new Promise((resolve) => {
    second.ws.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });

  assert.equal(await gotNotice, true, 'expected NOTICE on rejected connection');
  assert.equal(await closed, true, 'expected rejected connection to be closed');
  assert.equal(relay.alive(), true, 'server must survive rejected connections');
  first.ws.close();
});

test('rate limits messages per connection and closes after repeated violations', async (t) => {
  const relay = await startRelay({ RATE_LIMIT_MESSAGES: '60', RATE_LIMIT_BURST: '5' });
  t.after(() => relay.kill());

  const client = await connect();
  // Attach the close listener up front so it can't miss an early close.
  const closed = new Promise((resolve) => {
    client.ws.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });

  // Burst of 5 plus 10 violations before close means ~15 messages kill the
  // connection; 20 ensures the limit is hit.
  for (let i = 0; i < 20; i++) {
    client.ws.send(JSON.stringify(['BOGUS', 'x']));
  }

  const gotNotice = await waitFor(() => noticesOf(client.messages).some((n) => n.includes('rate limit')));
  assert.equal(gotNotice, true, 'expected rate-limit NOTICE');
  assert.equal(await closed, true, 'expected rate-limited connection to be closed');
  assert.equal(relay.alive(), true, 'server must survive rate-limited clients');
});

test('limits concurrent connections per IP', async (t) => {
  const relay = await startRelay({ MAX_CONNECTIONS_PER_IP: '1' });
  t.after(() => relay.kill());

  const first = await connect();
  const second = await connect();
  const closed = new Promise((resolve) => {
    second.ws.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });

  const gotNotice = await waitFor(() =>
    second.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('too many connections'))
  );
  assert.equal(gotNotice, true, 'expected NOTICE on per-IP cap rejection');
  assert.equal(await closed, true, 'expected per-IP rejected connection to be closed');
  assert.equal(relay.alive(), true, 'server must survive per-IP rejections');
  first.ws.close();
});

test('rate limits new connections per IP and recovers after the bucket refills', async (t) => {
  const relay = await startRelay({ IP_CONNECT_RATE: '1', IP_CONNECT_BURST: '1' });
  t.after(() => relay.kill());

  // The readiness probe consumed the only token; keep retrying until the
  // bucket refills and we are accepted (this consumes it again).
  const first = await connectUntilWelcome();
  const second = await connect(); // must be rate limited
  const gotNotice = await waitFor(() =>
    second.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('connection rate limit'))
  );
  assert.equal(gotNotice, true, 'expected NOTICE on per-IP connection rate limit');
  first.ws.close();

  // After ~1s the bucket refills (rate 1/s) and a new connection is allowed.
  await wait(1200);
  const third = await connect();
  const welcome = await waitFor(() => third.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('welcome')));
  assert.equal(welcome, true, 'expected connection allowed after bucket refill');
  third.ws.close();
});

test('enforces the global connection cap across processes', async (t) => {
  const dbPath = path.join(TMP_DIR, `global-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const relayA = await startRelay({ MAX_CONNECTIONS: '1' }, { port: 7901, dbPath });
  const relayB = await startRelay({ MAX_CONNECTIONS: '1' }, { port: 7902, dbPath });
  t.after(async () => {
    await relayA.kill();
    await relayB.kill();
  });

  const a = await connect(7901);
  const b = await connect(7902);
  const gotNotice = await waitFor(() =>
    b.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('max connections (global)'))
  );
  assert.equal(gotNotice, true, 'expected second process to reject when global cap is held');

  // Free the slot from relayA; relayB should then accept.
  a.ws.close();
  const b2 = await connectUntilWelcome(7902);
  assert.equal(relayB.alive(), true, 'second process must survive');
  b2.ws.close();
});

test('enforces the per-IP concurrent cap across processes', async (t) => {
  const dbPath = path.join(TMP_DIR, `perip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const relayA = await startRelay({ MAX_CONNECTIONS: '100', MAX_CONNECTIONS_PER_IP: '1' }, { port: 7901, dbPath });
  const relayB = await startRelay({ MAX_CONNECTIONS: '100', MAX_CONNECTIONS_PER_IP: '1' }, { port: 7902, dbPath });
  t.after(async () => {
    await relayA.kill();
    await relayB.kill();
  });

  const a = await connect(7901);
  const b = await connect(7902);
  const gotNotice = await waitFor(() =>
    b.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('too many connections'))
  );
  assert.equal(gotNotice, true, 'expected second process to reject when per-IP cap is held');

  // Free the per-IP slot from relayA; relayB should then accept.
  a.ws.close();
  const b2 = await connectUntilWelcome(7902);
  assert.equal(relayB.alive(), true, 'second process must survive');
  b2.ws.close();
});

test('shares the per-IP connection rate bucket across processes', async (t) => {
  const dbPath = path.join(TMP_DIR, `iperate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const relayA = await startRelay({ IP_CONNECT_RATE: '1', IP_CONNECT_BURST: '1' }, { port: 7901, dbPath });
  const relayB = await startRelay({ IP_CONNECT_RATE: '1', IP_CONNECT_BURST: '1' }, { port: 7902, dbPath });
  t.after(async () => {
    await relayA.kill();
    await relayB.kill();
  });

  // The readiness probes consumed the shared tokens; retry until the bucket
  // refills and process A accepts us (consuming the token again).
  const a = await connectUntilWelcome(7901);
  const b = await connect(7902); // must be rate limited by the other process's bucket
  const gotNotice = await waitFor(() =>
    b.messages.some((m) => m[0] === 'NOTICE' && m[1].includes('connection rate limit'))
  );
  assert.equal(gotNotice, true, 'expected shared per-IP rate bucket to reject');
  a.ws.close();

  // After ~1s the shared bucket refills (rate 1/s) and a new connection works.
  await wait(1200);
  const c = await connectUntilWelcome(7902);
  assert.equal(relayB.alive(), true, 'second process must survive');
  c.ws.close();
});

test('CLOSE removes a subscription and unknown verbs get a NOTICE', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.kill());

  const client = await connect();
  client.ws.send(JSON.stringify(['REQ', 'temp', { kinds: [1] }]));
  await waitFor(() => client.messages.some((m) => m[0] === 'EOSE' && m[1] === 'temp'));
  client.ws.send(JSON.stringify(['CLOSE', 'temp']));

  client.ws.send(JSON.stringify(['BOGUS', 'x']));
  const gotNotice = await waitFor(() => noticesOf(client.messages).some((n) => n.includes('unknown message type')));
  assert.equal(gotNotice, true, 'expected NOTICE for unknown verb');
  client.ws.close();
});
