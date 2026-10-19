// The Node proof platform of the CLI (M1-9d-2; 06 §2.1, §2.4; 07 §6.1–§6.3, §8; 04 §4; D-40, D-87,
// G-25). The core never builds an RPC client, a submitter or a direct signer itself (packages/core
// proofs/platform.ts); this module supplies them from the shipped chain list, plus the file and
// network halves of the proof tools:
//
// - nodeProofs: for every automatically selectable chain (`autoSelectableChains()`, the `chainRegistry()` set minus Chiado until M1-3j-b: the shipped testnets with a deployment
//   in the pinned contracts release) an address-checked read client (`nodeRpcFetch`, 04 §4), its
//   chain-state port and a proof submitter (the 4thTech submitter, failover per 07 §6.2); the
//   chain package's own functions as the core's `kit`; one chain selector shared by the core and the
//   submitters (07 §6.3). The Notary address always comes from the shipped config, never from a
//   message or a pack.
// - verify: `verifyProofPack` against those chains only (07 §8): a pack naming any other chain or
//   Notary fails with a fixed code.
// - account: credits on every chain and the notarize price (USD, protocol and app parts) on the
//   first chain that answers, within a short budget; undefined when none answered.
// - nodeProofPacks: the pack files. `readPack` confines `path` to `proofs.exportFolder` and
//   `files.inboxFolder` (D-87): a lexical check of the normalised path before any disk access, then
//   @4thtech-io/node's `openAllowedFile` (realpath on both sides, hidden and protected refusals,
//   no-follow open of a regular file whose device and inode match), then the 256 KiB cap. Only the
//   fixed codes leave: never the path, the resolved path or the bytes. `savePack` writes a new 0600
//   file into the export folder, exclusively (never overwriting, never following a final link).
//
// Nothing here logs, and no error carries a path, a URL or a value (I-7).
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as chain from '@4thtech-io/chain';
import {
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  type PathFlavor,
  type ProofChain,
  type ProofsPlatform,
} from '@4thtech-io/core';
import { nodeRpcFetch, openAllowedFile } from '@4thtech-io/node';
import type {
  AccountView,
  PackCheck,
  PackFolders,
  PackReadOutcome,
  PackSaveOutcome,
  ProofPlatformTools,
} from '../tools/context.js';
import { resolveOwnFolder } from './files.js';

const FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';
const SEP = FLAVOR === 'win32' ? '\\' : '/';

/** 07 §8, D-87: the largest pack file. */
export const MAX_PACK_FILE_BYTES = chain.MAX_PROOF_PACK_BYTES;

/** The 4thTech submitter (D-28 testing hostname, 07 §6.2); the client fails over between URLs. */
export const SUBMITTER_DEFAULT_URLS: readonly string[] = Object.freeze([
  'https://submit.agentlink.4thtech.io',
]);

/** How long `agentlink_status` waits for credits and prices (06 §2.1: a short catch-up). */
export const ACCOUNT_BUDGET_MS = 3_000;

// ---- Pack files ----------------------------------------------------------------------------------

export interface NodeProofPacksOptions {
  /** The home folder `~/` stands for. Default: the OS user's. */
  readonly home?: string;
  /** Test seam: called with the checked path each time a pack file is actually opened. */
  readonly onOpen?: (requested: string) => void;
}

const NOT_ALLOWED: PackReadOutcome = Object.freeze({ ok: false, code: 'PATH_NOT_ALLOWED' });
const TOO_LARGE: PackReadOutcome = Object.freeze({ ok: false, code: 'PACK_TOO_LARGE' });
const INVALID: PackReadOutcome = Object.freeze({ ok: false, code: 'PACK_INVALID' });

/** A policy folder as a full, lexically valid path; undefined otherwise. */
function folderPath(folder: unknown, home: string): string | undefined {
  if (typeof folder !== 'string' || folder === '') return undefined;
  const abs = expandHome(folder, home, FLAVOR);
  return parseAbsolutePath(abs, FLAVOR) === undefined ? undefined : abs;
}

/**
 * The requested path in full form, lexically (D-87): `~/` is the home folder, a relative path is
 * below the export folder. No normalisation: a `.`, `..` or empty segment makes it invalid.
 */
