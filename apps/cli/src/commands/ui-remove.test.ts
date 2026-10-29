// U3-e: the CLI side of removing an agent (04 §2.5 "Removing an agent" steps 1 and 2, §2.5.1 "The
// owner's revoked list"; 06 §6 "Open agents and removal"; 07 §9.1; D-138).
//
// - The revoked list: `~/.agentlink/revoked/<agentId>.json`, folder 0700, file 0600, the exact text,
//   never replaced once written; anything odd at that name reads as damaged (fail closed); an agent
//   with an entry lists as removing whether or not config.json carries the mark.
// - The removal port: `exclusive` is refused with `in_use` while any process holds the agent folder's
//   shared lock (every `agentlink mcp` server and the app host); `open` works only inside the port's
//   own exclusive hold and takes no shared lock of its own there.
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { AgentFolderLockError, holdAgentFolderShared } from '@4thtech-io/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDirectory,
  readRevokedEntry,
  recordRevokedEntry,
  removeAgentFolderLock,
  writeAgentConfig,
} from '../runtime/agent-dir.js';
import { uiRemovalPort } from './ui-remove.js';

const POSIX = process.platform !== 'win32';
const newId = (): string => `0x${encodeHex(randomBytes(20))}`;
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-u3e-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const revokedPath = (agentId: string): string =>
  join(home, '.agentlink', 'revoked', `${agentId}.json`);

describe('the owner revoked list (U3-e, 04 §2.5 step 2)', () => {
  it('records the exact text with folder 0700 and file 0600, and never replaces an entry', async () => {
    const agentId = newId();
    expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'none' });
    await recordRevokedEntry(home, agentId, '{"body":{"a":1},"sig":"00"}');
    expect(await readRevokedEntry(home, agentId)).toEqual({
      kind: 'entry',
      text: '{"body":{"a":1},"sig":"00"}',
    });
    await recordRevokedEntry(home, agentId, '{"other":true}');
    expect(await readFile(revokedPath(agentId), 'utf8')).toBe('{"body":{"a":1},"sig":"00"}');
    if (POSIX) {
      expect((await stat(join(home, '.agentlink', 'revoked'))).mode & 0o777).toBe(0o700);
      expect((await stat(revokedPath(agentId))).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(POSIX)(
    'reads a link, a folder, a loose file or a huge file at that name as damaged',
    async () => {
      const agentId = newId();
      await recordRevokedEntry(home, newId(), 'x');
      const dir = join(home, '.agentlink', 'revoked');
      const target = join(home, 'elsewhere.json');
      await writeFile(target, '{}', { mode: 0o600 });
      await symlink(target, revokedPath(agentId));
      expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'damaged' });
      await rm(revokedPath(agentId));
      await mkdir(revokedPath(agentId));
      expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'damaged' });
      await rm(revokedPath(agentId), { recursive: true });
      await writeFile(revokedPath(agentId), 'x', { mode: 0o644 });
      expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'damaged' });
      await chmod(revokedPath(agentId), 0o600);
      await writeFile(revokedPath(agentId), 'x'.repeat(5_000));
      expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'damaged' });
      await chmod(dir, 0o755);
      expect(await readRevokedEntry(home, agentId)).toEqual({ kind: 'damaged' });
    },
  );

  it('an agent with an entry lists as removing even without the mark in config.json', async () => {
    const agentId = newId();
    await writeAgentConfig(home, { v: 1, name: 'work', agentId, keyStore: 'keychain' });
    const directory = agentDirectory(home);
    expect((await directory.read('work'))?.removing).toBe(false);
    await recordRevokedEntry(home, agentId, 'anything');
    expect((await directory.read('work'))?.removing).toBe(true);
  });

  it('refuses an agent ID that is not the 04 §2.9 form (never a path)', async () => {
    for (const bad of ['../x', 'owner', '0xABC']) {
      await expect(recordRevokedEntry(home, bad, 'x')).rejects.toThrow();
      await expect(readRevokedEntry(home, bad)).rejects.toThrow();
    }
  });
});

