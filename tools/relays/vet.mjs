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
// The read-back uses the sync's own filter (kinds [1059], "#p", since) and, for comparison, by id.
// Sends ONE tiny kind-1059 event per relay, signed by a throwaway key made for this run. The
// event carries random bytes, never a real envelope; the key is never printed or saved.
// Relay address checks (04 §4, 07 §4.2), applied to EVERY URL before any connection, the same
// functions the node relay connector uses: `isAllowedRelayUrl` (wss only, a lowercase DNS name, no
// IP literal, no local name) from @4thtech-io/types; then the host is resolved and EVERY answer must
// pass `isGloballyRoutable` from @4thtech-io/transport-nostr. The connection is then pinned to the
// checked address (no second lookup), with no redirects. A URL that fails is reported as refused
// and never contacted. Needs the packages built (`pnpm -r build`) for those functions.
// Signing uses nostr-tools, resolved from packages/transport-nostr, and the WebSocket client is
// `ws`, resolved from packages/node (both existing allowlisted dependencies; this script adds none).
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
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

const MAX_NIP11_BYTES = 65_536;

/**
 * Pure apart from the injected `resolve`: the 04 §4 address check for one URL. Returns the address
 * to pin, or a refusal. `deps` = { isAllowedRelayUrl, isGloballyRoutable, resolve(host) }.
 */
export async function checkRelayTarget(url, deps) {
  if (typeof url !== 'string' || !url.startsWith('wss://')) {
    return { ok: false, reason: 'not a wss:// URL' };
  }
  if (!deps.isAllowedRelayUrl(url)) {
    return { ok: false, reason: 'fails the relay URL rule (04 §4)' };
  }
  const host = /^wss:\/\/([^/:]+)/.exec(url)?.[1];
  if (host === undefined) return { ok: false, reason: 'no host' };
  let answers;
  try {
    answers = await deps.resolve(host);
  } catch {
    return { ok: false, reason: 'host did not resolve' };
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, reason: 'host did not resolve' };
  }
  for (const a of answers) {
    if (typeof a !== 'string' || a.includes('%') || isIP(a) === 0 || !deps.isGloballyRoutable(a)) {
      return { ok: false, reason: 'resolves to an address that is not globally routable' };
    }
  }
  return { ok: true, url, host, address: answers[0], family: isIP(answers[0]) };
}

async function loadTrusted() {
  const dist = (pkg) => new URL(`../../packages/${pkg}/dist/index.js`, import.meta.url);
  let types;
  let transport;
  try {
    types = await import(dist('types').href);
    transport = await import(dist('transport-nostr').href);
  } catch {
    throw new Error('build the packages first: pnpm -r build (the address check needs them)');
  }
  return {
    isAllowedRelayUrl: types.isAllowedRelayUrl,
    isGloballyRoutable: transport.isGloballyRoutable,
    resolve: async (host) =>
      (await dns.promises.lookup(host, { all: true, order: 'verbatim' })).map((e) => e.address),
  };
}

function loadWs() {
  const req = createRequire(new URL('../../packages/node/package.json', import.meta.url));
  return req('ws');
}

// A lookup that returns only the address the check approved (Node may ask for `all` answers).
const pin = (target) => (_host, options, cb) =>
  options?.all === true
    ? cb(null, [{ address: target.address, family: target.family }])
    : cb(null, target.address, target.family);

// NIP-11 over HTTPS to the checked address: SNI and Host from the name, no redirects, 64 KiB cap.
function fetchNip11(target) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: target.host,
        path: '/',
        method: 'GET',
        headers: { accept: 'application/nostr+json' },
        lookup: pin(target),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ error: `HTTP ${res.statusCode}` });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_NIP11_BYTES) {
            req.destroy();
            resolve({ error: 'NIP-11 document too large' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(judgeNip11(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            resolve({ error: 'NIP-11 not JSON' });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ error: 'error' }));
    req.end();
  });
}

