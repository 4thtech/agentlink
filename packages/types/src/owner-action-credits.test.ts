// credits.deposit and credits.withdraw (M1-11c-a4c; D-122, D-123; 04 §2.5, §2.5.1 op table; 05 §2.5;
// 12 §4.1). Written from the proposed 04 §2.5.1 rows (owner confirms at merge):
// - `credits.deposit` params are exactly `{chainId, token, amount}`: the agent turns `amount` base
//   units of `token` that its own account holds on `chainId` into its own credits there;
// - `credits.withdraw` params are exactly `{chainId, token, amount, to}`: `amount` of the agent's
//   credits in `token` on `chainId` go to `to`. Which recipients are allowed is the core's rule (the
//   agent's own account only, until the recipient grant lands);
// - `chainId` is a positive safe integer; `token` is a fee-token symbol (NATIVE, USDC, USDT);
//   `amount` is base units as a decimal string with no sign, no leading zero and no fraction, from 1
//   to 2^256 - 1; `to` is `0x` + 40 lowercase hex;
// - any other key, spelling or the other op's params is rejected, never normalised;
// - both expire with L(op) = 600 s, and no envelope carries them (signedApprovalOpSchema refuses).
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  creditsDepositActionSchema,
  creditsWithdrawActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const NONCE = b64u(16, 'C');
const MAX_UINT256 = (2n ** 256n - 1n).toString();

const depositAction = (
  params: Record<string, unknown> = {
    chainId: 10200,
    token: 'NATIVE',
    amount: '4990000000000000000',
  },
) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'credits.deposit',
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

const withdrawAction = (
  params: Record<string, unknown> = {
    chainId: 10200,
    token: 'NATIVE',
    amount: '1000000000000000000',
    to: AGENT_EVM,
  },
) => ({ ...depositAction(), op: 'credits.withdraw', params });

describe('credits.deposit and credits.withdraw schemas (M1-11c-a4c)', () => {
  it('are owner-action ops with L(op) = 600 s', () => {
    expect(OWNER_ACTION_OPS).toContain('credits.deposit');
    expect(OWNER_ACTION_OPS).toContain('credits.withdraw');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['credits.deposit']).toBe(600);
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['credits.withdraw']).toBe(600);
  });

  it('accept the exact forms through every schema they pass', () => {
    for (const [schema, body] of [
      [creditsDepositActionSchema, depositAction()],
      [creditsWithdrawActionSchema, withdrawAction()],
    ] as const) {
      expectRoundTrip(schema, body);
      expectRoundTrip(ownerActionSchema, body);
      expectRoundTrip(signedOwnerActionSchema, signed(body));
    }
    expectRoundTrip(
      ownerActionSchema,
      depositAction({ chainId: 84532, token: 'USDC', amount: MAX_UINT256 }),
    );
    expectRoundTrip(ownerActionSchema, depositAction({ chainId: 1, token: 'USDT', amount: '1' }));
  });

  it('reject other keys, spellings, amounts and the other op params', () => {
    const upper = '0x' + '3D'.repeat(20);
    const dep = (over: Record<string, unknown>) =>
      depositAction({ chainId: 10200, token: 'NATIVE', amount: '5', ...over });
    for (const body of [
      dep({ amount: '0' }),
      dep({ amount: '05' }),
      dep({ amount: '-5' }),
      dep({ amount: '+5' }),
      dep({ amount: '5.0' }),
      dep({ amount: '1e18' }),
      dep({ amount: ' 5' }),
      dep({ amount: 5 }),
      dep({ amount: (2n ** 256n).toString() }),
      dep({ amount: '9'.repeat(79) }),
      dep({ chainId: 0 }),
      dep({ chainId: -1 }),
      dep({ chainId: 10200.5 }),
      dep({ chainId: '10200' }),
      dep({ chainId: 2 ** 53 }),
      dep({ token: 'native' }),
      dep({ token: 'DAI' }),
      dep({ token: '' }),
      dep({ to: AGENT_EVM }),
      dep({ extra: 1 }),
      depositAction({ chainId: 10200, token: 'NATIVE' }),
      depositAction({ token: 'NATIVE', amount: '5' }),
      withdrawAction({ chainId: 10200, token: 'NATIVE', amount: '5' }),
      withdrawAction({ chainId: 10200, token: 'NATIVE', amount: '5', to: upper }),
      withdrawAction({ chainId: 10200, token: 'NATIVE', amount: '5', to: AGENT_EVM.slice(2) }),
      withdrawAction({ chainId: 10200, token: 'NATIVE', amount: '0', to: AGENT_EVM }),
      withdrawAction({ chainId: 10200, token: 'NATIVE', amount: '5', to: AGENT_EVM, x: 1 }),
      { ...depositAction(), expiresAt: 0 },
      { ...withdrawAction(), expiresAt: 0 },
      { ...depositAction(), expiresAt: depositAction().issuedAt },
    ]) {
      expectReject(ownerActionSchema, body);
    }
  });

  it('never ride an approval envelope', () => {
    expectReject(signedApprovalOpSchema, signed(depositAction()));
    expectReject(signedApprovalOpSchema, signed(withdrawAction()));
  });
});
