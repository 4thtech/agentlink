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
  readdir,
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
import { createAiAppsDesk } from '../harness/app-desk.js';
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

// W8-S3 (F16; 04 §2.5 step 5, "Writing AI app configs"; 06 §7): the AI app entries that run the
// agent being removed. Real files in a temp home, the real harness desk: only an entry that is
// exactly AgentLink's for this folder, at the fixed per-harness path, is removed; nothing else in
// any file changes; Claude Desktop is never written while it runs.
describe('W8-S3: AI app entries in a removal (04 §2.5 step 5)', () => {
  const stdio = (agent?: string) => ({
    command: 'npx',
    args: [
      '-y',
      '@4thtech-io/agentlink',
      'mcp',
      ...(agent === undefined ? [] : ['--agent', agent]),
    ],
  });
  const other = { command: 'other', env: { API_KEY: 'other-server-private-value' } };
  const ANTIGRAVITY = ['.gemini', 'config', 'mcp_config.json'];
  const CURSOR = ['.cursor', 'mcp.json'];
  const CLAUDE_CODE = ['.claude.json'];
  const DESKTOP = ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'];

  async function config(parts: readonly string[], servers: Record<string, unknown>) {
    const path = join(home, ...parts);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
    return path;
  }

  let desktopRuns = false;
  const portFor = () =>
    uiRemovalPort({
      home,
      aiApps: () =>
        createAiAppsDesk({
          home,
          env: {},
          platform: 'darwin',
          now: () => 1_800_000_000,
          desktopRunning: () => Promise.resolve(desktopRuns),
        }),
    });

  /** The observed state: ag-test's folder (config.json) and Antigravity running `--agent ag-test`. */
  async function observed() {
    desktopRuns = false;
    const agentId = newId();
    await writeAgentConfig(home, { v: 1, name: 'ag-test', agentId, keyStore: 'keychain' });
    await writeAgentConfig(home, {
      v: 1,
      name: 'personal',
      agentId: newId(),
      keyStore: 'keychain',
    });
    const antigravity = await config(ANTIGRAVITY, { other, agentlink: stdio('ag-test') });
    const cursor = await config(CURSOR, {
      agentlink: { type: 'stdio', ...stdio('personal') },
    });
    // Not exactly ours: same key, another program. Never touched, never listed.
    const claudeCode = await config(CLAUDE_CODE, {
      agentlink: { type: 'stdio', command: 'evil', args: ['--agent', 'ag-test'], env: {} },
    });
    return { agentId, antigravity, cursor, claudeCode };
  }

  it('lists only the apps whose entry is exactly ours for this folder', async () => {
    await observed();
    const port = portFor();
    expect(await port.appEntries('ag-test')).toEqual([{ app: 'antigravity', name: 'Antigravity' }]);
    expect(await port.appEntries('personal')).toEqual([{ app: 'cursor', name: 'Cursor' }]);
    expect(await port.appEntries('nobody')).toEqual([]);
    await expect(port.appEntries('../etc')).rejects.toThrow();
  });

  it('removes exactly that entry; every other member and every other file stays as it was', async () => {
    const { agentId, antigravity, cursor, claudeCode } = await observed();
    const cursorBefore = await readFile(cursor, 'utf8');
    const claudeBefore = await readFile(claudeCode, 'utf8');
    const port = portFor();
    const shown = await port.appEntries('ag-test');
    await port.removeAppEntries('ag-test', agentId, shown);
    const after = JSON.parse(await readFile(antigravity, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers).toEqual({ other });
    expect(await readFile(cursor, 'utf8')).toBe(cursorBefore);
    expect(await readFile(claudeCode, 'utf8')).toBe(claudeBefore);
    // A backup of the original is kept next to it.
    const names = await readdir(join(home, '.gemini', 'config'));
    expect(names.some((n) => n.startsWith('mcp_config.json.agentlink-backup-'))).toBe(true);
    // Try again: nothing left to remove, nothing written.
    expect(await port.appEntries('ag-test')).toEqual([]);
    await port.removeAppEntries('ag-test', agentId, []);
    expect((await readdir(join(home, '.gemini', 'config'))).length).toBe(names.length);
  });

  it('refuses when the folder records another agent ID, and writes nothing', async () => {
    const { antigravity } = await observed();
    const before = await readFile(antigravity, 'utf8');
    const port = portFor();
    const shown = await port.appEntries('ag-test');
    await expect(port.removeAppEntries('ag-test', newId(), shown)).rejects.toThrow();
    expect(await readFile(antigravity, 'utf8')).toBe(before);
  });

  it('Claude Desktop running: refuses before writing anything; once it quits the entry goes', async () => {
    const { agentId } = await observed();
    const desktop = await config(DESKTOP, { other, agentlink: stdio('ag-test') });
    const before = await readFile(desktop, 'utf8');
    const port = portFor();
    const shown = await port.appEntries('ag-test');
    expect(shown.map((a) => a.app).sort()).toEqual(['antigravity', 'claude-desktop']);
    desktopRuns = true;
    await expect(port.removeAppEntries('ag-test', agentId, shown)).rejects.toThrow();
    expect(await readFile(desktop, 'utf8')).toBe(before);
    desktopRuns = false;
    await port.removeAppEntries('ag-test', agentId, await port.appEntries('ag-test'));
    const after = JSON.parse(await readFile(desktop, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers).toEqual({ other });
  });

  it('an entry that was not shown before the gesture is never written: refused, so Try again shows it', async () => {
    const { agentId, antigravity } = await observed();
    const before = await readFile(antigravity, 'utf8');
    const port = portFor();
    await expect(port.removeAppEntries('ag-test', agentId, [])).rejects.toThrow();
    expect(await readFile(antigravity, 'utf8')).toBe(before);
  });

  it('an entry that moved to another ID after the statement is left alone', async () => {
    const { agentId, antigravity } = await observed();
    const port = portFor();
    const shown = await port.appEntries('ag-test');
    await config(ANTIGRAVITY, { other, agentlink: stdio('personal') });
    const moved = await readFile(antigravity, 'utf8');
    await port.removeAppEntries('ag-test', agentId, shown);
    expect(await readFile(antigravity, 'utf8')).toBe(moved);
  });
});
