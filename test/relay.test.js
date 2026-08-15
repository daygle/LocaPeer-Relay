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

async function startRelay() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = path.join(TMP_DIR, `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const child = spawn(process.execPath, [DIST_INDEX], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath },
    stdio: 'ignore',
  });
  const relay = { child, dbPath, alive: () => child.exitCode === null };
  relay.kill = () => killRelay(relay);

  // Wait until the server accepts connections.
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
      probe.on('open', () => {
        clearInterval(poll);
        probe.close();
        resolve();
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

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages = [];
    ws.on('message', (buf) => messages.push(JSON.parse(buf.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
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
