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
import * as chain from '@4thtech-io/chain';
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

// M1-26-b (02 F-51, 07 §6.3 step 4, §8; D-40): a proof pack carries its chain, so it verifies with
// no chain configured. Verification resolves the pack's `chainId` from the whole shipped list
// (`chainRegistry()`), not from the automatic-selection set: a pack recorded through the Advanced
// override on a chain that automatic selection holds back (Gnosis Chiado, M1-3j-b) is still read
// from that chain's shipped RPC and its known Notary. The stub RPC is offline, so the check ends
// as `chain_unavailable` after reading that chain; without the fix a held-back chain's pack ends
// as `unsupported_chain` without any read.
describe('nodeProofs: a pack verifies with no chain configured (M1-26-b)', () => {
  const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
  const hex = (bytes: number, byte: string) => `0x${byte.repeat(bytes)}` as `0x${string}`;

  function offlineRpc(): { fetchFn: chain.RpcFetchFn; hosts: string[] } {
    const hosts: string[] = [];
    const fn = (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      hosts.push(new URL(url).host);
      return Promise.reject(new Error('offline'));
    };
    Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
    return { fetchFn: fn as unknown as chain.RpcFetchFn, hosts };
  }

  function packFor(chainId: number, notaryAddress: string): Record<string, unknown> {
    const signer = hex(20, 'a1');
    const notary = notaryAddress.toLowerCase() as `0x${string}`;
    const envelopeHash = hex(32, '2e');
    return {
      type: 'agentlink.proof',
      version: 1,
      chainId,
      notary,
      recordId: chain.computeRecordId(chainId, notary, signer, 7n),
      record: {
        signer,
        envelopeHash,
        recipientCommitment: hex(32, 'c1'),
        parentRecordId: hex(32, '00'),
        appId: hex(32, '00'),
        kind: 1,
        feeToken: hex(20, '3d'),
        maxFee: '100000',
        nonce: '7',
        deadline: 1_760_003_600,
      },
      signature: hex(65, '1b'),
      signer: { evm: signer },
      envelopeHash,
      receipts: [],
      disclosure: null,
      ownerApproval: null,
      exportedAt: '2026-10-19T10:00:00Z',
    };
  }

  it('reads a pack from every shipped chain, including one automatic selection holds back', async () => {
    const shipped = chain.chainRegistry();
    expect(shipped.map((c) => c.chainId)).toContain(10200);
    for (const config of shipped) {
      const { fetchFn, hosts } = offlineRpc();
      // No `configs`, no default chain, no user RPC: the shipped defaults only.
      const proofs = nodeProofs({ fetchFn, submitterUrls: [] });
      const result = await proofs!.tools.verify(packFor(config.chainId, config.contracts.notary));
      expect(result.valid, config.key).toBe(false);
      expect(result.valid ? undefined : result.reason, config.key).toBe('chain_unavailable');
      const shippedHosts = config.rpcUrls.map((u) => new URL(u).host);
      expect(hosts.length, config.key).toBeGreaterThan(0);
      for (const host of hosts) expect(shippedHosts, config.key).toContain(host);
    }
  }, 60_000);

  it('a pack naming a chain this release does not ship is refused without any read', async () => {
    const { fetchFn, hosts } = offlineRpc();
    const proofs = nodeProofs({ fetchFn, submitterUrls: [] });
    const result = await proofs!.tools.verify(packFor(999_999, hex(20, '9a')));
    expect(result.valid ? undefined : result.reason).toBe('unsupported_chain');
    expect(hosts).toEqual([]);
  });
});
