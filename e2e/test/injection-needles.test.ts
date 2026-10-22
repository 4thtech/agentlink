// CHORE-MAIN-E2E-RED: the prompt-injection needles (prompt-injection/corpus.ts) must never match
// text that is legitimately ours. A `pending_approval` result's `nextStep` names the command
// `agentlink approve <approvalId>` (06 §2.5 step 2), and an approval ID is `apr_` + 16 random bytes
// as base64url (04 §3.4.1): any needle that is a prefix of such a command makes the I-5 checks fail
// on a random ID (here, about 1 run in 64 per approval), which is a false alarm, not a leak.
import { describe, expect, it } from 'vitest';
import { allNeedles } from '../prompt-injection/corpus.js';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('prompt-injection needles', () => {
  it('no needle matches the approve command of any approval ID', () => {
    for (const first of BASE64URL) {
      for (const second of BASE64URL) {
        // 22 characters; the final `A` keeps the encoding canonical for 16 bytes.
        const id = `apr_${first}${second}${'A'.repeat(20)}`;
        const ours = `run \`agentlink approve ${id}\`. approvalId ${id}`;
        for (const needle of allNeedles()) {
          expect(ours.includes(needle), `needle "${needle}" matches ${id}`).toBe(false);
        }
      }
    }
  });
});
