// M1-9h: `agentlink credits [--topup]` (06 §2.1, §8; 07 §6.3; 11 §5) and the proof network line of
// `agentlink doctor` (06 §8 "RPC"). Stub reads, no network: default outputs pass the 11 §5.1
// vocabulary lint (snapshots), never ask for or name a network, a token or a chain, and print no
// URL except our own deposit page under `--topup`.
import * as chain from '@4thtech-io/chain';
import { describe, expect, it } from 'vitest';
import {
  CREDITS_TEXT,
  createCreditsHandler,
  nodeTopUpCheck,
  sumUsd,
  type CreditsDeps,
  type TopUpCheck,
} from '../src/commands/credits.js';
import {
  DOCTOR_PROOF_TEXT,
  createDoctorHandler,
  nodeProofNetworkCheck,
  type ProofNetworkCheck,
} from '../src/commands/doctor.js';
import { createDeps } from '../src/commands/shared.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../src/dispatch.js';
import type { AccountView } from '../src/tools/context.js';
import { TOP_UP_ORIGIN } from '../src/tools/proofs-common.js';
import { copy } from '../src/tools/strings/index.js';
import {
  AGENT_ID,
  PIPED_IN_HARNESS,
  URL_LIKE,
  fakeAgent,
  runner,
  vocabularyHits,
} from './m1-9h-harness.js';

/** The address-checked brand the chain package requires (nodeRpcFetch sets it). Test only. */
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
function checkedFetch<T extends (...args: never[]) => unknown>(fn: T): T {
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
}

const ACCOUNT: AccountView = {
  credits: [
    { chain: 'base-sepolia', token: 'USDC', amount: '1250000', usd: '1.25' },
    { chain: 'gnosis-chiado', token: 'NATIVE', amount: '500000000000000000', usd: '0.5' },
  ],
  prices: [{ action: 'notarize', usd: '0.1', protocolUsd: '0.1', integratorUsd: '0' }],
};

const quote = (usd: string): chain.FeeQuote => ({
  chainId: 84532,
  feeType: 'NOTARIZE',
  token: 'USDC',
  tokenAddress: null,
  appId: `0x${'0'.repeat(64)}`,
  protocolPart: 100000n,
  integratorPart: 0n,
  total: 100000n,
  protocolUsd: usd,
  integratorUsd: '0',
  usd,
});

function setup(
  options: {
    account?: AccountView | undefined | 'throw';
    topUp?: TopUpCheck;
    proofs?: boolean;
  } = {},
) {
  const accountCalls: string[] = [];
  const topUpCalls: string[] = [];
  const fake = fakeAgent(
    options.proofs === false
      ? {}
      : {
          proofs: {
            account: (agentId: string) => {
              accountCalls.push(agentId);
              if (options.account === 'throw') {
                return Promise.reject(new Error('https://rpc.example boom'));
              }
              return Promise.resolve('account' in options ? options.account : ACCOUNT) as Promise<
                AccountView | undefined
              >;
            },
          },
        },
  );
  const deps: CreditsDeps = {
    ...createDeps({
      open: () => Promise.resolve({ status: 'ok', agent: fake.agent }),
      home: '/nonexistent-home',
    }),
    topUpCheck: (agentId) => {
      topUpCalls.push(agentId);
      return (options.topUp ?? (() => Promise.resolve(undefined)))(agentId);
    },
    testnetOnly: () => true,
  };
  return {
    run: runner({ credits: createCreditsHandler(deps) }),
    calls: fake.calls,
    accountCalls,
    topUpCalls,
  };
}