function requestedPath(requested: string, home: string, exportFolder: string | undefined) {
  if (requested.startsWith('~')) {
    const abs = expandHome(requested, home, FLAVOR);
    return parseAbsolutePath(abs, FLAVOR) === undefined ? undefined : abs;
  }
  if (parseAbsolutePath(requested, FLAVOR) !== undefined) return requested;
  if (exportFolder === undefined || /^[\\/]/.test(requested) || /^[a-zA-Z]:/.test(requested)) {
    return undefined;
  }
  const joined = `${exportFolder.replace(/[\\/]+$/, '')}${SEP}${requested}`;
  return parseAbsolutePath(joined, FLAVOR) === undefined ? undefined : joined;
}

/** A file name for a saved pack: from the record ID and a counter; never from inbound text. */
const packName = (recordId: string, n: number): string => {
  const id = /^0x[0-9a-f]{64}$/.test(recordId) ? recordId.slice(2, 18) : 'record';
  return `agentlink-proof-${id}${n === 0 ? '' : `-${String(n)}`}.json`;
};

export function nodeProofPacks(
  options: NodeProofPacksOptions = {},
): Pick<ProofPlatformTools, 'readPack' | 'savePack'> {
  const home = options.home ?? homedir();
  return Object.freeze({
    async readPack(requested: string, folders: PackFolders): Promise<PackReadOutcome> {
      if (typeof requested !== 'string' || requested === '') return NOT_ALLOWED;
      const exportFolder = folderPath(folders.exportFolder, home);
      const inboxFolder = folderPath(folders.inboxFolder, home);
      const allowed = [exportFolder, inboxFolder].filter((f): f is string => f !== undefined);
      const abs = requestedPath(requested, home, exportFolder);
      // 1. Lexical, before any disk access: strictly inside one of the two folders.
      if (
        abs === undefined ||
        !allowed.some((folder) => isInsideFolder(abs, folder, { flavor: FLAVOR, self: 'outside' }))
      ) {
        return NOT_ALLOWED;
      }
      // 2. realpath on both sides, hidden and protected refusals, no-follow open, regular file,
      //    device and inode (M1-15 `openAllowedFile`).
      options.onOpen?.(abs);
      let opened;
      try {
        opened = await openAllowedFile(abs, { allowedFolders: allowed, home });
      } catch {
        return NOT_ALLOWED;
      }
      const { handle } = opened;
      try {
        // 3. The cap: never more than one byte past it is read.
        if (opened.file.size > MAX_PACK_FILE_BYTES) return TOO_LARGE;
        const buffer = new Uint8Array(MAX_PACK_FILE_BYTES + 1);
        let length = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
          if (length > MAX_PACK_FILE_BYTES) return TOO_LARGE;
        }
        return { ok: true, bytes: buffer.slice(0, length) };
      } catch {
        return INVALID;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async savePack(folder: string, recordId: string, json: string): Promise<PackSaveOutcome> {
      let real: string;
      try {
        real = await resolveOwnFolder(folder, home);
      } catch {
        return { ok: false, reason: 'folder' };
      }
      const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      const bytes = new TextEncoder().encode(json);
      for (let n = 0; n < 100; n += 1) {
        const target = path.join(real, packName(recordId, n));
        let handle;
        try {
          // Exclusive (O_EXCL with O_CREAT never follows a final link and never overwrites), 0600.
          handle = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
            0o600,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          return { ok: false, reason: 'folder' };
        }
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            offset += bytesWritten;
          }
        } catch {
          return { ok: false, reason: 'folder' };
        } finally {
          await handle.close().catch(() => undefined);
        }
        return { ok: true, savedTo: target };
      }
      return { ok: false, reason: 'folder' };
    },
  });
}

// ---- Chains ----------------------------------------------------------------------------------------

export interface NodeProofsOptions extends NodeProofPacksOptions {
  /** The address-checked RPC fetch. Default: `nodeRpcFetch()`. */
  readonly fetchFn?: chain.RpcFetchFn;
  /** Submitter base URLs. Default: SUBMITTER_DEFAULT_URLS. */
  readonly submitterUrls?: readonly string[];
  /** The supported chains. Default: `autoSelectableChains()` (Chiado is held back, M1-3j-b). */
  readonly configs?: readonly chain.ChainConfig[];
}

