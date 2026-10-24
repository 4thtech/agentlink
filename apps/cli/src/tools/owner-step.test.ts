// M1-36a-b: the no-owner step on a fresh machine. The handlers ask their context whether an owner is
// known to be absent and which command prefix works here; `owner init` shows only on a positive
// "no owner", and the prefix is only ever one of the two fixed forms (nothing from inbound data).
import { createLogger } from '@4thtech-io/log';
import { MAX_TOOL_TEXT_CHARS } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import type { ToolClient, ToolContext } from './context.js';
import { needsIdentity } from './proofs-common.js';
import { statusHandler } from './status.js';
import { noOwnerCard, noOwnerFor } from './text.js';

const NPX = 'npx -y @4thtech-io/agentlink';
const silent = createLogger({ level: 'error', sink: () => undefined });

function context(over: Partial<ToolContext> = {}): ToolContext {
  const client = { self: () => Promise.resolve(undefined) } as unknown as ToolClient;
  return {
    client,
    clock: () => 1_760_600_000,
    logger: silent,
    agentName: 'default',
    approvalNextStep: (id) => `Run approve ${id}.`,
    urlOrigins: [],
    ...over,
  };
}

const summaryOf = (out: unknown): string =>
  String((out as { structured?: { summary?: unknown } }).structured?.summary ?? '') +
  JSON.stringify(out);

describe('the owner step on a fresh machine (M1-36a-b)', () => {
  it('status names owner init when the machine has no owner', async () => {
    const out = await statusHandler(
      {},
      context({ ownerExists: () => Promise.resolve(false), cliPrefix: 'agentlink' }),
    );
    expect(summaryOf(out)).toContain('`agentlink owner init`');
    expect(summaryOf(out)).not.toContain('add-agent');
  });

  it('status keeps the add-agent step when the state is unknown', async () => {
    const out = await statusHandler({}, context({ ownerExists: () => Promise.resolve(undefined) }));
    expect(summaryOf(out)).toContain(`\`${NPX} owner add-agent --agent default\``);
    expect(summaryOf(out)).not.toContain('owner init');
  });

  it('a failing check keeps the add-agent step', async () => {
    const out = await statusHandler(
      {},
      context({ ownerExists: () => Promise.reject(new Error('disk')) }),
    );
    expect(summaryOf(out)).toContain('owner add-agent');
  });

  it('the proof tools use the same step (needsIdentity)', async () => {
    const out = await needsIdentity(context({ ownerExists: () => Promise.resolve(false) }));
    expect(JSON.stringify(out)).toContain(`\`${NPX} owner init\``);
  });

  it('only the two fixed prefixes are used; anything else falls back to the npx form', async () => {
    const odd = await noOwnerFor(
      context({ cliPrefix: 'rm -rf / #', ownerExists: () => Promise.resolve(false) }),
    );
    expect(odd.summary).toContain(`\`${NPX} owner init\``);
    expect(odd.summary).not.toContain('rm -rf');
    const global = await noOwnerFor(context({ cliPrefix: 'agentlink' }));
    expect(global.summary).toContain('`agentlink owner add-agent --agent default`');
  });
});

describe('the invalid-name hint stays within the result limit (M1-36a-b)', () => {
  it.each([true, false, undefined])('ownerExists %s, longest prefix', (ownerExists) => {
    const text = noOwnerCard('Not A Valid Name; rm -rf ~', {
      prefix: NPX,
      ...(ownerExists === undefined ? {} : { ownerExists }),
    });
    expect(text.summary).toContain('<name>');
    expect(text.summary).not.toContain('Valid');
    expect(text.summary.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
    expect(text.nextStep.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
    expect(`${text.summary} ${text.nextStep}`.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
  });
});