describe('the removal port (U3-e, 06 §6 "Open agents and removal")', () => {
  it('exclusive is in_use while another process holds the shared lock; free once it is released', async () => {
    const agentId = newId();
    const paths = await writeAgentConfig(home, {
      v: 1,
      name: 'work',
      agentId,
      keyStore: 'keychain',
    });
    const port = uiRemovalPort({ home });
    const mcp = holdAgentFolderShared(paths.dir);
    const refused = await port
      .exclusive('work', () => Promise.resolve('ran'))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AgentFolderLockError);
    expect((refused as AgentFolderLockError).code).toBe('in_use');
    mcp.release();
    expect(await port.exclusive('work', () => Promise.resolve('ran'))).toBe('ran');
    // While the removal holds it, another process cannot open the agent.
    await port.exclusive('work', () => {
      expect(() => holdAgentFolderShared(paths.dir)).toThrow(AgentFolderLockError);
      return Promise.resolve();
    });
  });

  it('deletes a lock file left behind only once the config is gone (the Windows case)', async () => {
    const agentId = newId();
    const paths = await writeAgentConfig(home, {
      v: 1,
      name: 'work',
      agentId,
      keyStore: 'keychain',
    });
    await writeFile(join(paths.dir, 'open.lock'), '', { mode: 0o600 });
    await removeAgentFolderLock(home, 'work');
    expect((await stat(paths.dir)).isDirectory()).toBe(true);
    await rm(join(paths.dir, 'config.json'));
    await removeAgentFolderLock(home, 'work');
    await expect(stat(paths.dir)).rejects.toThrow();
  });

  // HOTFIX-045-REMOVE (B1): the remove gate deletes the folder (agentDirectory.removeFolder) inside
  // the port's exclusive hold. Real folder, real lock, real delete: nothing here is faked.
  it('deletes the agent folder from inside its own exclusive hold (HOTFIX-045-REMOVE)', async () => {
    const agentId = newId();
    const paths = await writeAgentConfig(home, {
      v: 1,
      name: 'work',
      agentId,
      keyStore: 'keychain',
      removing: true,
    });
    // The store and its WAL files, as an agent that was open leaves them.
    for (const file of ['store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm']) {
      await writeFile(join(paths.dir, file), 'x', { mode: 0o600 });
    }
    // The app host had the agent open (the shared lock): `open.lock` is in the folder.
    holdAgentFolderShared(paths.dir).release();
    const port = uiRemovalPort({ home });
    const directory = agentDirectory(home);
    await port.exclusive('work', () => directory.removeFolder('work'));
    await expect(stat(paths.dir)).rejects.toThrow();
    expect(await directory.read('work')).toBeUndefined();
  });

  // HOTFIX-045-REMOVE (IR round 1): a 0.4.4 removal that crashed or failed can have left a stale
  // `open.lock-journal`. Inside the exclusive hold that one name is removed; nothing else is.
  it.each([0, 512])(
    'a stale open.lock-journal (%d bytes) left by 0.4.4 no longer blocks the folder delete (HOTFIX-045-REMOVE)',
    async (size) => {
      const agentId = newId();
      const paths = await writeAgentConfig(home, {
        v: 1,
        name: 'work',
        agentId,
        keyStore: 'keychain',
        removing: true,
      });
      await writeFile(join(paths.dir, 'store.sqlite'), 'x', { mode: 0o600 });
      holdAgentFolderShared(paths.dir).release();
      await writeFile(join(paths.dir, 'open.lock-journal'), new Uint8Array(size), { mode: 0o600 });
      const port = uiRemovalPort({ home });
      const directory = agentDirectory(home);
      await port.exclusive('work', () => directory.removeFolder('work'));
      await expect(stat(paths.dir)).rejects.toThrow();
    },
  );

  it.runIf(POSIX)(
    'a link named open.lock-journal, or any other unknown file, still refuses the folder delete (HOTFIX-045-REMOVE)',
    async () => {
      const agentId = newId();
      const paths = await writeAgentConfig(home, {
        v: 1,
        name: 'work',
        agentId,
        keyStore: 'keychain',
        removing: true,
      });
      const target = join(home, 'elsewhere');
      await writeFile(target, 'keep', { mode: 0o600 });
      await symlink(target, join(paths.dir, 'open.lock-journal'));
      const port = uiRemovalPort({ home });
      const directory = agentDirectory(home);
      await expect(port.exclusive('work', () => directory.removeFolder('work'))).rejects.toThrow();
      expect((await lstat(join(paths.dir, 'open.lock-journal'))).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('keep');
      expect((await stat(join(paths.dir, 'config.json'))).isFile()).toBe(true);
      await rm(join(paths.dir, 'open.lock-journal'));
      await writeFile(join(paths.dir, 'notes.txt'), 'x', { mode: 0o600 });
      await expect(port.exclusive('work', () => directory.removeFolder('work'))).rejects.toThrow();
      expect((await stat(join(paths.dir, 'notes.txt'))).isFile()).toBe(true);
    },
  );

  it('opens an agent only inside its own exclusive hold', async () => {
    const agentId = newId();
    await writeAgentConfig(home, { v: 1, name: 'work', agentId, keyStore: 'keychain' });
    const port = uiRemovalPort({ home });
    expect(await port.open('work')).toBeUndefined();
    expect(await port.open('../etc')).toBeUndefined();
  });

  it('reports the recorded agent ID and backend, and nothing for an unknown agent', async () => {
    const agentId = newId();
    await writeAgentConfig(home, { v: 1, name: 'work', agentId, keyStore: 'file' });
    const port = uiRemovalPort({ home });
    expect(await port.keys('work')).toEqual({
      agentId,
      backend: 'file',
      keystoreDir: join(home, '.agentlink', 'keystore'),
    });
    expect(await port.keys('nobody')).toBeUndefined();
    expect(await port.keys('Bad!')).toBeUndefined();
    await expect(port.exclusive('nobody', () => Promise.resolve())).rejects.toThrow();
    // The revoked list goes through the same rules.
    await port.recordRevoked(agentId, 'text');
    expect(await port.readRevoked(agentId)).toEqual({ kind: 'entry', text: 'text' });
    expect((await lstat(revokedPath(agentId))).isFile()).toBe(true);
  });
});
