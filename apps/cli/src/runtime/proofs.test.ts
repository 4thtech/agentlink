// M1-9d-2: the Node proof-pack files of the CLI (src/runtime/proofs.ts; 06 §2.4, D-87, G-25; 04 §4).
// Real file system under a temporary home:
// - `readPack` (agentlink_verify_proof_pack `path`): a path outside `proofs.exportFolder` and
//   `files.inboxFolder` is refused by a lexical check before any disk access (the open seam is never
//   called); then realpath, the hidden and protected refusals, a no-follow open of a regular file
//   whose device and inode match, and the 256 KiB cap; fixed codes only, never the path or bytes.
// - `savePack` (agentlink_export_proof_pack): a new 0600 file in the export folder, never
//   overwriting, never following a link; a hidden or protected folder is refused.
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeProofPacks, nodeProofs } from './proofs.js';

let home: string;
const FOLDERS = { exportFolder: '~/AgentLink/Proofs', inboxFolder: '~/AgentLink/Inbox' };
const PACK = '{"type":"agentlink.proof"}';

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-rt-proofs-')));
  await mkdir(path.join(home, 'AgentLink', 'Proofs'), { recursive: true });
  await mkdir(path.join(home, 'AgentLink', 'Inbox'), { recursive: true });
  await writeFile(path.join(home, 'AgentLink', 'Proofs', 'a.json'), PACK);
  await writeFile(path.join(home, 'AgentLink', 'Inbox', 'b.json'), PACK);
  await writeFile(path.join(home, 'outside.json'), 'SECRET-OUTSIDE');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function packs() {
  const opened: string[] = [];
  const reader = nodeProofPacks({ home, onOpen: (p) => void opened.push(p) });
  return { reader, opened };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('readPack (D-87)', () => {
  it('reads a pack in the export folder by a relative path, and one in the inbox folder', async () => {
    const { reader } = packs();
    const a = await reader.readPack('a.json', FOLDERS);
    expect(a.ok && text(a.bytes)).toBe(PACK);
    const b = await reader.readPack('~/AgentLink/Inbox/b.json', FOLDERS);
    expect(b.ok && text(b.bytes)).toBe(PACK);
    const c = await reader.readPack(path.join(home, 'AgentLink', 'Proofs', 'a.json'), FOLDERS);
    expect(c.ok).toBe(true);
  });

  it('outside both folders: PATH_NOT_ALLOWED from the lexical check, the file never opened', async () => {
    const { reader, opened } = packs();
    for (const p of [
      path.join(home, 'outside.json'),
      '~/outside.json',
      '../outside.json',
      '~/AgentLink/Proofs/../../outside.json',
      '/etc/passwd',
      '~/AgentLink/ProofsX/a.json',
    ]) {
      expect(await reader.readPack(p, FOLDERS), p).toEqual({ ok: false, code: 'PATH_NOT_ALLOWED' });
    }
    expect(opened).toEqual([]);
  });

  it('a link inside the folder that escapes it is refused', async () => {
    await symlink(
      path.join(home, 'outside.json'),
      path.join(home, 'AgentLink', 'Proofs', 'l.json'),
    );
    const { reader } = packs();
    expect(await reader.readPack('l.json', FOLDERS)).toEqual({
      ok: false,
      code: 'PATH_NOT_ALLOWED',
    });
  });

  it('a hidden file, a folder and a missing file are refused with the same fixed code', async () => {
    await writeFile(path.join(home, 'AgentLink', 'Proofs', '.hidden.json'), PACK);
    await mkdir(path.join(home, 'AgentLink', 'Proofs', 'dir.json'));
    const { reader } = packs();
    for (const p of ['.hidden.json', 'dir.json', 'missing.json']) {
      expect(await reader.readPack(p, FOLDERS), p).toEqual({ ok: false, code: 'PATH_NOT_ALLOWED' });
    }
  });

  it('above 256 KiB: PACK_TOO_LARGE, never the bytes', async () => {
    await writeFile(path.join(home, 'AgentLink', 'Proofs', 'big.json'), 'x'.repeat(256 * 1024 + 1));
    const { reader } = packs();
    expect(await reader.readPack('big.json', FOLDERS)).toEqual({
      ok: false,
      code: 'PACK_TOO_LARGE',
    });
  });

  it('a folder in the rules that is malformed or missing allows nothing', async () => {
    const { reader } = packs();
    expect(
      await reader.readPack('a.json', { exportFolder: 'relative/folder', inboxFolder: '' }),
    ).toEqual({ ok: false, code: 'PATH_NOT_ALLOWED' });
  });
});

describe('savePack', () => {
  it('writes a new 0600 file into the export folder and never overwrites', async () => {
    const { reader } = packs();
    const id = `0x${'1f'.repeat(32)}`;
    const first = await reader.savePack('~/AgentLink/Proofs', id, PACK);
    const second = await reader.savePack('~/AgentLink/Proofs', id, '{"n":2}');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.savedTo).not.toBe(second.savedTo);
    expect(path.dirname(first.savedTo)).toBe(path.join(home, 'AgentLink', 'Proofs'));
    expect(await readFile(first.savedTo, 'utf8')).toBe(PACK);
    expect(await readFile(second.savedTo, 'utf8')).toBe('{"n":2}');
    if (process.platform !== 'win32') {
      expect((await lstat(first.savedTo)).mode & 0o777).toBe(0o600);
    }
  });

  it('creates a missing export folder (0700)', async () => {
    const { reader } = packs();
    const saved = await reader.savePack('~/Exports/Proofs', `0x${'2e'.repeat(32)}`, PACK);
    expect(saved.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect((await lstat(path.join(home, 'Exports', 'Proofs'))).mode & 0o777).toBe(0o700);
    }
  });

  it('a hidden, protected or relative folder is refused with a fixed reason', async () => {
    const { reader } = packs();
    for (const folder of ['~/.hidden', '~/.ssh', 'relative']) {
      expect(await reader.savePack(folder, `0x${'2e'.repeat(32)}`, PACK), folder).toEqual({
        ok: false,
        reason: 'folder',
      });
    }
  });
});

describe('nodeProofs: the default chain set (M1-3j-b)', () => {
  it('does not route automatic selection to Gnosis Chiado (10200) before its smoke test and faucet', () => {
    const proofs = nodeProofs();
    const ids = proofs?.platform.chains.map((c) => c.config.chainId) ?? [];
    expect(ids).toEqual([84532]);
  });
});
