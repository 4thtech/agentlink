#!/usr/bin/env node
// M1-18 (D-75): opt-in relay vetting. NOT run in CI. Offline-safe: without --live it only prints
// the plan and exits 0 without opening a connection.
//
//   node tools/relays/vet.mjs                          print the plan (no network)
//   node tools/relays/vet.mjs --live                   run the checks against the default relays
//   node tools/relays/vet.mjs --live wss://a wss://b   run against the given relays
//   node tools/relays/vet.mjs --live --recheck <file>  read back the events a earlier run saved
//
// Checks (docs/runbooks/relay-vetting.md): (1) kind 1059 accepted and read back, (2) NIP-11
// max_message_length against the largest valid wrap frame, (3) retention (method: the run saves
// the event id; a later --recheck says whether it is still there), (4) read auth (NIP-42).
// Sends ONE tiny kind-1059 event per relay, signed by a throwaway key made for this run. The
// event carries random bytes, never a real envelope; the key is never printed or saved.
// Signing uses nostr-tools, resolved from packages/transport-nostr (an allowlisted dependency);
// this script adds no dependency. Uses the Node 22 global WebSocket and fetch.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Mirror of DEFAULT_RELAYS in packages/transport-nostr/src/default-relays.ts (D-75). */
async function loadDefaultRelays() {
  const src = readFileSync(
    new URL('../../packages/transport-nostr/src/default-relays.ts', import.meta.url),
    'utf8',
  );
  return [...src.matchAll(/'(wss:\/\/[^']+)'/g)].map((m) => m[1]);
}

/** 04 §3.1.1: the largest valid gift wrap is about 88 KB as an EVENT frame; frames are capped at 128 KiB. */
export const MIN_MAX_MESSAGE_LENGTH = 90_112;
const TIMEOUT_MS = 10_000;

export function planText(relays) {
  return [
    'relay vetting plan (no network unless --live):',
    ...relays.map((r) => `  - ${r}`),
    'per relay: NIP-11 limits, kind-1059 publish and read back, NIP-42 AUTH, retention id saved',
  ].join('\n');
}

/** Pure: judge a NIP-11 document against the envelope limits. */
export function judgeNip11(doc) {
  const limit = doc?.limitation?.max_message_length;
  let sizeVerdict = 'unknown';
  if (Number.isSafeInteger(limit) && limit > 0) {
    sizeVerdict = limit >= MIN_MAX_MESSAGE_LENGTH ? 'ok' : 'too-small';
  }
  return {
    maxMessageLength: Number.isSafeInteger(limit) ? limit : null,
    sizeVerdict,
    supportsNip42: Array.isArray(doc?.supported_nips) && doc.supported_nips.includes(42),
    authRequired: doc?.limitation?.auth_required === true,
  };
}

async function loadSigner() {
  const req = createRequire(
    new URL('../../packages/transport-nostr/package.json', import.meta.url),
  );
  const mod = await import(pathToFileURL(req.resolve('nostr-tools/pure')).href);
  return mod.default ?? mod; // the CommonJS build arrives as the default export
}

// The throwaway key signs the event, is its `p` recipient and answers NIP-42 AUTH, so a relay that
// gates kind-1059 reads to the authenticated recipient can be tested end to end. It is never
// printed or saved.
async function makeEvent() {
  const signer = await loadSigner();
  const sk = signer.generateSecretKey();
  const pk = signer.getPublicKey(sk);
  const ev = signer.finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 3600),
      tags: [['p', pk]],
      content: randomBytes(48).toString('base64'),
    },
    sk,
  );
  const authEvent = (relay, challenge) =>
    signer.finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['relay', relay],
          ['challenge', challenge],
        ],
        content: '',
      },
      sk,
    );
  return { ev, pk, authEvent };
}

