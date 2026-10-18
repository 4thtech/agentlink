// M1-9z (04 §2.8 "Changing the owner code"; 07 §9.3): `agentlink owner change-code` †. The command
// runs under the owner-terminal guard, finds the owner this computer's agents name (so node can check
// the owner item unlocks to exactly that owner) and hands the owner step to @4thtech-io/node, whose
// TTY prompt reads the current code and shows the new one (node's owner-change-code.test.ts runs the
// real flow against a keychain). These tests stand in for node's `changeOwnerCode`.
import { encodeHex0x, type OwnerPublicKeys } from '@4thtech-io/crypto';
import { NodeKeyStoreError, type ChangeOwnerCodeOptions } from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import {
  ownerCommandHandlers,
  type OwnerAgent,
  type OwnerCommandDeps,
} from '../src/commands/owner/index.js';
import { OWNER_TEXT } from '../src/commands/owner/strings.js';
import { createDispatcher, helpText } from '../src/dispatch.js';
import { createOutput } from '../src/output.js';
import type { TerminalContext } from '../src/runtime/guards.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

const OWNER: OwnerPublicKeys = {
  ownerEvm: new Uint8Array(20).fill(1),
  ownerNostr: new Uint8Array(32).fill(2),
  ownerEnc: new Uint8Array(32).fill(3),
};

/** An agent whose stored card names `owner` (or that has no card). Only identity.get is used. */
function agentNaming(name: string, owner: OwnerPublicKeys | undefined): OwnerAgent {
  const view =
    owner === undefined
      ? undefined
      : {
          card: {
            ownerEvm: encodeHex0x(owner.ownerEvm),
            ownerNostr: encodeHex0x(owner.ownerNostr),
            ownerEnc: encodeHex0x(owner.ownerEnc),
          },
        };
  return {
    name,
    client: { identity: { get: () => Promise.resolve(view) } },
    close: () => Promise.resolve(),
  } as unknown as OwnerAgent;
}

function machine(
  agents: Record<string, OwnerPublicKeys | undefined>,
  change?: (options: ChangeOwnerCodeOptions) => Promise<{ fingerprint: string }>,
) {
  const calls: ChangeOwnerCodeOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve(Object.keys(agents)),
    open: (name) => {
      const key = name ?? 'default';
      return Promise.resolve(
        key in agents
          ? { status: 'ok' as const, agent: agentNaming(key, agents[key]) }
          : { status: 'needs_setup' as const, message: 'not set up' },
      );
    },
    backendOf: (name) => Promise.resolve((name ?? 'default') in agents ? 'keychain' : undefined),
    initOwner: () => Promise.reject(new Error('not used')),
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: async (options) => {
      calls.push(options);
      const result = change === undefined ? { fingerprint: '7F3A·19C2' } : await change(options);
      return { fingerprint: result.fingerprint, owner: options.owner ?? OWNER };
    },
    decide: () => Promise.reject(new Error('not used')),
    signOwnerAction: () => Promise.reject(new Error('not used')),
    ask: () => Promise.resolve(''),
    now: () => 0,
    cardRelays: () => [],
  };
  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  return {
    calls,
    out,
    err,
    run: (argv: string[], terminal: TerminalContext = TTY) =>
      dispatch(argv, {
        output: createOutput({ log: (l) => out.push(l), error: (l) => err.push(l) }),
        terminal,
        version: '0.0.0',
      }),
  };
}

describe('agentlink owner change-code (M1-9z)', () => {
  it('is listed in --help as an owner command', () => {
    expect(helpText()).toContain('agentlink owner change-code');
  });

  it('hands node the owner the agents name and the environment for the AI-app check', async () => {
    const m = machine({ default: OWNER, bob: OWNER });
    expect(await m.run(['owner', 'change-code'])).toBe(0);
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0];
    if (call === undefined) throw new Error('no call');
    expect(call.backend).toBe('keychain');
    expect(call.owner?.ownerNostr).toEqual(OWNER.ownerNostr);
    expect(call.env).toEqual({});
    expect(m.out.join('\n')).toContain(OWNER_TEXT.changeCodeDone);
  });

  it('with no agent naming an owner, hands node no owner keys', async () => {
    const m = machine({ default: undefined });
    expect(await m.run(['owner', 'change-code'])).toBe(0);
    expect(m.calls[0]?.owner).toBeUndefined();
  });

  it('refuses when the agents name different owners', async () => {
    const other = { ...OWNER, ownerNostr: new Uint8Array(32).fill(9) };
    const m = machine({ default: OWNER, bob: other });
    expect(await m.run(['owner', 'change-code'])).toBe(1);
    expect(m.calls).toHaveLength(0);
  });

  it('runs only at an interactive terminal with no AI-app marker (UX guard)', async () => {
    const m = machine({ default: OWNER });
    const pipe: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
    const marked: TerminalContext = {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { CLAUDECODE: '1' },
    };
    expect(await m.run(['owner', 'change-code'], pipe)).toBe(1);
    expect(await m.run(['owner', 'change-code'], marked)).toBe(1);
    expect(m.calls).toHaveLength(0);
  });

  it('shows node’s refusal and exits 1', async () => {
    const refusal = "The owner code wasn't accepted three times. Nothing was changed.";
    const m = machine({ default: OWNER }, () =>
      Promise.reject(new NodeKeyStoreError('owner_secret_refused', refusal)),
    );
    expect(await m.run(['owner', 'change-code'])).toBe(1);
    expect(m.err.join('\n')).toContain(refusal);
  });

  it('takes no extra arguments', async () => {
    const m = machine({ default: OWNER });
    expect(await m.run(['owner', 'change-code', 'ABCD'])).toBe(2);
    expect(m.calls).toHaveLength(0);
  });
});