// One WebSocket exchange to the checked, pinned address: send frames, collect the frames back.
function exchange(target, frames, until, react) {
  const WebSocket = loadWs();
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
      ws = new WebSocket(target.url, {
        lookup: pin(target),
        followRedirects: false,
        maxPayload: 131_072, // MAX_FRAME_BYTES (04 §3.1.1)
        handshakeTimeout: TIMEOUT_MS,
      });
    } catch {
      done('connect-failed');
      return;
    }
    ws.on('open', () => frames.forEach((f) => ws.send(JSON.stringify(f))));
    ws.on('error', () => done('error'));
    ws.on('close', () => done('closed'));
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString());
        seen.push(frame);
        react?.(frame, (f) => ws.send(JSON.stringify(f)));
        if (until(frame)) done('ok');
      } catch {
        /* ignore non-JSON */
      }
    });
  });
}

const short = (v) => String(v ?? '').slice(0, 80);

const isEvent = (f, id) => f[0] === 'EVENT' && f[2]?.id === id;

/**
 * Reads with the sync's exact filter shape (sync.ts: kinds [1059], "#p", since). With `withAuth`,
 * answers a NIP-42 AUTH challenge with the throwaway key and asks again.
 */
async function readByP(target, made, withAuth) {
  const { ev, pk } = made;
  const filter = { kinds: [1059], '#p': [pk], since: ev.created_at - 60 };
  const id = randomBytes(4).toString('hex');
  let authed = false;
  let authEvent;
  const res = await exchange(
    target,
    [['REQ', `p${id}`, filter]],
    // Without AUTH stop at the first answer; with AUTH wait for the answer to the second REQ.
    (f) => (f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === (authed ? `q${id}` : `p${id}`),
    (f, send) => {
      if (f[0] === 'AUTH' && withAuth && typeof f[1] === 'string' && !authed) {
        authed = true;
        authEvent = made.authEvent(target.url, f[1]);
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

async function vetRelay(relay, deps) {
  const target = await checkRelayTarget(relay, deps);
  if (!target.ok) return { relay, refused: target.reason }; // never contacted
  const out = { relay, nip11: await fetchNip11(target) };
  const made = await makeEvent();
  const { ev } = made;
  const pub = await exchange(target, [['EVENT', ev]], (f) => f[0] === 'OK' && f[1] === ev.id);
  const ok = pub.seen.find((f) => f[0] === 'OK' && f[1] === ev.id);
  out.publish = {
    accepted: ok ? ok[2] === true : false,
    reason: ok ? short(ok[3]) : pub.note,
    authChallenge: pub.seen.some((f) => f[0] === 'AUTH'),
  };
  // The sync's read: by #p since a cursor, without AUTH; then with AUTH if the relay challenged.
  out.readByP = await readByP(target, made, false);
  if (!out.readByP.readByP && out.readByP.authChallenge) {
    out.readByPAuth = await readByP(target, made, true);
  }
  // By id, for comparison only: the sync never reads by id.
  const sub = 'v' + randomBytes(4).toString('hex');
  const rd = await exchange(
    target,
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

async function recheck(file, deps) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const results = [];
  for (const r of saved) {
    if (r.retention === undefined) continue; // a refused relay has nothing to read back
    const target = await checkRelayTarget(r.relay, deps); // the saved file is input too
    if (!target.ok) {
      results.push({ relay: r.relay, refused: target.reason });
      continue;
    }
    const sub = 'r' + randomBytes(4).toString('hex');
    const rd = await exchange(
      target,
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
  // Every non-flag argument is a relay URL and is checked (a non-wss one is refused, not skipped).
  const given = argv.filter((a, i) => !a.startsWith('--') && i !== ri + 1);
  const relays = given.length > 0 ? given : await loadDefaultRelays();
  if (!live) {
    console.log(planText(relays));
    console.log('\nNot run: pass --live to contact the relays.');
    return;
  }
  if (ri >= 0) {
    console.log(JSON.stringify(await recheck(argv[ri + 1], await loadTrusted()), null, 2));
    return;
  }
  const deps = await loadTrusted();
  const results = [];
  for (const relay of relays) results.push(await vetRelay(relay, deps));
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
