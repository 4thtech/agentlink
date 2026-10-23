// M1-36a-b: is this machine known to have no owner? Only a positive "nothing here" counts; anything
// else (another agent, an owner file, an unreadable folder) keeps the add-agent step.
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerKnownAbsent } from './owner-on-machine.js';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-owner-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function agentDir(name: string): Promise<void> {
  await mkdir(join(home, '.agentlink', 'agents', name), { recursive: true, mode: 0o700 });
  await chmod(join(home, '.agentlink'), 0o700);
  await chmod(join(home, '.agentlink', 'agents'), 0o700);
}

describe('ownerKnownAbsent (M1-36a-b)', () => {
  it('a fresh machine with only this agent: no owner', async () => {
    await agentDir('default');
    await expect(ownerKnownAbsent(home, 'default')).resolves.toBe(true);
  });

  it('nothing set up at all: no owner', async () => {
    await expect(ownerKnownAbsent(home, 'default')).resolves.toBe(true);
  });

  it('another agent on this machine: not known', async () => {
    await agentDir('default');
    await agentDir('work');
    await expect(ownerKnownAbsent(home, 'default')).resolves.toBe(false);
  });

  it('a file-KeyStore owner file: not known', async () => {
    await agentDir('default');
    await mkdir(join(home, '.agentlink', 'keystore'), { mode: 0o700 });
    await writeFile(join(home, '.agentlink', 'keystore', 'owner.alko'), 'x', { mode: 0o600 });
    await expect(ownerKnownAbsent(home, 'default')).resolves.toBe(false);
  });

  it('an unreadable agents folder: not known (fails closed to add-agent)', async () => {
    await agentDir('default');
    await chmod(join(home, '.agentlink'), 0o755);
    await expect(ownerKnownAbsent(home, 'default')).resolves.toBe(false);
  });
});
