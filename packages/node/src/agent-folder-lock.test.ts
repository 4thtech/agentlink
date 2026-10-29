// U3-c: the shared agent folder lock (06 §6 "Open agents and removal"; 04 §2.5 removal step 1).
// Every process that has an agent open holds it shared; removal needs it exclusive and is refused at
// once with `in_use` while anyone holds it shared.
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_OPEN_LOCK_FILE,
  AgentFolderLockError,
  holdAgentFolderShared,
  withAgentFolderExclusive,
} from './agent-folder-lock.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-u3c-lock-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const codeOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => 'ok',
    (error: unknown) => (error instanceof AgentFolderLockError ? error.code : error),
  );

describe('agent folder lock (U3-c, 06 §6)', () => {
  it('shared holders never block each other; the lock file is 0600 and stays empty', () => {
    const a = holdAgentFolderShared(dir);
    const b = holdAgentFolderShared(dir);
    const info = statSync(join(dir, AGENT_OPEN_LOCK_FILE));
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect(info.size).toBe(0);
    a.release();
    b.release();
    a.release();
  });

  it('an exclusive take is refused at once with in_use while any shared holder is alive', async () => {
    const held = holdAgentFolderShared(dir);
    let ran = false;
    expect(
      await codeOf(() =>
        withAgentFolderExclusive(dir, () => {
          ran = true;
        }),
      ),
    ).toBe('in_use');
    expect(ran).toBe(false);
    held.release();
    expect(await codeOf(() => withAgentFolderExclusive(dir, () => undefined))).toBe('ok');
  });

  it('opening is refused with in_use while a removal holds the lock exclusive', async () => {
    await withAgentFolderExclusive(dir, () => {
      let code: unknown;
      try {
        holdAgentFolderShared(dir).release();
      } catch (error) {
        code = error instanceof AgentFolderLockError ? error.code : error;
      }
      expect(code).toBe('in_use');
    });
    holdAgentFolderShared(dir).release();
  });

  // HOTFIX-045-REMOVE (B1): removal deletes the folder while it holds the lock exclusive, and the
  // folder delete refuses any file it does not know. The exclusive hold must leave nothing but
  // `open.lock` in the folder (SQLite's default rollback journal wrote `open.lock-journal`).
  it('the exclusive hold writes no other file into the agent folder (HOTFIX-045-REMOVE)', async () => {
    const seen = await withAgentFolderExclusive(dir, () => readdirSync(dir).sort());
    expect(seen).toEqual([AGENT_OPEN_LOCK_FILE]);
    expect(readdirSync(dir)).toEqual([AGENT_OPEN_LOCK_FILE]);
  });

  it('a second exclusive take while one is held is in_use, never lock_failed (HOTFIX-045-REMOVE)', async () => {
    await withAgentFolderExclusive(dir, async () => {
      expect(await codeOf(() => withAgentFolderExclusive(dir, () => undefined))).toBe('in_use');
      let code: unknown;
      try {
        holdAgentFolderShared(dir).release();
      } catch (error) {
        code = error instanceof AgentFolderLockError ? error.code : error;
      }
      expect(code).toBe('in_use');
    });
    expect(await codeOf(() => withAgentFolderExclusive(dir, () => undefined))).toBe('ok');
  });

  it('a link or a folder at the lock name fails closed with lock_failed', () => {
    const target = join(dir, 'elsewhere');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, AGENT_OPEN_LOCK_FILE));
    expect(() => holdAgentFolderShared(dir)).toThrow(AgentFolderLockError);
    try {
      holdAgentFolderShared(dir);
    } catch (error) {
      expect((error as AgentFolderLockError).code).toBe('lock_failed');
      // Fixed text only: never a path.
      expect((error as Error).message).not.toContain(dir);
    }
  });
});
