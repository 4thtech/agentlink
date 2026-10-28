// U3-c: the app host's AgentDirectory over agent-dir.ts (08 §1; 06 §6; 07 §9.1; D-138).
//
// - Existing users (owner request 2026-10-29): after the update every existing agent in
//   ~/.agentlink/agents is listed, including ones created by older versions (the four-key config),
//   and none is lost or renamed; a folder whose config cannot be read is listed as unavailable.
// - `label` and `removing` in config.json: strict forms; old configs read exactly as before.
// - app.json: 0600, written atomically, trusted for nothing but order; anything odd is ignored.
// - The folder rules stay here: no recursive delete; links refused.
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDirectory,
  markAgentRemoving,
  parseAgentConfig,
  readAgentConfig,
  readAppCurrent,
  removeAgentFolder,
  writeAgentConfig,
  writeAgentLabel,
  writeAppCurrent,
} from './agent-dir.js';
import { isAgentLabel } from './agent-name.js';
import { RuntimeError } from './errors.js';

const POSIX = process.platform !== 'win32';
const newId = (): string => `0x${encodeHex(randomBytes(20))}`;
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-u3c-dir-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const codeOf = (error: unknown): unknown => (error instanceof RuntimeError ? error.code : error);

/** A config exactly as an older version wrote it (four keys, one line). */
async function oldAgent(name: string): Promise<string> {
  const agentId = newId();
  await writeAgentConfig(home, { v: 1, name, agentId, keyStore: 'keychain' });
  return agentId;
}

