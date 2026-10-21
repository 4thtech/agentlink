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
import { PAY_PAGE, type PayPageConfig } from '@4thtech-io/chain';
import { renderQr } from '../src/terminal/qr.js';
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

/** A live pay page for the tests of the link; the shipped PAY_PAGE is not live yet. */
const LIVE: PayPageConfig = { host: 'pay.agentlink.4thtech.io', live: true };
const TOP_UP_PAY_HOST = LIVE.host;

const needs = (agentId: string): chain.ChainSelection => ({
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
});

function setup(
  options: {
    account?: AccountView | undefined | 'throw';
    topUp?: TopUpCheck;
    proofs?: boolean;
    payPage?: PayPageConfig;
    browser?: boolean | 'throw';
  } = {},
) {
  const opened: string[] = [];
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
    payPage: options.payPage ?? LIVE,
    openBrowser: (url: string) => {
      opened.push(url);
      if (options.browser === 'throw') return Promise.reject(new Error('no browser'));
      return Promise.resolve(options.browser !== false);
    },
  };
  return {
    opened,
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
    // M1-26-e (D-113): one link, everything in the fragment; the suggested amount is the shortfall
    // rounded up to the first preset.
    const link = `https://${TOP_UP_PAY_HOST}/#v=1&a=${AGENT_ID}&usd=5`;
    expect(r.out).toContain(link);
    expect(r.text).toContain(CREDITS_TEXT.topUpHow);
    expect(t.topUpCalls).toEqual([AGENT_ID]);
    // M1-33b (D-109, 11 §5.6): the paying account is publicly linked, said once with the method.
    expect(r.text).toContain(copy('common.privacy.topUp'));
    expect(r.text.split(copy('common.privacy.topUp')).length).toBe(2);
    // The only URL is the top-up link; no network, token or chain.
    const urls = r.text.match(/https?:\/\/[^\s]+/g) ?? [];
    expect(urls).toEqual([link]);
    expect(vocabularyHits(r.text.replace(link, ''))).toEqual([]);
    expect(r.text).not.toMatch(/base|gnosis|usdc|native|sepolia/i);
    expect(r.text).toMatchSnapshot();
  });

  it('prints the agent ID with a terminal QR code, and opens the browser on a terminal', async () => {
    const t = setup({ topUp: (agentId) => Promise.resolve(needs(agentId)) });
    const r = await t.run(['credits', '--topup']);
    const qr = renderQr(AGENT_ID);
    expect(qr.length).toBeGreaterThan(10);
    // The QR block appears whole and in order, once.
    const text = r.out.join('\n');
    expect(text).toContain(qr.join('\n'));
    expect(text.split(qr[3] ?? 'x').length).toBe(2);
    expect(r.text).toContain(CREDITS_TEXT.qrIntro);
    expect(t.opened).toEqual([`https://${TOP_UP_PAY_HOST}/#v=1&a=${AGENT_ID}&usd=5`]);
    expect(r.text).toContain(CREDITS_TEXT.openedBrowser);
    expect(vocabularyHits(r.text.replace(/https:\/\/\S+/, ''))).toEqual([]);
  });

  it('no browser when stdout is not a terminal, or when it cannot open: the link is still printed', async () => {
    const piped = setup({ topUp: (agentId) => Promise.resolve(needs(agentId)) });
    const r1 = await piped.run(['credits', '--topup'], PIPED_IN_HARNESS);
    expect(piped.opened).toEqual([]);
    expect(r1.text).toContain(`https://${TOP_UP_PAY_HOST}/#v=1&a=${AGENT_ID}&usd=5`);
    expect(r1.text).not.toContain(CREDITS_TEXT.openedBrowser);

    const refused = setup({ topUp: (agentId) => Promise.resolve(needs(agentId)), browser: false });
    const r2 = await refused.run(['credits', '--topup']);
    expect(r2.text).not.toContain(CREDITS_TEXT.openedBrowser);
    expect(r2.text).toContain(`#v=1&a=${AGENT_ID}`);

    const thrown = setup({ topUp: (agentId) => Promise.resolve(needs(agentId)), browser: 'throw' });
    const r3 = await thrown.run(['credits', '--topup']);
    expect(r3.code).toBe(EXIT_OK);
    expect(r3.text).not.toContain('no browser');
  });

  it('the link host comes only from the config dependency; a bad host prints no link and opens nothing', async () => {
    const custom = setup({
      topUp: (agentId) => Promise.resolve(needs(agentId)),
      payPage: { host: 'pay.example.test', live: true },
    });
    const r1 = await custom.run(['credits', '--topup']);
    expect(r1.text).toContain(`https://pay.example.test/#v=1&a=${AGENT_ID}&usd=5`);
    expect(r1.text).not.toContain(TOP_UP_PAY_HOST);

    const bad = setup({
      topUp: (agentId) => Promise.resolve(needs(agentId)),
      payPage: { host: 'https://evil.test/x', live: true },
    });
    const r2 = await bad.run(['credits', '--topup']);
    expect(r2.text).not.toContain('evil.test');
    expect(r2.text).not.toMatch(/https?:\/\//);
    expect(bad.opened).toEqual([]);
  });

  it('opens the browser only on an interactive terminal outside an AI app (M-2)', async () => {
    const link = `#v=1&a=${AGENT_ID}`;
    // A harness that gives commands a pty: stdout is a terminal but stdin is not.
    const ptyOnly = setup({ topUp: (id) => Promise.resolve(needs(id)) });
    const r1 = await ptyOnly.run(['credits', '--topup'], {
      stdinIsTTY: false,
      stdoutIsTTY: true,
      env: {},
    });
    expect(ptyOnly.opened).toEqual([]);
    expect(r1.text).toContain(link);
    // Both are terminals but an AI app marked the environment.
    const marked = setup({ topUp: (id) => Promise.resolve(needs(id)) });
    await marked.run(['credits', '--topup'], { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } });
    expect(marked.opened).toEqual([]);
  });

  it('never opens the browser when the balance is enough or the check failed (M-2)', async () => {
    const enough = setup({
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
    await enough.run(['credits', '--topup']);
    expect(enough.opened).toEqual([]);
    const failed = setup({
      topUp: () => Promise.resolve({ status: 'unavailable', unavailable: [84532] }),
    });
    await failed.run(['credits', '--topup']);
    expect(failed.opened).toEqual([]);
  });

  it('the shipped pay page is not live: no link, no QR, no browser, an honest line (M-3)', async () => {
    for (const payPage of [PAY_PAGE, { host: LIVE.host, live: false }]) {
      const t = setup({ topUp: (id) => Promise.resolve(needs(id)), payPage });
      const r = await t.run(['credits', '--topup']);
      expect(r.code).toBe(EXIT_OK);
      expect(r.text).toContain('Add at least $1.00 in credits to add proof ($0.10 each).');
      expect(r.text).toContain(CREDITS_TEXT.topUpNotLive);
      expect(r.text).not.toMatch(/https?:\/\/|#v=1|\u2588/);
      expect(r.text).not.toContain(copy('common.privacy.topUp'));
      expect(t.opened).toEqual([]);
    }
  });

  it('the shipped config in the real handler deps is not live', async () => {
    const { nodeCreditsDeps } = await import('../src/commands/credits.js');
    expect(nodeCreditsDeps().payPage).toBe(PAY_PAGE);
    expect(nodeCreditsDeps().payPage.live).toBe(false);
  });

  it('with enough credits there is no suggested amount; no key, recovery code or card is ever asked for', async () => {
    const t = setup({
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
    const r = await t.run(['credits', '--topup']);
    expect(r.text).toContain(`#v=1&a=${AGENT_ID}`);
    expect(r.text).not.toContain('usd=');
    expect(r.text).not.toMatch(/\bkeys?\b|recovery|seed|card number|password|passphrase/i);
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