describe('credits (06 §8)', () => {
  it('shows the agent ID, credits in dollars over every network, the price; no network named', async () => {
    const t = setup();
    const r = await t.run(['credits']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toEqual([
      `Agent ID: ${AGENT_ID}`,
      'Credits: $1.75',
      'Adding proof costs $0.10. Messages and files are free.',
      CREDITS_TEXT.testCredits,
      CREDITS_TEXT.topUpHelp,
    ]);
    expect(t.topUpCalls).toEqual([]);
    expect(vocabularyHits(r.text)).toEqual([]);
    expect(URL_LIKE.test(r.text)).toBe(false);
    expect(r.text).not.toMatch(/base|gnosis|usdc|native/i);
    expect(r.text).toMatchSnapshot();
    expect(t.calls).not.toContain('notarize');
    expect(t.calls).toContain('close');
  });

  it('runs from an AI app too (read-only); never asks a question', async () => {
    const t = setup();
    expect((await t.run(['credits'], PIPED_IN_HARNESS)).code).toBe(EXIT_OK);
  });

  it('when nothing answered, or the read throws: fixed text, exit 1, no error text', async () => {
    for (const account of [undefined, 'throw'] as const) {
      const t = setup({ account });
      const r = await t.run(['credits']);
      expect(r.code).toBe(EXIT_FAILED);
      expect(r.text).toContain(CREDITS_TEXT.creditsUnknown);
      expect(r.text).not.toContain('rpc.example');
      expect(vocabularyHits(r.text)).toEqual([]);
    }
  });

  it('without proofs in this build: a fixed line', async () => {
    const t = setup({ proofs: false });
    const r = await t.run(['credits']);
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain(CREDITS_TEXT.noProofs);
  });

  it('arguments: a positional is a usage error', async () => {
    const t = setup();
    expect((await t.run(['credits', 'base'])).code).toBe(EXIT_USAGE);
    expect(t.accountCalls).toEqual([]);
  });
});

describe('credits --topup (07 §6.3, M1-26)', () => {
  it('not enough credits: the amount to add on the cheapest route, then our deposit page only', async () => {
    const t = setup({
      topUp: (agentId) =>
        Promise.resolve({
          status: 'needs_credits',
          topUp: {
            chainId: 84532,
            chain: 'base-sepolia',
            token: 'USDC',
            usd: '1',
            feeUsd: '0.1',
            agentAddress: agentId as chain.Hex,
          },
          unavailable: [],
        }),
    });
    const r = await t.run(['credits', '--topup']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.text).toContain('Add at least $1.00 in credits to add proof ($0.10 each).');
    expect(r.text).toContain(
      `To add credits, open ${TOP_UP_ORIGIN}/ and enter your agent ID: ${AGENT_ID}`,
    );
    expect(t.topUpCalls).toEqual([AGENT_ID]);
    // M1-33b (D-109, 11 §5.6): the paying account is publicly linked, said once with the method.
    expect(r.text).toContain(copy('common.privacy.topUp'));
    expect(r.text.split(copy('common.privacy.topUp')).length).toBe(2);
    // The only URL is our own deposit page; no network, token or chain.
    const urls = r.text.match(/https?:\/\/[^\s]+/g) ?? [];
    expect(urls).toEqual([`${TOP_UP_ORIGIN}/`]);
    expect(vocabularyHits(r.text.replace(`${TOP_UP_ORIGIN}/`, ''))).toEqual([]);
    expect(r.text).not.toMatch(/base|gnosis|usdc|native|sepolia/i);
    expect(r.text).toMatchSnapshot();
  });

  it('enough credits: says so; nothing answered: fixed text and exit 1', async () => {
    const ok = setup({
      topUp: () =>
        Promise.resolve({
          status: 'ok',
          chainId: 84532,
          chain: 'base-sepolia',
          token: 'USDC',
          payFrom: 'credits',
          quote: quote('0.1'),
          reason: 'cheapest',
          unavailable: [],
        }),
    });
    const r1 = await ok.run(['credits', '--topup']);
    expect(r1.code).toBe(EXIT_OK);
    expect(r1.text).toContain('You have enough credits to add proof ($0.10 each).');

    const none = setup({
      topUp: () => Promise.resolve({ status: 'unavailable', unavailable: [84532] }),
    });
    const r2 = await none.run(['credits', '--topup']);
    expect(r2.code).toBe(EXIT_FAILED);
    expect(r2.text).toContain(CREDITS_TEXT.unavailable);

    const thrown = setup({ topUp: () => Promise.reject(new Error('https://rpc.example x')) });
    const r3 = await thrown.run(['credits', '--topup']);
    expect(r3.text).not.toContain('rpc.example');
  });

  it('M1-9h-b: no known fee prints no empty "( each)" clause', async () => {
    const t = setup({
      account: { credits: ACCOUNT.credits, prices: [] },
      topUp: (agentId) =>
        Promise.resolve({
          status: 'needs_credits',
          topUp: {
            chainId: 84532,
            chain: 'base-sepolia',
            token: 'USDC',
            usd: '1',
            feeUsd: 'not-a-number',
            agentAddress: agentId as chain.Hex,
          },
          unavailable: [],
        }),
    });
    const r = await t.run(['credits', '--topup']);
    expect(r.text).toContain('Add at least $1.00 in credits to add proof.');
    expect(r.text).not.toMatch(/\(\s*each\)/);
  });

  it('the default check refuses a malformed agent ID before any request', async () => {
    let fetched = 0;
    const check = nodeTopUpCheck({
      fetchFn: checkedFetch(() => {
        fetched += 1;
        return Promise.reject(new Error('offline'));
      }) as unknown as chain.RpcFetchFn,
    });
    expect(await check('not-an-agent')).toBeUndefined();
    expect(fetched).toBe(0);
  });
});

describe('sumUsd', () => {
  it('adds exactly, rounding down past 6 decimals; refuses a malformed amount', () => {
    expect(sumUsd([])).toBe('0.000000');
    expect(sumUsd(['1.25', '0.5'])).toBe('1.750000');
    expect(sumUsd(['0.0000019', '0.000001'])).toBe('0.000002');
    expect(sumUsd(['1', '-1'])).toBeUndefined();
    expect(sumUsd(['1e3'])).toBeUndefined();
  });
});

describe('doctor: the proof network line (06 §8 "RPC")', () => {
  function doctor(check: ProofNetworkCheck | undefined) {
    const fake = fakeAgent();
    const client = fake.agent.client as unknown as Record<string, unknown>;
    Object.assign(client, {
      identity: {
        get: () => Promise.resolve({ card: {} }),
        signedCard: () => Promise.resolve({ relays: ['wss://one.relay-alpha.net'] }),
        sendState: () => Promise.resolve('ready'),
      },
      catchUp: () => Promise.resolve({ partial: false, inbox: [], requests: 0 }),
    });
    const deps = {
      ...createDeps({
        open: () => Promise.resolve({ status: 'ok' as const, agent: fake.agent }),
        home: '/nonexistent-home',
      }),
      ...(check === undefined ? {} : { proofNetwork: check }),
    };
    return runner({ doctor: createDoctorHandler(deps) });
  }

  it('all answer: OK; some: a warning; none: a problem (exit 1); counts only, no names or URLs', async () => {
    const cases: [ProofNetworkCheck, string, number][] = [
      [() => Promise.resolve({ answered: 2, total: 2 }), DOCTOR_PROOF_TEXT.ok, EXIT_OK],
      [() => Promise.resolve({ answered: 1, total: 2 }), DOCTOR_PROOF_TEXT.partial, EXIT_OK],
      [() => Promise.resolve({ answered: 0, total: 2 }), DOCTOR_PROOF_TEXT.down, EXIT_FAILED],
      [() => Promise.reject(new Error('https://rpc.example')), DOCTOR_PROOF_TEXT.down, EXIT_FAILED],
      [() => Promise.resolve({ answered: 0, total: 0 }), DOCTOR_PROOF_TEXT.none, EXIT_FAILED],
    ];
    for (const [check, line, code] of cases) {
      const r = await doctor(check)(['doctor']);
      expect(r.code, line).toBe(code);
      expect(r.text).toContain(line.split('\n')[0]);
      expect(r.text).not.toContain('rpc.example');
      expect(vocabularyHits(Object.values(DOCTOR_PROOF_TEXT).join('\n'))).toEqual([]);
    }
    const r = await doctor(() => Promise.resolve({ answered: 2, total: 2 }))(['doctor']);
    expect(r.text).toContain(DOCTOR_PROOF_TEXT.notChecked);
    expect(r.text).not.toMatch(/payments network/);
  });

  it('the default check counts the networks that answer a block read, within its budget', async () => {
    const configs = chain.autoSelectableChains();
    const offline = nodeProofNetworkCheck({
      configs,
      fetchFn: checkedFetch(() =>
        Promise.reject(new Error('offline')),
      ) as unknown as chain.RpcFetchFn,
    });
    expect(await offline()).toEqual({ answered: 0, total: configs.length });
    const online = nodeProofNetworkCheck({
      configs,
      fetchFn: checkedFetch((_url: string, init: { body: string }) => {
        const { id } = JSON.parse(init.body) as { id: number };
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x10' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as chain.RpcFetchFn,
    });
    expect(await online()).toEqual({ answered: configs.length, total: configs.length });
  });
});
