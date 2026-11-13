// HOTFIX-NOID (owner question): the Mac app's core and the browser/CLI install share one home: the
// same `~/.agentlink` folder (the OS user's home, HOME passed through by the shell's env allowlist,
// apps/desktop core-process.ts) and the same keychain service (`agentlink`). An ID made by one shows
// in the other. Here an ID folder made through the CLI's own directory under a temp HOME is listed
// by the desktop host's `ui` deps, which start from the same HOME.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEYCHAIN_SERVICE } from '@4thtech-io/node';
import { agentDirectory } from '../runtime/agent-dir.js';
import { nodeDesktopHostDeps } from './host-main.js';
import type { DesktopPipe } from './pipe.js';

const pipe: DesktopPipe = {
  send: () => true,
  onMessage: () => undefined,
  onReject: () => undefined,
  onClose: () => undefined,
  close: () => Promise.resolve(),
};

let home: string;
let before: string | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-same-home-'));
  before = process.env['HOME'];
  process.env['HOME'] = home;
});
afterEach(async () => {
  if (before === undefined) delete process.env['HOME'];
  else process.env['HOME'] = before;
  await rm(home, { recursive: true, force: true });
});

describe('the desktop core and the CLI/browser install share one home', () => {
  it('an ID made by the CLI under HOME is listed by the desktop host', async () => {
    const cli = agentDirectory(home, {
      createAgent: () => Promise.resolve(`0x${'11'.repeat(20)}`),
      discardKeys: () => Promise.resolve(),
    });
    const name = await cli.create('Ana');
    const deps = nodeDesktopHostDeps(pipe).uiDeps(() => Promise.reject(new Error('not started')));
    expect(await deps.agents()).toEqual([name]);
  });

  it('the keychain service is the one the CLI uses', () => {
    expect(KEYCHAIN_SERVICE).toBe('agentlink');
  });
});
