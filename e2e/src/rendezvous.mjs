// OPS-CI-7: seals the nightly invite for the other runner (CI glue, not product crypto: the invite
// belongs to throwaway test agents). AES-256-GCM with a key from HKDF-SHA256 over the Anthropic API
// key (no new secret), salted with the run ID and attempt, info "agentlink-nightly-rendezvous", and
// a random 12-byte nonce. Layout: nonce || ciphertext || 16-byte tag. A wrong key, a changed byte or
// a short file fails closed. Nothing here prints the key or the plaintext.
//
//   RENDEZVOUS_KEY=... RENDEZVOUS_SALT=<run>:<attempt> node rendezvous.mjs encrypt|decrypt <in> <out>
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const INFO = 'agentlink-nightly-rendezvous';

const keyFor = (secret, salt) => {
  if (typeof secret !== 'string' || secret === '' || typeof salt !== 'string' || salt === '') {
    throw new Error('rendezvous: key and salt are required');
  }
  return Buffer.from(hkdfSync('sha256', secret, salt, INFO, 32));
};

export function seal(plaintext, secret, salt) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, salt), nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function open(sealed, secret, salt) {
  if (sealed.length < 12 + 16) throw new Error('rendezvous: input too short');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, salt), sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, input, output] = process.argv.slice(2);
  try {
    const secret = process.env['RENDEZVOUS_KEY'];
    const salt = process.env['RENDEZVOUS_SALT'];
    if ((mode !== 'encrypt' && mode !== 'decrypt') || !input || !output) {
      throw new Error('usage: rendezvous.mjs encrypt|decrypt <in> <out>');
    }
    const data = readFileSync(input);
    writeFileSync(output, (mode === 'encrypt' ? seal : open)(data, secret, salt), { mode: 0o600 });
  } catch {
    process.stderr.write('rendezvous: failed (wrong key, damaged file or bad input)\n');
    process.exitCode = 1;
  }
}
