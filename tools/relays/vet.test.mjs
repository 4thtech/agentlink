// M1-18: the pure parts of the opt-in relay vetting script, offline.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { judgeNip11, MIN_MAX_MESSAGE_LENGTH, planText } from './vet.mjs';

describe('judgeNip11', () => {
  it('passes a limit that holds the largest wrap frame', () => {
    expect(judgeNip11({ limitation: { max_message_length: 131_072 } }).sizeVerdict).toBe('ok');
    expect(
      judgeNip11({ limitation: { max_message_length: MIN_MAX_MESSAGE_LENGTH } }).sizeVerdict,
    ).toBe('ok');
  });
  it('fails a limit below it, and reports an absent one as unknown', () => {
    expect(judgeNip11({ limitation: { max_message_length: 65_536 } }).sizeVerdict).toBe(
      'too-small',
    );
    expect(judgeNip11({}).sizeVerdict).toBe('unknown');
    expect(judgeNip11({ limitation: { max_message_length: 'big' } }).maxMessageLength).toBeNull();
  });
  it('reads NIP-42 support and required auth', () => {
    const j = judgeNip11({ supported_nips: [1, 11, 42], limitation: { auth_required: true } });
    expect(j.supportsNip42).toBe(true);
    expect(j.authRequired).toBe(true);
  });
});

describe('vet.mjs without --live', () => {
  it('prints the plan and opens no connection', () => {
    const out = execFileSync(process.execPath, [new URL('./vet.mjs', import.meta.url).pathname], {
      encoding: 'utf8',
    });
    expect(out).toContain('Not run');
    expect(out).toContain(planText(['wss://nos.lol']).split('\n')[0]);
  });
});