describe('agent labels and the removing mark in config.json (U3-c, 07 §9.1)', () => {
  it('an old four-key config reads exactly as before: no label, not removing, the name kept', async () => {
    const agentId = await oldAgent('default');
    const found = await readAgentConfig(home, 'default');
    expect(found?.config).toEqual({ v: 1, name: 'default', agentId, keyStore: 'keychain' });
  });

  it('accepts a valid label and removing: true; refuses any other form or key', () => {
    const base = { v: 1, name: 'work', agentId: newId(), keyStore: 'keychain' };
    expect(parseAgentConfig(JSON.stringify({ ...base, label: "Tali's work" }), 'work').label).toBe(
      "Tali's work",
    );
    expect(parseAgentConfig(JSON.stringify({ ...base, removing: true }), 'work').removing).toBe(true);
    for (const bad of [
      { label: '' },
      { label: 'x'.repeat(33) },
      { label: '<b>hi</b>' },
      { label: 'a‮b' },
      { label: ' lead' },
      { label: 7 },
      { removing: false },
      { removing: 'true' },
      { other: 1 },
    ]) {
      expect(() => parseAgentConfig(JSON.stringify({ ...base, ...bad }), 'work'), JSON.stringify(bad)).toThrow(
        RuntimeError,
      );
    }
  });

  it('the label rule: 1 to 32 letters, digits, spaces, dots, apostrophes and hyphens', () => {
    for (const ok of ['My agent', 'Work', 'Ana-Marija', "O'Neil", 'v2.0', 'Žiga', '日本', 'x'.repeat(32)]) {
      expect(isAgentLabel(ok), ok).toBe(true);
    }
    for (const bad of ['', ' ', 'a  b', 'tab\there', 'new\nline', 'a/b', 'a_b', 'é', 'zero​width', 'x'.repeat(33)]) {
      expect(isAgentLabel(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('writeAgentLabel and markAgentRemoving keep every other field and the folder name', async () => {
    const agentId = await oldAgent('work');
    await writeAgentLabel(home, 'work', 'Work');
    await markAgentRemoving(home, 'work');
    const found = await readAgentConfig(home, 'work');
    expect(found?.config).toEqual({
      v: 1,
      name: 'work',
      agentId,
      keyStore: 'keychain',
      label: 'Work',
      removing: true,
    });
    if (POSIX) expect((await stat(join(home, '.agentlink/agents/work/config.json'))).mode & 0o777).toBe(0o600);
    expect(codeOf(await writeAgentLabel(home, 'work', 'bad/label').catch((e: unknown) => e))).toBe(
      'agent_label_invalid',
    );
    expect(await readdir(join(home, '.agentlink/agents'))).toEqual(['work']);
  });
});

describe('agentDirectory (U3-c, the node AgentDirectory seam)', () => {
  it('lists every existing agent, old and new, sorted, none lost or renamed', async () => {
    await oldAgent('default');
    await oldAgent('work');
    await writeAgentConfig(home, {
      v: 1,
      name: 'home',
      agentId: newId(),
      keyStore: 'keychain',
      label: 'Family',
    });
    // A folder whose config is damaged, and one without a config: listed, never opened.
    await mkdir(join(home, '.agentlink/agents/broken'), { mode: 0o700 });
    await writeFile(join(home, '.agentlink/agents/broken/config.json'), '{', { mode: 0o600 });
    await mkdir(join(home, '.agentlink/agents/empty'), { mode: 0o700 });
    // Not agent names: never listed (06 §6).
    await mkdir(join(home, '.agentlink/agents/Bad_Name'), { mode: 0o700 });
    const list = await agentDirectory(home).list();
    expect(list).toEqual([
      { name: 'broken', label: 'broken', available: false, removing: false },
      { name: 'default', label: 'default', available: true, removing: false },
      { name: 'empty', label: 'empty', available: false, removing: false },
      { name: 'home', label: 'Family', available: true, removing: false },
      { name: 'work', label: 'work', available: true, removing: false },
    ]);
    // Listing changed nothing on disk.
    expect((await readdir(join(home, '.agentlink/agents'))).sort()).toEqual([
      'Bad_Name',
      'broken',
      'default',
      'empty',
      'home',
      'work',
    ]);
  });

  it('reports removing for the mark and for an entry in the owner revoked list', async () => {
    await oldAgent('a');
    const revokedId = await oldAgent('b');
    await markAgentRemoving(home, 'a');
    await mkdir(join(home, '.agentlink/revoked'), { mode: 0o700 });
    await writeFile(join(home, '.agentlink/revoked', `${revokedId}.json`), '{}', { mode: 0o600 });
    const directory = agentDirectory(home);
    expect(await directory.read('a')).toMatchObject({ removing: true, available: true });
    expect(await directory.read('b')).toMatchObject({ removing: true, available: true });
    expect(await directory.read('nobody')).toBeUndefined();
    expect(await directory.read('../a')).toBeUndefined();
  });

  it('stats answers undefined without a store, and never throws', async () => {
    await oldAgent('default');
    expect(await agentDirectory(home).stats('default')).toBeUndefined();
    expect(await agentDirectory(home).stats('Nope')).toBeUndefined();
  });
});

describe('app.json (U3-c, 07 §9.1)', () => {
  it('writes {v:1,current} with mode 0600 and reads it back', async () => {
    await writeAppCurrent(home, 'work');
    const path = join(home, '.agentlink/app.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 1, current: 'work' });
    if (POSIX) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readAppCurrent(home)).toBe('work');
    await writeAppCurrent(home, 'home');
    expect(await readAppCurrent(home)).toBe('home');
    expect(codeOf(await writeAppCurrent(home, '../x').catch((e: unknown) => e))).toBe('agent_name_invalid');
  });

  it('ignores a missing, malformed, oversized, linked or loose app.json', async () => {
    expect(await readAppCurrent(home)).toBeUndefined();
    await writeAppCurrent(home, 'work');
    const path = join(home, '.agentlink/app.json');
    for (const text of ['{', '[]', '{"v":2,"current":"work"}', '{"v":1,"current":"Work"}', '{"v":1,"current":"work","x":1}', `{"v":1,"current":"${'a'.repeat(300)}"}`]) {
      await writeFile(path, text, { mode: 0o600 });
      expect(await readAppCurrent(home), text).toBeUndefined();
    }
    if (POSIX) {
      await writeFile(path, '{"v":1,"current":"work"}', { mode: 0o600 });
      await chmod(path, 0o644);
      expect(await readAppCurrent(home)).toBeUndefined();
      await rm(path);
      const target = join(home, 'elsewhere.json');
      await writeFile(target, '{"v":1,"current":"work"}', { mode: 0o600 });
      await symlink(target, path);
      expect(await readAppCurrent(home)).toBeUndefined();
      // A link is never written through either.
      expect(codeOf(await writeAppCurrent(home, 'home').catch((e: unknown) => e))).toBe('agent_path_invalid');
      expect(await readFile(target, 'utf8')).toBe('{"v":1,"current":"work"}');
    }
  });
});

describe('removeAgentFolder (U3-c seam; card U3-e calls it)', () => {
  it('deletes only the known files and the folder; never a recursive delete', async () => {
    await oldAgent('gone');
    const dir = join(home, '.agentlink/agents/gone');
    for (const file of ['store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm', 'store.sqlite.lock', 'open.lock']) {
      await writeFile(join(dir, file), '', { mode: 0o600 });
    }
    await removeAgentFolder(home, 'gone');
    expect(await readdir(join(home, '.agentlink/agents'))).toEqual([]);
  });

  it('refuses a folder that still holds anything else, and leaves it', async () => {
    await oldAgent('keep');
    const dir = join(home, '.agentlink/agents/keep');
    await writeFile(join(dir, 'notes.txt'), 'mine', { mode: 0o600 });
    expect(codeOf(await removeAgentFolder(home, 'keep').catch((e: unknown) => e))).toBe('agent_path_invalid');
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
    // Nothing was deleted: the agent still reads.
    expect(await readAgentConfig(home, 'keep')).toBeDefined();
  });
});
