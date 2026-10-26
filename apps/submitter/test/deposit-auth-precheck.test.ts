// M3-4b-t-T2-c: the Worker's own pre-checks in `precheckDepositAuthorization`, at their edges.
// The relay repeats these checks (packages/chain); this pins the copy that runs before the
// Durable Object. Pure function: no Worker, no chain. Nothing here is a real key or signature.
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_AUTH_CLOCK_SKEW_SECONDS,
  DEPOSIT_AUTH_MIN_REMAINING_SECONDS,
  GASLESS_WINDOW_SECONDS,
  type DepositAuthorizationRequest,
  type Hex,
} from '@4thtech-io/chain';
import { precheckDepositAuthorization } from '../src/deposit-auth.js';

const NOW = 1_900_000_000;
const VAULT = `0x${'ab'.repeat(20)}` as Hex;
const MAX_AHEAD = GASLESS_WINDOW_SECONDS + DEPOSIT_AUTH_CLOCK_SKEW_SECONDS;

function request(
  over: { validAfter?: number; validBefore?: number; to?: string } = {},
): DepositAuthorizationRequest {
  return {
    chainId: 84532,
    token: `0x${'c5'.repeat(20)}`,
    auth: {
      from: `0x${'a1'.repeat(20)}`,
      to: over.to ?? VAULT,
      value: '10000000',
      validAfter: String(over.validAfter ?? 0),
      validBefore: String(over.validBefore ?? NOW + 600),
      nonce: `0x${'9'.repeat(64)}`,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    },
  } as DepositAuthorizationRequest;
}
const check = (r: DepositAuthorizationRequest) => precheckDepositAuthorization(r, VAULT, NOW);

describe('precheckDepositAuthorization window edges (M3-4b-t-T2-c)', () => {
  it('accepts validBefore up to the window plus clock skew and refuses one second more', () => {
    expect(check(request({ validBefore: NOW + MAX_AHEAD }))).toBeNull();
    expect(check(request({ validBefore: NOW + MAX_AHEAD + 1 }))).toBe('invalid_window');
  });

  it('keeps the maximum at the 15-minute window plus 120 seconds of skew', () => {
    expect(MAX_AHEAD).toBe(900 + 120);
  });

  it('needs more than the minimum remaining time: exactly 60 seconds is expired', () => {
    expect(DEPOSIT_AUTH_MIN_REMAINING_SECONDS).toBe(60);
    expect(check(request({ validBefore: NOW + 61 }))).toBeNull();
    expect(check(request({ validBefore: NOW + 60 }))).toBe('expired');
    expect(check(request({ validBefore: NOW + 59 }))).toBe('expired');
    expect(check(request({ validBefore: NOW - 1 }))).toBe('expired');
  });

  it('refuses a validAfter that is now or in the future, accepts one in the past', () => {
    expect(check(request({ validAfter: NOW - 1 }))).toBeNull();
    expect(check(request({ validAfter: NOW }))).toBe('invalid_window');
    expect(check(request({ validAfter: NOW + 1 }))).toBe('invalid_window');
    expect(check(request({ validAfter: NOW + 3_600 }))).toBe('invalid_window');
  });

  it('refuses a payee that is not the vault, before looking at the window', () => {
    expect(check(request({ to: `0x${'cd'.repeat(20)}`, validBefore: NOW - 1 }))).toBe('not_vault');
  });
});
