// M1-18: the pure parts of the opt-in relay vetting script, offline.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkRelayTarget, judgeNip11, MIN_MAX_MESSAGE_LENGTH, planText } from './vet.mjs';

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

// The 04 §4 check with injected stand-ins for isAllowedRelayUrl (the real one is in
// @agentlink/types) and isGloballyRoutable, so this test needs no build and no network.
const deps = (answers) => ({
  isAllowedRelayUrl: (u) => /^wss:\/\/[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+(:\d+)?$/.test(u),
  isGloballyRoutable: (a) => !/^(10\.|127\.|192\.168\.|169\.254\.|::1$|fe80|fc|fd)/.test(a),
  resolve: async () => {
    if (answers instanceof Error) throw answers;
    return answers;
  },
});

describe('checkRelayTarget (04 §4 before any connection)', () => {
  it('accepts a wss name whose every answer is global, and pins the first answer', async () => {
    const r = await checkRelayTarget('wss://nos.lol', deps(['93.184.216.34', '2606:2800::1']));
    expect(r).toMatchObject({ ok: true, address: '93.184.216.34', family: 4, host: 'nos.lol' });
  });
  it.each([
    ['ws://nos.lol', 'not wss'],
    ['https://nos.lol', 'not wss'],
    ['wss://127.0.0.1', 'IP literal'],
    ['wss://10.0.0.1:8080', 'private IP literal'],
    ['wss://[::1]', 'IPv6 literal'],
    ['wss://localhost', 'local name'],
    ['wss://nos.lol/path?x=1', 'path or query'],
    ['', 'empty'],
  ])('refuses %s (%s)', async (url) => {
    expect((await checkRelayTarget(url, deps(['93.184.216.34']))).ok).toBe(false);
  });
  it('refuses a name with ANY private, loopback, link-local or zone-id answer', async () => {
    for (const bad of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      'fe80::1%eth0',
      'not-an-ip',
    ]) {
      const r = await checkRelayTarget('wss://relay.example.net', deps(['93.184.216.34', bad]));
      expect(r.ok).toBe(false);
    }
  });
  it('refuses a host that does not resolve or returns nothing', async () => {
    expect((await checkRelayTarget('wss://nos.lol', deps(new Error('x')))).ok).toBe(false);
    expect((await checkRelayTarget('wss://nos.lol', deps([]))).ok).toBe(false);
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
