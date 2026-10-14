// M1-8c same-user script (10 M1-8; 04 §2.5, §2.5.2; D-67, D-68). Run by owner-same-user.test.ts as a
// separate Node process with the same OS user's access: it reads every file under the test HOME
// (the agent's files, the database stand-in and the keychain stand-in, the `owner` item included)
// and may write the store and the keychain. Within the test's stated scope it does NOT modify the
// installed package and does NOT read another process's memory (G-1, D-67).
//
// It tries every path to an owner signature it has and writes what it produced as JSON to the job's outFile.
// The parent test verifies that none of it is a valid owner signature.
//
// Usage: node same-user-script.mjs <job.json>; the result is written to job.outFile as JSON.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { TextDecoder, TextEncoder } from 'node:util';
import {
  KEY_LABELS,
  TAGS,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  randomBytes,
  sha256,
  taggedHash,
} from '@agentlink/crypto';
import {
  bip340PublicKey,
  bip340Sign,
  deriveSecretKey,
  generateSecretCode,
  newKeystoreKek,
  openOwnerSeed,
  sealOwnerSeed,
} from '@agentlink/crypto/keystore';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const expected = {
  ownerEvm: decodeHex(job.owner.ownerEvm),
  ownerNostr: decodeHex(job.owner.ownerNostr),
};

/** Every file under HOME, as bytes: what a same-user script can read. */
function readAll(dir) {
  const files = [];
  // Directory entries carry their type, so there is no stat-then-read race (CodeQL js/file-system-race).
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...readAll(path));
    else if (entry.isFile()) files.push({ path, bytes: readFileSync(path) });
  }
  return files;
}
const files = readAll(job.home);
const keychain = JSON.parse(readFileSync(job.keychainFile, 'utf8'));
const item = (account) =>
  keychain[account] === undefined ? undefined : decodeBase64url(keychain[account]);
const db = JSON.parse(readFileSync(job.dbFile, 'utf8'));

const ownerDigest = (body) => taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
const signWith = (secretKey, body) => encodeHex(bip340Sign(secretKey, ownerDigest(body)));
const bodies = db.pending.map((p) => p.body);
const attempts = [];

// 1. Sign with every key the script can derive from the agent's own keychain item.
const agentSeed = item(job.agentId);
for (const label of [KEY_LABELS.nostr, KEY_LABELS.evm, KEY_LABELS.drop]) {
  const key = deriveSecretKey(agentSeed, label, 0);
  for (const body of bodies)
    attempts.push({ name: `agent ${label}`, body, sig: signWith(key, body) });
  // The same key under the owner field it controls: still not the card's owner key.
  for (const body of bodies) {
    const forged = { ...body, owner: encodeHex(bip340PublicKey(key)) };
    attempts.push({ name: `agent ${label} as owner`, body: forged, sig: signWith(key, forged) });
  }
}
// 2. Random signatures.
for (const body of bodies) attempts.push({ name: 'random', body, sig: encodeHex(randomBytes(64)) });

// 3. Open the owner item without the owner code: environment, empty, agent seed, guesses, and every
//    code-shaped string found in any file.
const guesses = [
  process.env.AGENTLINK_OWNER_CODE,
  process.env.AGENTLINK_OWNER_PASSPHRASE,
  '',
  encodeHex(agentSeed),
  'password1234',
  new TextDecoder().decode(generateSecretCode()),
];
for (const { bytes } of files) {
  for (const match of bytes.toString('latin1').matchAll(/[A-Z2-7]{4}(?:[ -]?[A-Z2-7]{4}){5}/g)) {
    guesses.push(match[0]);
  }
}
let opened = 0;
const ownerBlob = item('owner');
for (const guess of guesses) {
  if (guess === undefined || ownerBlob === undefined) continue;
  try {
    const seed = await openOwnerSeed(
      ownerBlob,
      { secret: new TextEncoder().encode(guess), source: 'prompt' },
      expected,
      { fileKeystoreMachine: false },
    );
    opened += 1;
    const key = deriveSecretKey(seed, KEY_LABELS.nostr, 0);
    for (const body of bodies)
      attempts.push({ name: 'opened owner item', body, sig: signWith(key, body) });
  } catch {
    // does not unlock
  }
}

// 4. A batch the owner reviewed and signed (in the store): add a pending request, drop one, or point
//    an item at another action, keeping the owner's signature or re-signing with the agent key.
if (db.signedBatch !== undefined) {
  const { body, sig } = db.signedBatch;
  const items = body.params.items;
  const extra = {
    approvalId: db.unreviewed.approvalId,
    actionDigest: db.unreviewed.actionDigest,
    decision: 'approve',
  };
  const added = [...items, extra].sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1));
  const variants = [
    { ...body, params: { items: added } },
    { ...body, params: { items: items.slice(1) } },
    {
      ...body,
      params: {
        items: [{ ...items[0], actionDigest: db.unreviewed.actionDigest }, ...items.slice(1)],
      },
    },
    { ...body, nonce: encodeBase64url(randomBytes(16)) },
  ];
  const agentNostr = deriveSecretKey(agentSeed, KEY_LABELS.nostr, 0);
  for (const variant of variants) {
    attempts.push({ name: 'batch, owner sig kept', body: variant, sig });
    attempts.push({
      name: 'batch, agent re-signed',
      body: variant,
      sig: signWith(agentNostr, variant),
    });
  }
}

// 5. Plant an owner item under a code the script knows, with its own seed, and sign with that seed.
const plantedSeed = randomBytes(32);
const plantedCode = generateSecretCode();
const kek = await newKeystoreKek(
  'ALKO',
  { secret: plantedCode, secretKind: 1, source: 'prompt' },
  KDF,
);
const planted = await sealOwnerSeed(kek, plantedSeed, {
  destination: 'local',
  fileKeystoreMachine: false,
});
keychain.owner = encodeBase64url(planted);
writeFileSync(job.keychainFile, JSON.stringify(keychain));
const plantedKey = deriveSecretKey(plantedSeed, KEY_LABELS.nostr, 0);
for (const body of bodies)
  attempts.push({ name: 'planted owner', body, sig: signWith(plantedKey, body) });

writeFileSync(
  job.outFile,
  JSON.stringify({
    attempts,
    opened,
    guesses: guesses.length,
    plantedCode: new TextDecoder().decode(plantedCode),
  }),
);
