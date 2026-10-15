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

async function makeEvent() {
  const { generateSecretKey, getPublicKey, finalizeEvent } = await loadSigner();
  const sk = generateSecretKey(); // throwaway, never printed or saved
  const to = getPublicKey(generateSecretKey()); // random recipient: nobody can read this event
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 3600),
      tags: [['p', to]],
      content: randomBytes(48).toString('base64'),
    },
    sk,
  );
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
function exchange(relay, frames, until) {
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
        if (until(frame)) done('ok');
      } catch {
        /* ignore non-JSON */
      }
    };
  });
}

const short = (v) => String(v ?? '').slice(0, 80);

async function vetRelay(relay) {
  const out = { relay, nip11: await fetchNip11(relay) };
  const ev = await makeEvent();
  const pub = await exchange(relay, [['EVENT', ev]], (f) => f[0] === 'OK' && f[1] === ev.id);
  const ok = pub.seen.find((f) => f[0] === 'OK' && f[1] === ev.id);
  out.publish = {
    accepted: ok ? ok[2] === true : false,
    reason: ok ? short(ok[3]) : pub.note,
    authChallenge: pub.seen.some((f) => f[0] === 'AUTH'),
  };
  // Read back by id with no AUTH: a relay that gates kind-1059 reads says so.
  const sub = 'v' + randomBytes(4).toString('hex');
  const rd = await exchange(
    relay,
    [['REQ', sub, { ids: [ev.id] }]],
    (f) => f[0] === 'EOSE' || f[0] === 'CLOSED',
  );
  const closed = rd.seen.find((f) => f[0] === 'CLOSED');
  out.read = {
    readBack: rd.seen.some((f) => f[0] === 'EVENT' && f[2]?.id === ev.id),
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
