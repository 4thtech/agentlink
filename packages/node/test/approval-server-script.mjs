// M1-8d same-user script against the running approval server (10 M1-8; 08 §1; 04 §2.5; D-67).
// Run by approval-server.test.ts as a separate Node process with the same OS user's access. It holds
// everything a same-user process could get without reading process memory or modifying the
// installed package, and more: the session token, a session cookie and the page's CSRF token (worst
// case), the keychain stand-in (the `owner` item included) and `AGENTLINK_OWNER_*` variables. It
// tries every request it can think of to get an approval or a denial applied, and writes the HTTP
// status of each attempt to the job's outFile. The parent checks that none was applied.
//
// Usage: node approval-server-script.mjs <job.json>
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import process from 'node:process';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const attempts = [];

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

// Every secret-shaped value the script can find: the environment, the keychain items as text.
const guesses = new Set();
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('AGENTLINK_OWNER') && value) guesses.add(value);
}
try {
  const items = JSON.parse(readFileSync(job.keychainFile, 'utf8'));
  for (const value of Object.values(items)) guesses.add(String(value));
} catch {
  // no keychain stand-in
}
guesses.add('');
guesses.add('owner');
guesses.add(job.token);
guesses.add(job.csrf);

for (const { approvalId, digest } of job.approvals) {
  for (const decision of ['approve', 'deny']) {
    const path = `/api/approvals/${approvalId}/${decision}`;
    const headers = { ...page, 'X-AgentLink-Digest': digest };
    await attempt(`${decision} no presence`, path, { method: 'POST', headers });
    for (const guess of guesses) {
      await attempt(`${decision} guess`, path, {
        method: 'POST',
        headers,
        body: Buffer.from(guess, 'utf8'),
      });
    }
    // The token in every place a bearer could go.
    await attempt(`${decision} token query`, `${path}?t=${job.token}`, { method: 'POST', headers });
    await attempt(`${decision} token header`, path, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${job.token}` },
    });
    // Rebinding and cross-origin shapes.
    await attempt(`${decision} foreign host`, path, {
      method: 'POST',
      headers: { ...headers, Host: 'evil.example' },
      body: Buffer.from('x'),
    });
    await attempt(`${decision} simple form`, path, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('presence=1'),
    });
    await attempt(`${decision} GET`, `${path}?t=${job.token}`, { headers: page });
  }
}

writeFileSync(job.outFile, JSON.stringify({ attempts }));