async function fetchNip11(relay) {
  try {
    const res = await fetch(relay.replace(/^wss:/, 'https:'), {
      headers: { accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return judgeNip11(await res.json());
  } catch (e) {
    return { error: String(e?.name ?? 'error') };
  }
}

// One WebSocket exchange: send frames, resolve with the frames that came back.
function exchange(relay, frames, until, react) {
  return new Promise((resolve) => {
    const seen = [];
    let ws;
    let timer;
    const done = (note) => {
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* closing a dead socket */
      }
      resolve({ seen, note });
    };
    timer = setTimeout(() => done('timeout'), TIMEOUT_MS);
    try {
      ws = new WebSocket(relay);
    } catch {
      done('connect-failed');
      return;
    }
    ws.onopen = () => frames.forEach((f) => ws.send(JSON.stringify(f)));
    ws.onerror = () => done('error');
    ws.onclose = () => done('closed');
    ws.onmessage = (m) => {
      try {
        const frame = JSON.parse(String(m.data));
        seen.push(frame);
        react?.(frame, (f) => ws.send(JSON.stringify(f)));
        if (until(frame)) done('ok');
      } catch {
        /* ignore non-JSON */
      }
    };
  });
}

const short = (v) => String(v ?? '').slice(0, 80);

const isEvent = (f, id) => f[0] === 'EVENT' && f[2]?.id === id;

/**
 * Reads with the sync's exact filter shape (sync.ts: kinds [1059], "#p", since). With `withAuth`,
 * answers a NIP-42 AUTH challenge with the throwaway key and asks again.
 */
async function readByP(relay, made, withAuth) {
  const { ev, pk } = made;
  const filter = { kinds: [1059], '#p': [pk], since: ev.created_at - 60 };
  const id = randomBytes(4).toString('hex');
  let authed = false;
  let authEvent;
  const res = await exchange(
    relay,
    [['REQ', `p${id}`, filter]],
    // Without AUTH stop at the first answer; with AUTH wait for the answer to the second REQ.
    (f) => (f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === (authed ? `q${id}` : `p${id}`),
    (f, send) => {
      if (f[0] === 'AUTH' && withAuth && typeof f[1] === 'string' && !authed) {
        authed = true;
        authEvent = made.authEvent(relay, f[1]);
        send(['AUTH', authEvent]);
        setTimeout(() => send(['REQ', `q${id}`, filter]), 800);
      }
    },
  );
  const closed = res.seen.filter((f) => f[0] === 'CLOSED');
  const authOk = authEvent && res.seen.find((f) => f[0] === 'OK' && f[1] === authEvent.id);
  return {
    readByP: res.seen.some((f) => isEvent(f, ev.id)),
    authChallenge: res.seen.some((f) => f[0] === 'AUTH'),
    authAttempted: authed,
    authAccepted: authed ? authOk?.[2] === true : null,
    authReason: authOk ? short(authOk[3]) : null,
    note: closed.length > 0 ? short(closed[closed.length - 1][2]) : res.note,
  };
}

async function vetRelay(relay) {
  const out = { relay, nip11: await fetchNip11(relay) };
  const made = await makeEvent();
  const { ev } = made;
  const pub = await exchange(relay, [['EVENT', ev]], (f) => f[0] === 'OK' && f[1] === ev.id);
  const ok = pub.seen.find((f) => f[0] === 'OK' && f[1] === ev.id);
  out.publish = {
    accepted: ok ? ok[2] === true : false,
    reason: ok ? short(ok[3]) : pub.note,
    authChallenge: pub.seen.some((f) => f[0] === 'AUTH'),
  };
  // The sync's read: by #p since a cursor, without AUTH; then with AUTH if the relay challenged.
  out.readByP = await readByP(relay, made, false);
  if (!out.readByP.readByP && out.readByP.authChallenge) {
    out.readByPAuth = await readByP(relay, made, true);
  }
  // By id, for comparison only: the sync never reads by id.
  const sub = 'v' + randomBytes(4).toString('hex');
  const rd = await exchange(
    relay,
    [['REQ', sub, { ids: [ev.id] }]],
    (f) => f[0] === 'EOSE' || f[0] === 'CLOSED',
  );
  const closed = rd.seen.find((f) => f[0] === 'CLOSED');
  out.readById = {
    readBack: rd.seen.some((f) => isEvent(f, ev.id)),
    authRequiredForRead:
      rd.seen.some((f) => f[0] === 'AUTH') || /auth/i.test(String(closed?.[2] ?? '')),
    note: closed ? short(closed[2]) : rd.note,
  };
  out.retention = { eventId: ev.id, savedAt: new Date().toISOString() };
  return out;
}

async function recheck(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const results = [];
  for (const r of saved) {
    const sub = 'r' + randomBytes(4).toString('hex');
    const rd = await exchange(
      r.relay,
      [['REQ', sub, { ids: [r.retention.eventId] }]],
      (f) => f[0] === 'EOSE' || f[0] === 'CLOSED',
    );
    results.push({
      relay: r.relay,
      stillThere: rd.seen.some((f) => f[0] === 'EVENT'),
      ageMinutes: Math.round((Date.now() - Date.parse(r.retention.savedAt)) / 60000),
    });
  }
  return results;
}

async function main(argv) {
  const live = argv.includes('--live');
  const ri = argv.indexOf('--recheck');
  const given = argv.filter((a) => a.startsWith('wss://'));
  const relays = given.length > 0 ? given : await loadDefaultRelays();
  if (!live) {
    console.log(planText(relays));
    console.log('\nNot run: pass --live to contact the relays.');
    return;
  }
  if (ri >= 0) {
    console.log(JSON.stringify(await recheck(argv[ri + 1]), null, 2));
    return;
  }
  const results = [];
  for (const relay of relays) results.push(await vetRelay(relay));
  const out = `relay-vet-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nsaved ${out}; re-run later with --live --recheck ${out} for retention`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
