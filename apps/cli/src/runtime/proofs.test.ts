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
import { encodeHex, encodeUtf8, keccak256 } from '@4thtech-io/crypto';
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
  it('routes automatic selection to exactly the chains the testnet faucet serves', () => {
    // Gnosis Chiado (10200) joins once the faucet allowlist names it; today that is Base Sepolia only.
    const proofs = nodeProofs();
    const ids = proofs?.platform.chains.map((c) => c.config.chainId) ?? [];
    expect(ids).toEqual(
      chain
        .chainRegistry()
        .filter((c) => chain.isFaucetChain(c.chainId))
        .map((c) => c.chainId),
    );
    expect(ids).toContain(84532);
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

// M1-26-c (07 §6.3, D-40, D-108; 06 §2.1 `credits`, `prices`; 06 §2.4 `needs_credits`): the paid
// path and `agentlink_status` follow one selection. A mocked RPC plays the fee vault on two testnets
// that share contract addresses (CREATE3) and differ by RPC host: Base Sepolia and a hypothetical
// third testnet. The core's notarize selects with `platform.selector` over `platform.chains`
// (packages/core proofs/service.ts `#select`); these tests make that exact call, and read
// `tools.account()` beside it.
describe('nodeProofs: paid calls and status follow the automatic selection (M1-26-c)', () => {
  const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
  const PAYER = `0x${'11'.repeat(20)}`;
  const BASE = chain.getChainConfig(84532) as chain.ChainConfig;
  const THIRD: chain.ChainConfig = Object.freeze({
    ...BASE,
    key: 'third-testnet',
    chainId: 11155420,
    rpcUrls: ['https://third-testnet-rpc.publicnode.com', 'https://third-testnet.drpc.org'],
  });

  /** The fee vault's view functions by 4-byte selector (from the shipped ABI, no viem here). */
  const SELECTORS = new Map(
    chain.FEE_VAULT_CLIENT_ABI.flatMap((item) => {
      if (item.type !== 'function') return [];
      const signature = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
      const selector = `0x${encodeHex(keccak256(encodeUtf8(signature))).slice(0, 8)}`;
      return [[selector, item.name] as const];
    }),
  );

  interface Fake {
    /** Fee in USDC base units (6 decimals). */
    readonly fee: bigint;
    readonly credits?: bigint;
  }

  function rpc(fakes: ReadonlyMap<number, Fake>, configs: readonly chain.ChainConfig[]) {
    const hosts: string[] = [];
    const byHost = new Map<string, chain.ChainConfig>();
    for (const config of configs) {
      for (const url of config.rpcUrls) byHost.set(new URL(url).host, config);
    }
    const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const host = new URL(url).host;
      hosts.push(host);
      const config = byHost.get(host);
      const fake = config === undefined ? undefined : fakes.get(config.chainId);
      if (config === undefined || fake === undefined) return Promise.reject(new Error('offline'));
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const answer = (result: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (body.method === 'eth_chainId') return answer(`0x${config.chainId.toString(16)}`);
      if (body.method !== 'eth_call') return Promise.reject(new Error('unexpected method'));
      const tx = body.params[0] as { to: string; data: string };
      const functionName = SELECTORS.get(tx.data.slice(0, 10).toLowerCase());
      let words: bigint[];
      if (functionName === 'quote') words = [fake.fee, 0n, fake.fee];
      else if (functionName === 'creditsOf') words = [fake.credits ?? 0n];
      else if (functionName === 'minDeposit') words = [0n];
      else return Promise.reject(new Error('unexpected function'));
      return answer(`0x${words.map((w) => w.toString(16).padStart(64, '0')).join('')}`);
    };
    Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
    return { fetchFn: fn as unknown as chain.RpcFetchFn, hosts };
  }

  /** The core's own selection call (proofs/service.ts `#select`), on the platform it is given. */
  function coreSelect(proofs: NonNullable<ReturnType<typeof nodeProofs>>, defaultChain?: string) {
    const { platform } = proofs;
    return platform.selector!.select(
      platform.chains.map((c) => ({ config: c.config, client: c.client })),
      PAYER as chain.Hex,
      { feeType: 'NOTARIZE', ...(defaultChain === undefined ? {} : { defaultChain }) },
    );
  }

  it('credits on one chain only: the paid call pays there, and status prices and credits follow it', async () => {
    // Base Sepolia is listed first and is cheaper, but holds no credits; the third testnet is funded.
    const fakes = new Map<number, Fake>([
      [BASE.chainId, { fee: 100_000n }],
      [THIRD.chainId, { fee: 200_000n, credits: 5_000_000n }],
    ]);
    const { fetchFn } = rpc(fakes, [BASE, THIRD]);
    const proofs = nodeProofs({ fetchFn, submitterUrls: [], configs: [BASE, THIRD] })!;
    const selection = await coreSelect(proofs);
    expect(selection).toMatchObject({ status: 'ok', chainId: THIRD.chainId, payFrom: 'credits' });

    const account = await proofs.tools.account(PAYER);
    expect(account?.prices).toEqual([
      { action: 'notarize', usd: '0.2', protocolUsd: '0.2', integratorUsd: '0' },
    ]);
    // The paying chain's credits come first.
    expect(account?.credits[0]).toMatchObject({ chain: THIRD.key, usd: '5' });
  });

  it('nothing funded: the paid call gets needs_credits routed to the cheapest chain, and status prices it there', async () => {
    const fakes = new Map<number, Fake>([
      [BASE.chainId, { fee: 100_000n }],
      [THIRD.chainId, { fee: 50_000n }],
    ]);
    const { fetchFn } = rpc(fakes, [BASE, THIRD]);
    const proofs = nodeProofs({ fetchFn, submitterUrls: [], configs: [BASE, THIRD] })!;
    const selection = await coreSelect(proofs);
    expect(selection).toMatchObject({
      status: 'needs_credits',
      topUp: { chainId: THIRD.chainId, feeUsd: '0.05' },
    });
    const account = await proofs.tools.account(PAYER);
    expect(account?.prices).toEqual([
      { action: 'notarize', usd: '0.05', protocolUsd: '0.05', integratorUsd: '0' },
    ]);
  });

  it('status follows the policy default chain, as the paid call does', async () => {
    const fakes = new Map<number, Fake>([
      [BASE.chainId, { fee: 100_000n, credits: 1_000_000n }],
      [THIRD.chainId, { fee: 50_000n, credits: 1_000_000n }],
    ]);
    const { fetchFn } = rpc(fakes, [BASE, THIRD]);
    const proofs = nodeProofs({ fetchFn, submitterUrls: [], configs: [BASE, THIRD] })!;
    expect(await coreSelect(proofs, 'base')).toMatchObject({ status: 'ok', chainId: BASE.chainId });
    const account = await proofs.tools.account(PAYER, { defaultChain: 'base' });
    expect(account?.prices[0]?.usd).toBe('0.1');
    expect(account?.credits[0]?.chain).toBe(BASE.key);
    // Without a default chain the cheaper funded one pays, and status says so.
    const cheapest = await proofs.tools.account(PAYER);
    expect(cheapest?.prices[0]?.usd).toBe('0.05');
    expect(cheapest?.credits[0]?.chain).toBe(THIRD.key);
  });

  it('Gnosis Chiado is never selected or read: not for the paid call, not for status', async () => {
    const shipped = chain.chainRegistry();
    const chiado = shipped.find((c) => c.chainId === 10200) as chain.ChainConfig;
    const base = shipped.find((c) => c.chainId === 84532) as chain.ChainConfig;
    const fakes = new Map<number, Fake>([
      [base.chainId, { fee: 100_000n }],
      [chiado.chainId, { fee: 1n, credits: 10n ** 24n }],
    ]);
    const { fetchFn, hosts } = rpc(fakes, [base, chiado]);
    // The shipped defaults: no `configs`.
    const proofs = nodeProofs({ fetchFn, submitterUrls: [] })!;
    const selection = await coreSelect(proofs);
    expect(selection).toMatchObject({ status: 'needs_credits', topUp: { chainId: base.chainId } });
    const account = await proofs.tools.account(PAYER);
    expect(account?.credits.map((c) => c.chain)).not.toContain(chiado.key);
    expect(proofs.tools.chainIdOf(chiado.key)).toBeUndefined();
    const chiadoHosts = chiado.rpcUrls.map((u) => new URL(u).host);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(chiadoHosts).not.toContain(host);
  });
});