export interface NodeProofs {
  /** For `AgentLinkClient.create({proofs})`. */
  readonly platform: ProofsPlatform;
  /** For the tool layer (`coreToolClient({proofs})`). */
  readonly tools: ProofPlatformTools;
}

/** Resolves with `value` from `work`, or `undefined` after `ms`; the timer never keeps Node alive. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The proof platform over the shipped chains, or undefined when this release supports none. */
export function nodeProofs(options: NodeProofsOptions = {}): NodeProofs | undefined {
  const configs = options.configs ?? chain.autoSelectableChains();
  if (configs.length === 0) return undefined;
  const fetchFn = options.fetchFn ?? nodeRpcFetch();
  const urls = options.submitterUrls ?? SUBMITTER_DEFAULT_URLS;
  const selector = chain.createChainSelector();
  const chains: ProofChain[] = configs.map((config) => {
    const client = chain.createReadClient(config, { fetchFn });
    const state = chain.createChainState({ config, client });
    const submitter = chain.createProofSubmitter({
      state,
      submitters: urls.length === 0 ? [] : [chain.createSubmitterClient({ urls, fetchFn })],
      selector,
    });
    return Object.freeze({ config, client, state, submitter });
  });
  const readers = chains.map(({ config, client }) => ({ config, client }));
  const packs = nodeProofPacks(options);

  const platform: ProofsPlatform = Object.freeze({ kit: chain, chains, selector });

  const tools = Object.freeze<ProofPlatformTools>({
    ...packs,
    async verify(pack: Uint8Array | Readonly<Record<string, unknown>>): Promise<PackCheck> {
      const result = await chain.verifyProofPack(pack, { chains: readers });
      if (!result.valid) return { valid: false, verdict: 'failed', reason: result.reason };
      const content =
        result.content.status === 'verified' || result.content.status === 'unattributed'
          ? (result.content.payload as unknown)
          : undefined;
      return {
        valid: true,
        verdict: result.verdict,
        chain: result.chain,
        recordId: result.recordId,
        signer: result.signer,
        signerCard:
          result.signerCard === null
            ? null
            : {
                ownerEvm: result.signerCard.ownerEvm,
                ownerNostr: result.signerCard.ownerNostr,
                ownerEnc: result.signerCard.ownerEnc,
              },
        timestamp: result.timestamp,
        envelopeHash: result.envelopeHash,
        receipts: result.receipts.map((r) => ({ type: r.type, at: r.at })),
        contentVerified: result.contentVerified,
        content,
        notices: result.notices.map((n) => n.code),
      };
    },
    async account(agentId: string): Promise<AccountView | undefined> {
      const read = async (): Promise<AccountView | undefined> => {
        const payer = agentId as chain.Hex;
        const { credits, unavailable } = await chain.readCreditsAcrossChains(readers, payer);
        const answering = readers.filter((r) => !unavailable.includes(r.config.chainId));
        if (answering.length === 0) return undefined;
        const first = answering[0];
        const token = first?.config.feeTokens[0]?.symbol;
        let prices: AccountView['prices'] = [];
        if (first !== undefined && token !== undefined) {
          const quote = await chain
            .quoteFee(first.client, first.config, { feeType: 'NOTARIZE', token })
            .catch(() => undefined);
          if (quote !== undefined) {
            prices = [
              {
                action: 'notarize',
                usd: quote.usd,
                protocolUsd: quote.protocolUsd,
                integratorUsd: quote.integratorUsd,
              },
            ];
          }
        }
        return {
          credits: credits.flatMap((c) =>
            c.usd === null
              ? []
              : [{ chain: c.chain, token: c.token, amount: c.amount.toString(), usd: c.usd }],
          ),
          prices,
        };
      };
      return within(read(), ACCOUNT_BUDGET_MS);
    },
    chainIdOf(key: string) {
      return configs.find((c) => c.key === key)?.chainId;
    },
  });
  return Object.freeze({ platform, tools });
}
