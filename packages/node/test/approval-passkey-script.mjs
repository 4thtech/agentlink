// M1-8e same-user script against the running approval server with the localhost passkey enabled
// (10 M1-8; 08 §1; 04 §2.3.1, §2.5; D-67). Run by owner-passkey.test.ts as a separate Node process
// with the same OS user's access. It holds the session cookie and the page's CSRF token (worst
// case), the keychain stand-in (the `owner` and `owner-passkey` items included), the public passkey
// data (credential ID, user handle, PRF salt, a well-formed authenticator data for `localhost` with
// UP and UV set, which any process can build) and `AGENTLINK_OWNER_*` variables. What it does not
// have is the passkey's PRF output, which only the authenticator makes after the owner's gesture.
// It tries every passkey-shaped request it can think of and writes the HTTP status of each attempt
// to the job's outFile. The parent checks that none was applied.
//
// Usage: node approval-passkey-script.mjs <job.json>
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import process from 'node:process';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const attempts = [];
const b64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

function send(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: job.port,
        path,
        method,
        headers: { Host: `localhost:${job.port}`, ...headers },
        setHost: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', () => resolve(0));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const page = {
  Cookie: job.cookie,
  Origin: job.origin,
  'Content-Type': 'application/octet-stream',
  'X-AgentLink-CSRF': job.csrf,
  'Sec-Fetch-Site': 'same-origin',
};

async function attempt(name, path, options) {
  attempts.push({ name, status: await send(path, options) });
}

/** The passkey presence body: u16be-length-prefixed credId, authData, userHandle, PRF output. */
function assertion(credentialId, authenticatorData, userHandle, prfOutput) {
  const parts = [credentialId, authenticatorData, userHandle, prfOutput];
  const out = [];
  for (const part of parts) {
    out.push(Buffer.from([part.length >> 8, part.length & 0xff]), Buffer.from(part));
  }
  return Buffer.concat(out);
}

const credentialId = b64(job.credentialId);
const authenticatorData = b64(job.authenticatorData);
const userHandle = b64(job.userHandle);

// Every 32-byte value the script can find or make: zeros, pseudo-random bytes, the PRF salt, the
// owner key, slices of every keychain item (the ALKP blob's nonce and ciphertext included).
const prfGuesses = [new Uint8Array(32), new Uint8Array(32).fill(0xff), b64(job.prfSalt), userHandle];
const random = new Uint8Array(32);
for (let i = 0; i < 32; i += 1) random[i] = Math.floor(Math.random() * 256);
prfGuesses.push(random);
try {
  const items = JSON.parse(readFileSync(job.keychainFile, 'utf8'));
  for (const value of Object.values(items)) {
    const bytes = b64(String(value));
    for (let at = 0; at + 32 <= bytes.length; at += 16) prfGuesses.push(bytes.slice(at, at + 32));
  }
} catch {
  // no keychain stand-in
}
for (const value of [process.env.AGENTLINK_OWNER_CODE, process.env.AGENTLINK_OWNER_PASSPHRASE]) {
  if (value) prfGuesses.push(new Uint8Array(Buffer.from(value.padEnd(32, '\0').slice(0, 32))));
}
if (job.leakedPrf) prfGuesses.push(b64(job.leakedPrf));

for (const { approvalId, digest } of job.approvals) {
  for (const decision of ['approve', 'deny']) {
    const path = `/api/approvals/${approvalId}/${decision}`;
    const headers = { ...page, 'X-AgentLink-Digest': digest, 'X-AgentLink-Presence': 'passkey' };
    await attempt(`${decision} passkey no body`, path, { method: 'POST', headers });
    await attempt(`${decision} passkey no PRF`, path, {
      method: 'POST',
      headers,
      body: assertion(credentialId, authenticatorData, userHandle, new Uint8Array(0)),
    });
    for (const prf of prfGuesses) {
      await attempt(`${decision} passkey guess`, path, {
        method: 'POST',
        headers,
        body: assertion(credentialId, authenticatorData, userHandle, prf),
      });
    }
  }
}

// Registering a passkey of its own (to replace or add one) needs the owner code.
const own = new Uint8Array(16).fill(7);
for (const code of ['', 'AAAA BBBB CCCC DDDD EEEE FFFF', job.csrf]) {
  const secret = Buffer.from(code, 'utf8');
  const body = Buffer.concat([
    Buffer.from([secret.length >> 8, secret.length & 0xff]),
    secret,
    assertion(own, authenticatorData, userHandle, random),
  ]);
  await attempt('register own passkey', '/api/owner/passkey', { method: 'POST', headers: page, body });
}

writeFileSync(job.outFile, JSON.stringify({ attempts }));
