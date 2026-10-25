// Test-only helpers for the M1-9h command tests (verify, credits, doctor): a fake opened agent, a
// dispatcher over the given handlers, and the 11 §5.1 vocabulary lint. Not imported by production
// code (the bundle starts at main.ts).
import type { CommandHandler, CommandName } from '../src/dispatch.js';
import { createDispatcher } from '../src/dispatch.js';
import type { TerminalContext } from '../src/runtime/guards.js';
import type { OpenedAgent } from '../src/runtime/open-agent.js';
import type { ProofPlatformTools } from '@4thtech-io/mcp-tools/context.js';

export const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
export const PIPED_IN_HARNESS: TerminalContext = {
  stdinIsTTY: false,
  stdoutIsTTY: false,
  env: { CLAUDECODE: '1' },
};

export const AGENT_ID = `0x${'1'.repeat(40)}`;

/** 11 §5.1 "never say" list, as the tool-copy lint applies it (packages/mcp-tools/src/strings/en.test.ts). */
export const BANNED: readonly [string, RegExp][] = [
  ['wallet', /\bwallets?\b/i],
  ['address', /\baddress(es)?\b/i],
  ['gas', /\bgas\b/i],
  ['seed phrase', /\bseed phrases?\b/i],
  ['private key', /\bprivate keys?\b/i],
  ['transaction', /\btransactions?\b/i],
  ['tx hash', /\btx\b/i],
  ['mint', /\bmint(ed|ing)?\b/i],
  ['notarize', /\bnotari[sz]e[sd]?\b/i],
  ['smart contract', /\bsmart contracts?\b/i],
  ['contract', /\bcontracts?\b/i],
  ['on-chain', /\bon-chain\b/i],
  ['blockchain', /\bblockchains?\b/i],
  ['chain', /\bchains?\b/i],
  ['base/gnosis', /\b(gnosis|sepolia|chiado)\b/i],
  ['stablecoin names', /\b(usdc|usdt|xdai)\b/i],
  ['deposit/faucet', /\b(deposit|faucet)\b/i],
  ['hash', /\bhash(es)?\b/i],
  ['nostr/relay', /\b(nostr|relays?)\b/i],
  ['envelope/harness/policy', /\b(envelope|harness|policy|policies)\b/i],
  ['MCP', /\bmcp\b/i],
  ['owner key/signature', /\b(owner key|signature)\b/i],
  ['keystore', /\b(keystore|\.alks)\b/i],
  ['legally binding', /\blegally binding\b/i],
  ['password', /\bpasswords?\b/i],
  ['RPC', /\brpc\b/i],
];

/**
 * The words of `text` the lint finds. Command literals in backticks are not prose, and the lines
 * of an untrusted region (`| ` prefix) are the other party's content, not our copy.
 */
export function vocabularyHits(text: string): string[] {
  const prose = text
    .split('\n')
    .filter((line) => !line.startsWith('| '))
    .join('\n')
    .replace(/`[^`]*`/g, '');
  return BANNED.filter(([, pattern]) => pattern.test(prose)).map(([name]) => name);
}

/** A URL or anything that looks like one. */
export const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;

export interface FakeAgentParts {
  readonly policy?: unknown;
  readonly contacts?: readonly unknown[];
  readonly proofs?: Partial<ProofPlatformTools>;
  readonly agentId?: string;
}

export function fakeAgent(parts: FakeAgentParts = {}): { agent: OpenedAgent; calls: string[] } {
  const calls: string[] = [];
  const client = {
    contacts: {
      list: () => {
        calls.push('contacts.list');
        return Promise.resolve(parts.contacts ?? []);
      },
    },
    ownerActions: {
      loadPolicy: () => {
        calls.push('loadPolicy');
        return Promise.resolve(
          parts.policy ?? {
            mode: 'signed',
            version: 1,
            policy: {
              proofs: { exportFolder: '~/AgentLink/Proofs' },
              files: { inboxFolder: '~/AgentLink/Inbox' },
            },
          },
        );
      },
    },
    // Nothing that sends, signs or processes may run in these read-only commands.
    syncInbox: () => {
      calls.push('syncInbox');
      return Promise.reject(new Error('read-only'));
    },
    notarize: () => {
      calls.push('notarize');
      return Promise.reject(new Error('read-only'));
    },
  };
  const agent = {
    name: 'default',
    agentId: parts.agentId ?? AGENT_ID,
    paths: {},
    client,
    approvals: {},
    ...(parts.proofs === undefined ? {} : { proofs: parts.proofs }),
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  } as unknown as OpenedAgent;
  return { agent, calls };
}

export function runner(handlers: Partial<Record<CommandName, CommandHandler>>) {
  const dispatch = createDispatcher(handlers);
  return async (argv: string[], terminal: TerminalContext = TTY) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(argv, {
      output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
      terminal,
      version: '0.0.0',
    });
    return { code, out, err, text: [...out, ...err].join('\n') };
  };
}
