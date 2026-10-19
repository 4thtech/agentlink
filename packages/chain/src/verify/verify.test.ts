// M1-4d: proof-pack verification (07 §6.2, §8; 05 §3.1, §3.3; 04 §3.1.1, §3.3; G-46, D-66, D-86).
//
// No network: every chain read goes through an injected, address-checked (branded) fetch that plays
// the Notary (`getRecord`) and, for the ERC-1271 case, the signer's account contract. The packs are
// built from the shared vectors: the record-message Record (eip712-proof) and the decrypt-payload
// and two-key envelopes (aead-envelope), copied verbatim below because this package may not read
// test-vectors/ (deps-check). The EOA signer is a fixed test scalar; viem signs the digest as an
// independent signer (test only: production code verifies through @4thtech-io/crypto).
import {
  decodeHex,
  encodeBase64url,
  encodeHex0x,
  envelopeHash,
  hashRecord,
  occV2Domain,
  recipientCommitment,
  type Envelope,
  type OccRecord,
} from '@4thtech-io/crypto';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex as ViemHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GNOSIS_CHIADO, type ChainConfig, type ChainNetwork } from '../config/index.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { composeChainConfig } from '../clients/registry.js';
import { NOTARY_CLIENT_ABI, createReadClient, getChainConfig } from '../clients/index.js';
import { ChainInputError, computeRecordId } from '../ids/index.js';
import * as packageRoot from '../index.js';
import {
  MAX_PROOF_PACK_BYTES,
  PROOF_CONTENT_FAILURES,
  PROOF_PACK_FAILURES,
  proofFailureMessage,
  verifyProofPack,
  type ProofPackResult,
  type VerifyChain,
} from './index.js';

const ZERO32 = `0x${'0'.repeat(64)}`;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const iso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

// --- vector copies -----------------------------------------------------------------------------
// vector-copies:start (verbatim from test-vectors; this package may not read that folder)

/** record-message: the fee asset address (a named constant keeps secret scanners from reading it as a key). */
const FEE_ASSET = '0x05f7cddba6070777972ad9ff9df5312872a49685';

/** record-message (eip712-proof): kind 1 MESSAGE on the Base Sepolia domain, to the commitment-basic recipient. */
const VECTOR_RECORD: OccRecord = {
  signer: '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a',
  envelopeHash: '0x38febeb3650a8e5d354bfa5493835b16012673181c3e1755aaf8b234d053ed88',
  recipientCommitment: '0xdf8769780934da646f92597340ae4efeb1a0702cba1e49b07dfd97eaab78860b',
  parentRecordId: ZERO32,
  appId: ZERO32,
  kind: 1,
  feeToken: FEE_ASSET,
  maxFee: '250000',
  nonce: '53413080818580974331135570314775698628850412394171742376625802275545193048131',
  deadline: 1760003600,
};
const VECTOR_NOTARY = '0x252d9a9c22652a8c08b12eda14d30906850542c9';
const VECTOR_DIGEST = '0x62cf8d22185e1ce6d534993e24e3e41c2f34eb7f5dc38649d153627cfe8a8802';
const VECTOR_STRUCT_HASH = '0xb48f916acb552ca670a5a112006956be55a9b28db6fd364a2705963783c6e3b5';
/** commitment-basic (eip712-proof). */
const RECIPIENT = '0xe09a6724ce75ed0badc4bb6a5ecf4f28e75ee558';
const SALT = '0xb529be83d68c21c739ecccae31d44b853b51551a9c436f57bbc617da4a287731';

/** decrypt-payload (aead-envelope): a signed text envelope; its payload is a valid `text` payload. */
const MESSAGE_ENVELOPE: Envelope = {
  v: 1,
  id: 'CWwS0akF74XyLhggaFDzZQ',
  thread: 'Jqgjx2tXGK5rxsnWiTwjtw',
  from: 'a3e7f43667d462e884d2f8b9e5c8cb3333b9ce3011ad4140c51761b42805b8ec',
  createdAt: 1760000000,
  recipients: [
    {
      kid: 'LGGnk30hbYi4K8I9JxRqQA',
      enc: 'rTtSCNB7I8OCjSBc3wgz3sBPKaWuFk0DYD6UC00fCEQ',
      wk: 'vzBBon0C41a7SelbC0JbWkET43jM9d65kIDvVBk29WE1mCB0uzsT4IwcAwI2fi5Q',
    },
    {
      kid: 'eExmdPfwCWg6bBLEtFc46g',
      enc: 'THcfW4h_YGbIPNCEOQlugejW-ZC0Dpb8SsjxjAOSuWU',
      wk: '-DG2iVV68TQkG1dwshC8wrcxz6ReFz3nplx1oY-M9Bo38tLDUz--LYLwOawenNuD',
    },
    {
      kid: 'MW3kZCPdPhvhhCYviirPTQ',
      enc: 'lRIqmRE-cNcDIg0efmKJ24JTa-53Nb3C1cBFMfPqpG4',
      wk: 'enXaB7t8lA1OXHGHXCCorZdvxr56H7iGRa_P6FGauxsVqZfvgJzDryCmTGN3F4_5',
    },
    {
      kid: '54EhDMUO-6AUwd1daj9E_w',
      enc: '6jSVjm-FZj7QdQk8Vu2XAyzTDq3NrhwNpN2_au1UIiI',
      wk: 'cqpdsdxAuds7MMc6Vl2s1Cd_idqcbw-RfLbFEmvAOmGdiPvsxOvRYvX4uMb0Zn21',
    },
  ],
  aead: {
    alg: 'A256GCM-KC',
    iv: 'eIyG5R7rczoln9qC',
    kc: 'qxXFf1fkpoj09rhRjBmEnHIuDgnLDjzxEO94D48EFzk',
    ct: 'DhTMLvL8fTFxHsMMuOti-1sDzhTAdrD0Y7vdpw31rODqZe2rhCmKeD2VhH10wgFofsOkYe4VKaV6VjMTkjByMQKZXh0Vd6w11x_xgOMlVY3x7eL6vBbYseFC9bfJIrLMymr1-C9MBKh8Hrwk',
  },
  sig: '59d5ad41b878708e9e4120ab788c5c5b6c9f16b860521e9e33ffa2c183253d7fa3a321e95d6781c26a95f2f63a78d092c68061419cbf28a22cc9ddc318b26b80',
};
/** decrypt-payload: the envelope's CEK (hex). */
const MESSAGE_CEK_HEX = 'fdeccc1473c6f8d31340c677f43272e983bcec8a9b309441d48d55d1a2d177b4';
/** envelope-hash / sign: sha256(JCS(MESSAGE_ENVELOPE without sig)). */
const MESSAGE_ENVELOPE_HASH = '0x080e039b1c57f464eb494db2d9ee0f883a3e0a5bfc697ccb69774d5a79245938';

/** decrypt-two-key-committed-cek: a two-key ciphertext (G-46); its plaintext is not a payload. */
const TWO_WRAP_ENVELOPE: Envelope = {
  v: 1,
  id: 'FhWqVpLUCH967CDK_FwHkQ',
  thread: 'Jqgjx2tXGK5rxsnWiTwjtw',
  from: 'a3e7f43667d462e884d2f8b9e5c8cb3333b9ce3011ad4140c51761b42805b8ec',
  createdAt: 1760000200,
  recipients: [
    {
      kid: 'LGGnk30hbYi4K8I9JxRqQA',
      enc: '8Oe-GnrRXxYTwx4E-uehoo5tqcqQ_7uYCVR2-rIbY0w',
      wk: 'aNS5SygmxngidrPcrB7Wvmx3vo3vrV9O0aQS6G_P30Ea1Kv2noLPKBYznvOeZwLg',
    },
    {
      kid: 'eExmdPfwCWg6bBLEtFc46g',
      enc: 'HnNlClrr_eefFsjaSL1QwFHR7UKeanEV5jG1WvG1Bh0',
      wk: 'dCkGXRZFPeKyJWo33iOLBs6rPioVQKhny4vQpxf3odwL3hsV60HAlgcKZ9i7qwdq',
    },
    {
      kid: 'MW3kZCPdPhvhhCYviirPTQ',
      enc: 'QnAamFUqtvfZC7rEab8-L6JDrL_rpoHqkX93mDBFJhg',
      wk: 'ZSl1MLVc3RN4VT7Cemv9FT_VntjJTjOv7TQWFgEjHOzrHtqLa7lDt7SUAyguksv7',
    },
    {
      kid: '54EhDMUO-6AUwd1daj9E_w',
      enc: 'Wwjqu14no5pBJ5fDXWp-pkXxdgqn539p-YakvFo7UiA',
      wk: 'MeLKdGMWhfw0DkeOzDrlYRLR-4eoVgsQHXEN_F0VkRP5qqjlbrhF2jgDS4zRRAlm',
    },
  ],
  aead: {
    alg: 'A256GCM-KC',
    iv: 'bLwpW_Un3gb15jn5',
    kc: 'RqWyZsFICSNPcxNAV8HmOiIrOeKaVnwuLCfsGB-5Z_w',
    ct: 'X3_hWK88fHOyyozW8E2vKaezGV6vtJDohUKG4hPZYw-1zPzqN3ImuEeOBwfl_Z2f',
  },
  sig: '05a79d03cb7ac4fffac5978e350dc290e1f98c18fc19b1b6e2274ce75669555d196168a66ac0e3bb56b766043c0c4f2f4dacc107cede59c8f28797bf6967330b',
};
/** decrypt-two-key-committed-cek: the CEK `kc` commits to. */
const TWO_WRAP_COMMITTED_CEK_HEX =
  'c2567704b99931c494cc66d910875036522859f33ef9e9412d3969724bbd043e';
/** decrypt-reject-two-key-other-cek: the other CEK, which AES-GCM accepts but `kc` does not. */
const TWO_WRAP_OTHER_CEK_HEX = '777ccec60275ab2ed1035b9270c51f58f8f773099933cc420734018fad1a736c';

// vector-copies:end

// --- card proof of possession (04 §2.9, 07 §8; M1-4d-d, D-102) -----------------------------------
// BIP-340 signatures by the vector envelope's sender key (the aead-envelope `sign` case's secret, so
// that the card's `agentNostr` is the envelope's `from`), made with @4thtech-io/crypto's bip340Sign
// and an all-zero auxRand outside this package: this package may not import a signing entry point
// (deps-check). Each is over taggedHash(tag, sha256(JCS(card))) for the card named.

/** `cardPop` for cardFor(): tag `agentlink/card-pop/v1`. Valid. */
const CARD_POP =
  '3b09c98edec5b87c9feb1ad4e6b77ee0c37506219f10f3da3abe5c4fadeaaca03fdbc5667e0a69f0d002ff0438b2230e692b9244f486540e3a1abcff0dc7559a';
/** The same key and tag over cardFor({ keyEpoch: 1 }): another key epoch's card. */
const CARD_POP_EPOCH_1 =
  '5082289ac55972d5fd27dcabbf4892967633f2b7de78e46dcf3bdb175ad4871c1b9f55054e0207e8eeb81035cf09c2ccc7a9fdf67405710a483f0738538b93e1';
/** Over cardFor({ ownerEvm: OTHER_OWNER }): the same agent keys under another owner. */
const CARD_POP_OTHER_OWNER =
  '829eaceaa677abbac15bf915eda5c798d3c89bf0100b2a8c4a2502832e135be11652ec8de4b57f550f89798d416aa50701f98d2681d2d31a9dd7997597f8202c';
/** Over cardFor({ nameHash: 0x8a… }): another display name. */
const CARD_POP_OTHER_NAME =
  'c6994cdd84ee8781b3bfa2d0c7663caefb55652056dd41fb72f9362e432018d74fe7dfd57ef7f258f8ce177dda014e040b0b82aa0fdba42a75ab8792ed4accf1';
/** Over cardFor()'s hash under the envelope tag `agentlink/envelope/v1`. */
const CARD_POP_ENVELOPE_TAG =
  '056c3b75f2babf1571bd57bea147c027787f81d6121a5f12cb60ff294cb709576bec0ffdeb72ee22efd6dce873d7bb4b63d14bf51199ed2d9c10069968763cef';
/** Over cardFor()'s hash under the owner-action tag `agentlink/owner-action/v1`. */
const CARD_POP_OWNER_ACTION_TAG =
  '31a3aebe542d420e270249238769718484a385e7e862188311f20ab6165cce7692acd41c868c171530af27fa4942273e1b993bcb939ef057c33dd7f80c115c70';
/** Over cardFor()'s bare sha256(JCS(card)), no tag. */
const CARD_POP_UNTAGGED =
  'fd9666fcb397941d502e0b0be6ec7282e9fdc641e9d7da4e98ded55b05f2564034fac68291ce1f8360d85ce3d1f9fe4da166a7816e2afe03bedcf186eab7ef9a';
/** The right tag and card, signed by another key (scalar 0xabab…ab), not the card's agentNostr. */
const CARD_POP_WRONG_SIGNER =
  'cc0883a1cd172400ffe00fb3defda911b047b68dfe1cc2f781122a589c62bc88707b7f2695bfd34b526966191fce572a577e8b7c0780cfbf48bcf47416406ca0';

// --- test signers (scanner-safe repeated-byte scalars; test only) --------------------------------

const SIGNER_SCALAR = `0x${'11'.repeat(32)}` as ViemHex;
const OTHER_SCALAR = `0x${'22'.repeat(32)}` as ViemHex;
const SIGNER = privateKeyToAccount(SIGNER_SCALAR);
const OTHER = privateKeyToAccount(OTHER_SCALAR);
const SIGNER_EVM = SIGNER.address.toLowerCase();
/** The signer agent's owner: it signs the agent card (`cardSig`, 04 §2.4). */
const OWNER_SCALAR = `0x${'33'.repeat(32)}` as ViemHex;
const OWNER = privateKeyToAccount(OWNER_SCALAR);
const OWNER_EVM = OWNER.address.toLowerCase();
/** Another owner (M1-4d-b: a card under a different owner). */
const OTHER_OWNER = privateKeyToAccount(`0x${'44'.repeat(32)}` as ViemHex);

const NOTARIZED_AT = 1760000100;
const DELIVERED_AT = 1760000200;
const TX_HASH = `0x${'cd'.repeat(32)}`;
const b64 = (hex: string): string => encodeBase64url(decodeHex(hex));

// --- agent cards (04 §2.4; M1-4d-b) ------------------------------------------------------------------

type CardJson = {
  version: number;
  agentEvm: string;
  agentNostr: string;
  agentEnc: string;
  ownerEvm: string;
  ownerNostr: string;
  ownerEnc: string;
  nameHash: string;
  relaysHash: string;
  issuedAt: number;
  expiresAt: number;
  keyEpoch: number;
};

/** The record signer's card: its `agentNostr` is the vector envelope's `from`. */
function cardFor(over: Partial<CardJson> = {}): CardJson {
  return {
    version: 1,
    agentEvm: SIGNER_EVM,
    agentNostr: `0x${MESSAGE_ENVELOPE.from}`,
    agentEnc: `0x${'55'.repeat(32)}`,
    ownerEvm: OWNER_EVM,
    ownerNostr: `0x${'66'.repeat(32)}`,
    ownerEnc: `0x${'77'.repeat(32)}`,
    nameHash: `0x${'88'.repeat(32)}`,
    relaysHash: `0x${'99'.repeat(32)}`,
    issuedAt: 1759000000,
    expiresAt: 0,
    keyEpoch: 0,
    ...over,
  };
}

const t = (name: string, type: string) => ({ name, type });
/** The AgentCard EIP-712 type (04 §2.4), written out here so viem signs it as an independent signer. */
const CARD_TYPES = {
  AgentCard: [
    t('version', 'uint8'),
    t('agentEvm', 'address'),
    t('agentNostr', 'bytes32'),
    t('agentEnc', 'bytes32'),
    t('ownerEvm', 'address'),
    t('ownerNostr', 'bytes32'),
    t('ownerEnc', 'bytes32'),
    t('nameHash', 'bytes32'),
    t('relaysHash', 'bytes32'),
    t('issuedAt', 'uint64'),
    t('expiresAt', 'uint64'),
    t('keyEpoch', 'uint32'),
  ],
} as const;

/** `cardSig`: an EIP-712 signature over the card under the chain-agnostic card domain. */
async function signCard(card: CardJson, account: typeof OWNER = OWNER): Promise<string> {
  return account.signTypedData({
    domain: { name: 'OCC AgentCard', version: '1' },
    types: CARD_TYPES,
    primaryType: 'AgentCard',
    message: card as never,
  });
}

// --- chains ---------------------------------------------------------------------------------------

const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
const ERC1271_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
const ERC1271_MAGIC = '0x1626ba7e';
/** A user RPC URL whose path stands for a provider secret: it must never reach a result. */
const SECRET_RPC_URL = 'https://rpc.example-provider.com/v1/rpcpathmarker';

function base(): ChainConfig {
  return getChainConfig(84532) as ChainConfig;
}

/** Chiado is not deployed yet (M1-3j): the same CREATE3 addresses, native xDAI as the fee token. */
function chiado(): ChainConfig {
  const b = loadOccV2Contracts(84532) as OccV2Contracts;
  const contracts: OccV2Contracts = {
    ...b,
    chainId: 10200,
    feeTokens: [
      {
        address: `0x${'0'.repeat(40)}`,
        decimals: 18,
        eip3009: false,
        native: true,
        symbol: 'NATIVE',
      },
    ],
    depositWithAuthorization: false,
  };
  return composeChainConfig(clone(GNOSIS_CHIADO) as ChainNetwork, contracts);
}

interface RecordState {
  signer: string;
  timestamp: bigint;
  kind: number;
  receiptFlags: number;
  envelopeHash: string;
  recipientCommitment: string;
  recordStructHash: string;
  receiptAt: readonly [bigint, bigint, bigint, bigint];
}

interface FakeChain {
  /** getRecord answers by record ID; a missing ID returns the empty struct, as the contract does. */
  records?: Map<string, RecordState>;
  /** getRecord at the `finalized` tag; default: the same as `records`. */
  finalizedRecords?: Map<string, RecordState>;
  /** The ERC-1271 account answers with these raw bytes (an empty or short answer). */
  erc1271Raw?: string;
  /** eth_getCode by address (lowercase); default empty. */
  code?: Map<string, string>;
  /** The ERC-1271 account's answer for (hash, signature); default: not valid. */
  erc1271?: (hash: string, signature: string) => string;
  /** The ERC-1271 call reverts. */
  erc1271Reverts?: boolean;
  down?: boolean;
}

type RpcCall = { method: string; to?: string; fn?: string; tag?: string };

const EMPTY_STATE: RecordState = {
  signer: `0x${'0'.repeat(40)}`,
  timestamp: 0n,
  kind: 0,
  receiptFlags: 0,
  envelopeHash: ZERO32,
  recipientCommitment: ZERO32,
  recordStructHash: ZERO32,
  receiptAt: [0n, 0n, 0n, 0n],
};

function chainFetch(config: ChainConfig, chain: FakeChain) {
  const calls: RpcCall[] = [];
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const answer = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (chain.down === true) return new Response('down at rpcpathmarker', { status: 503 });
    if (body.method === 'eth_chainId') return answer(`0x${config.chainId.toString(16)}`);
    if (body.method === 'eth_getCode') {
      const [address] = body.params as [string];
      calls.push({ method: body.method, to: address.toLowerCase() });
      return answer(chain.code?.get(address.toLowerCase()) ?? '0x');
    }
    if (body.method !== 'eth_call') throw new Error(`unexpected ${body.method}`);
    const tx = body.params[0] as { to: string; data: ViemHex };
    const to = tx.to.toLowerCase();
    if (to === config.contracts.notary) {
      const { functionName, args } = decodeFunctionData({ abi: NOTARY_CLIENT_ABI, data: tx.data });
      const tag = String(body.params[1]);
      calls.push({ method: body.method, to, fn: functionName, tag });
      if (functionName !== 'getRecord') throw new Error(`unexpected ${functionName}`);
      const [recordId] = args as unknown as [string];
      const source =
        tag === 'finalized' ? (chain.finalizedRecords ?? chain.records) : chain.records;
      const state = source?.get(recordId) ?? EMPTY_STATE;
      return answer(
        encodeFunctionResult({
          abi: NOTARY_CLIENT_ABI,
          functionName: 'getRecord',
          result: state,
        } as Parameters<typeof encodeFunctionResult>[0]),
      );
    }
    const { functionName, args } = decodeFunctionData({ abi: ERC1271_ABI, data: tx.data });
    calls.push({ method: body.method, to, fn: functionName });
    if (chain.erc1271Reverts === true) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: 3, message: 'execution reverted', data: '0x' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (chain.erc1271Raw !== undefined) return answer(chain.erc1271Raw);
    const [hash, signature] = args as unknown as [string, string];
    const magic = chain.erc1271?.(hash, signature) ?? '0xffffffff';
    return answer(
      encodeFunctionResult({
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        result: magic as ViemHex,
      }),
    );
  };
  const fetchFn = vi.fn(impl) as Mock<typeof impl>;
  Object.defineProperty(fetchFn, ADDRESS_CHECKED, { value: true });
  return { fetchFn, calls };
}

function chainFor(config: ChainConfig, chain: FakeChain) {
  const { fetchFn, calls } = chainFetch(config, chain);
  const client = createReadClient(config, { fetchFn, retryCount: 0, rpcUrls: [SECRET_RPC_URL] });
  return { reader: { config, client } satisfies VerifyChain, fetchFn, calls };
}

// --- pack fixtures --------------------------------------------------------------------------------

interface Fixture {
  pack: Record<string, unknown>;
  state: RecordState;
  recordId: string;
  digest: string;
}

interface FixtureOptions {
  envelope?: Envelope;
  kind?: number;
  /** Sign with another account (a wrong signer). */
  signWith?: typeof SIGNER;
  /** Sign under another domain. */
  domain?: { chainId: number; notary: string };
  selfNote?: boolean;
  /** The signer's card in the pack: a valid owner-signed card by default; `false` for none. */
  card?: false | { agentCard: CardJson; cardSig: string };
  /** Proof of possession next to the card (M1-4d-d): each field is added only when given. */
  pop?: { cardAgentSig?: string; cardPop?: string };
}

async function eoaFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const config = base();
  const notary = config.contracts.notary;
  const envelope = options.envelope ?? MESSAGE_ENVELOPE;
  const envHash = encodeHex0x(envelopeHash(envelope));
  const commitment =
    options.selfNote === true ? ZERO32 : encodeHex0x(recipientCommitment(RECIPIENT, SALT));
  const record: OccRecord = {
    ...VECTOR_RECORD,
    signer: SIGNER_EVM,
    envelopeHash: envHash,
    recipientCommitment: commitment,
    kind: options.kind ?? 1,
  };
  const hashes = hashRecord(occV2Domain(config.chainId, notary), record);
  const signDomain = options.domain ?? { chainId: config.chainId, notary };
  const signed = hashRecord(occV2Domain(signDomain.chainId, signDomain.notary), record);
  const signature = await (options.signWith ?? SIGNER).sign({
    hash: encodeHex0x(signed.digest) as ViemHex,
  });
  const recordId = computeRecordId(config.chainId, notary, SIGNER_EVM, BigInt(record.nonce));
  let signer: Record<string, unknown> = { evm: SIGNER_EVM };
  if (options.card !== false) {
    const agentCard = options.card?.agentCard ?? cardFor();
    const cardSig = options.card?.cardSig ?? (await signCard(agentCard));
    signer = { evm: SIGNER_EVM, agentCard, cardSig };
  }
  if (options.pop?.cardAgentSig !== undefined) signer.cardAgentSig = options.pop.cardAgentSig;
  if (options.pop?.cardPop !== undefined) signer.cardPop = options.pop.cardPop;
  const state: RecordState = {
    signer: SIGNER_EVM,
    timestamp: BigInt(NOTARIZED_AT),
    kind: record.kind,
    receiptFlags: options.selfNote === true ? 0 : 1,
    envelopeHash: envHash,
    recipientCommitment: commitment,
    recordStructHash: encodeHex0x(hashes.structHash),
    receiptAt: options.selfNote === true ? [0n, 0n, 0n, 0n] : [BigInt(DELIVERED_AT), 0n, 0n, 0n],
  };
  const pack: Record<string, unknown> = {
    type: 'agentlink.proof',
    version: 1,
    chainId: config.chainId,
    notary,
    recordId,
    record,
    signature,
    signer,
    envelopeHash: envHash,
    envelope,
    disclosure: {
      contentKey: b64(
        envelope === TWO_WRAP_ENVELOPE ? TWO_WRAP_COMMITTED_CEK_HEX : MESSAGE_CEK_HEX,
      ),
    },
    ownerApproval: null,
    exportedAt: '2025-10-10T00:00:00Z',
    receipts: [],
  };
  if (options.selfNote !== true) {
    pack.recipient = { evm: RECIPIENT, salt: SALT };
    pack.receipts = [
      { type: 'DELIVERED', signer: RECIPIENT, txHash: TX_HASH, at: iso(DELIVERED_AT) },
    ];
  }
  return { pack, state, recordId, digest: encodeHex0x(hashes.digest) };
}

/** The vector Record as signed by an ERC-1271 account (its digest is the vector's). */
function erc1271Fixture(signature = `0x${'ab'.repeat(80)}`): Fixture {
  const recordId = computeRecordId(
    84532,
    VECTOR_NOTARY,
    VECTOR_RECORD.signer,
    BigInt(VECTOR_RECORD.nonce),
  );
  const state: RecordState = {
    signer: VECTOR_RECORD.signer,
    timestamp: BigInt(NOTARIZED_AT),
    kind: 1,
    receiptFlags: 0,
    envelopeHash: VECTOR_RECORD.envelopeHash,
    recipientCommitment: VECTOR_RECORD.recipientCommitment,
    recordStructHash: VECTOR_STRUCT_HASH,
    receiptAt: [0n, 0n, 0n, 0n],
  };
  const pack = {
    type: 'agentlink.proof',
    version: 1,
    chainId: 84532,
    notary: VECTOR_NOTARY,
    recordId,
    record: { ...VECTOR_RECORD },
    signature,
    signer: { evm: VECTOR_RECORD.signer },
    envelopeHash: VECTOR_RECORD.envelopeHash,
    receipts: [],
    disclosure: null,
    ownerApproval: null,
    exportedAt: '2025-10-10T00:00:00Z',
  };
  return { pack, state, recordId, digest: VECTOR_DIGEST };
}

function chainWith(f: Fixture, extra: FakeChain = {}) {
  // The vector Record's domain names its own Notary: play Base Sepolia with that Notary shipped.
  const config = f.pack.notary === VECTOR_NOTARY ? vectorChain() : base();
  return chainFor(config, { records: new Map([[f.recordId, f.state]]), ...extra });
}

/** Base Sepolia with the record-message vector's Notary as the shipped one (the vector's domain). */
function vectorChain(): ChainConfig {
  const b = base();
  return Object.freeze({
    ...b,
    contracts: Object.freeze({ ...b.contracts, notary: VECTOR_NOTARY }),
  });
}

async function verify(pack: unknown, chains: VerifyChain[]): Promise<ProofPackResult> {
  return verifyProofPack(
    typeof pack === 'string' || pack instanceof Uint8Array ? pack : JSON.stringify(pack),
    {
      chains,
    },
  );
}

function expectFailure(result: ProofPackResult, reason: string): void {
  expect(result.verdict).toBe('failed');
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.reason).toBe(reason);
  expect(result.message).toBe(proofFailureMessage(reason as never));
}

/** No RPC URL, no pack field value and no server text reaches a result. */
function expectNoEcho(result: ProofPackResult, ...markers: string[]): void {
  const text = JSON.stringify(result);
  for (const marker of ['rpcpathmarker', 'example-provider', ...markers]) {
    expect(text).not.toContain(marker);
  }
}

// --- tests ----------------------------------------------------------------------------------------

describe('verifyProofPack: valid packs (07 §8)', () => {
  it('verifies an EOA-signed pack: record, recipient, receipts, card and the disclosed content', async () => {
    const f = await eoaFixture();
    const { reader, calls } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(Object.keys(result)[0]).toBe('verdict');
    // A card without its proof of possession (M1-4d-d): the content opens but is not attributed
    // (card_pop_missing), and the verdict is record_only.
    expect(result).toEqual({
      verdict: 'record_only',
      valid: true,
      chainId: 84532,
      chain: 'base-sepolia',
      notary: base().contracts.notary,
      recordId: f.recordId,
      signer: SIGNER_EVM,
      signerType: 'account',
      signerCard: cardFor(),
      kind: 1,
      timestamp: iso(NOTARIZED_AT),
      finality: 'finalized',
      envelopeHash: MESSAGE_ENVELOPE_HASH,
      recipient: { evm: RECIPIENT },
      receipts: [{ type: 'DELIVERED', at: iso(DELIVERED_AT) }],
      contentVerified: false,
      content: {
        status: 'unattributed',
        reason: 'card_pop_missing',
        message: proofFailureMessage('card_pop_missing' as never),
        payload: {
          type: 'text',
          body: 'Hello from the AgentLink test vectors ✓',
          files: [],
          replyTo: null,
        },
        sender: MESSAGE_ENVELOPE.from,
      },
    });
    // One getRecord at the configured Notary, at the finalized block; an EOA needs no code read.
    expect(calls).toEqual([
      { method: 'eth_call', to: base().contracts.notary, fn: 'getRecord', tag: 'finalized' },
    ]);
    expectNoEcho(result);
  });

  it('takes the pack as JSON text, as UTF-8 bytes or as a parsed object', async () => {
    const f = await eoaFixture();
    const text = JSON.stringify(f.pack);
    for (const input of [text, new TextEncoder().encode(text), JSON.parse(text) as object]) {
      const { reader } = chainWith(f);
      const result = await verifyProofPack(input, { chains: [reader] });
      expect(result.valid).toBe(true);
    }
  });

  it('verifies a pack without a disclosed key: the record stands, no content is claimed', async () => {
    const f = await eoaFixture();
    delete f.pack.envelope;
    f.pack.disclosure = null;
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.contentVerified).toBe(false);
    expect(result.content).toEqual({ status: 'not_disclosed' });
    // A record without checked content is never a full pass (IR-M1-4d-1 M-2).
    expect(result.verdict).toBe('record_only');
  });

  it('verifies a self-note (no recipient, no receipts)', async () => {
    const f = await eoaFixture({ selfNote: true });
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.recipient).toBeNull();
    expect(result.receipts).toEqual([]);
  });

  it('reports the receipts the chain holds, not only the ones the pack lists', async () => {
    const f = await eoaFixture();
    f.state.receiptAt = [BigInt(DELIVERED_AT), BigInt(DELIVERED_AT + 60), 0n, 0n];
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.receipts).toEqual([
      { type: 'DELIVERED', at: iso(DELIVERED_AT) },
      { type: 'OPENED', at: iso(DELIVERED_AT + 60) },
    ]);
  });

  it('verifies the vector Record signed by an ERC-1271 account (eth_call isValidSignature)', async () => {
    const f = erc1271Fixture();
    const seen: string[] = [];
    const { reader, calls } = chainWith(f, {
      code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]),
      erc1271: (hash, signature) => {
        seen.push(hash);
        return hash === VECTOR_DIGEST && signature === f.pack.signature
          ? ERC1271_MAGIC
          : '0xffffffff';
      },
    });
    const result = await verify(f.pack, [reader]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.signerType).toBe('contract');
    expect(result.recipient).toBeNull();
    expect(seen).toEqual([VECTOR_DIGEST]);
    expect(calls.map((c) => c.fn ?? c.method)).toEqual([
      'getRecord',
      'eth_getCode',
      'isValidSignature',
    ]);
  });

  it('accepts a 65-byte ERC-1271 signature that does not recover to the account (OZ SignatureChecker order)', async () => {
    const sig = await OTHER.sign({ hash: VECTOR_DIGEST as ViemHex });
    const f = erc1271Fixture(sig);
    const { reader } = chainWith(f, {
      code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]),
      erc1271: (hash) => (hash === VECTOR_DIGEST ? ERC1271_MAGIC : '0xffffffff'),
    });
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.signerType).toBe('contract');
  });
});

describe('verifyProofPack: each tamper fails with its own fixed code', () => {
  type Case = {
    name: string;
    options?: FixtureOptions;
    mutate?: (f: Fixture) => void;
    chain?: (f: Fixture) => FakeChain;
    reason: string;
  };
  const cases: Case[] = [
    {
      name: 'signature: one byte changed',
      mutate: (f) => {
        const s = f.pack.signature as string;
        f.pack.signature = `${s.slice(0, 10)}${s[10] === '0' ? '1' : '0'}${s.slice(11)}`;
      },
      reason: 'signature_invalid',
    },
    {
      name: 'wrong signer: signed by another key',
      options: { signWith: OTHER },
      reason: 'signature_invalid',
    },
    {
      name: 'domain: signed for another chain ID',
      options: { domain: { chainId: 10200, notary: VECTOR_NOTARY } },
      reason: 'signature_invalid',
    },
    {
      name: 'domain: signed for another Notary',
      options: { domain: { chainId: 84532, notary: `0x${'5a'.repeat(20)}` } },
      reason: 'signature_invalid',
    },
    {
      name: 'digest: a signed field changed (maxFee)',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).maxFee = '1';
      },
      reason: 'record_mismatch',
    },
    {
      name: 'digest: parentRecordId changed',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).parentRecordId = `0x${'01'.repeat(32)}`;
      },
      reason: 'record_mismatch',
    },
    {
      name: 'kind: the record claims another kind than the chain',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).kind = 2;
      },
      reason: 'kind_mismatch',
    },
    {
      name: 'kind: outside the fixed kinds (D-86)',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).kind = 7;
      },
      reason: 'invalid_kind',
    },
    {
      name: 'envelope hash: pack and record name another hash than the chain',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).envelopeHash = `0x${'0e'.repeat(32)}`;
        f.pack.envelopeHash = `0x${'0e'.repeat(32)}`;
        delete f.pack.envelope;
        f.pack.disclosure = null;
      },
      reason: 'envelope_hash_mismatch',
    },
    {
      name: 'chain: a chain this release does not support',
      mutate: (f) => {
        f.pack.chainId = 1;
      },
      reason: 'unsupported_chain',
    },
    {
      name: 'chain: another supported chain (the record ID binds the chain)',
      mutate: (f) => {
        f.pack.chainId = 10200;
      },
      reason: 'record_id_mismatch',
    },
    {
      name: 'contract address: another Notary than the shipped one',
      mutate: (f) => {
        f.pack.notary = `0x${'5a'.repeat(20)}`;
      },
      reason: 'notary_mismatch',
    },
    {
      name: 'record ID: not the one the Notary computes',
      mutate: (f) => {
        f.pack.recordId = `0x${'7e'.repeat(32)}`;
      },
      reason: 'record_id_mismatch',
    },
    {
      name: 'record ID: the signer changed (and the pack signer with it)',
      mutate: (f) => {
        (f.pack.record as Mutable<OccRecord>).signer = OTHER.address.toLowerCase();
        f.pack.signer = { evm: OTHER.address.toLowerCase() };
      },
      reason: 'record_id_mismatch',
    },
    {
      name: 'record not on the chain',
      chain: () => ({ records: new Map() }),
      reason: 'record_not_found',
    },
    {
      name: 'the chain names another signer (a lying RPC)',
      chain: (f) => ({
        records: new Map([[f.recordId, { ...f.state, signer: `0x${'5b'.repeat(20)}` }]]),
      }),
      reason: 'signer_mismatch',
    },
    {
      name: 'the chain holds another recipient commitment',
      chain: (f) => ({
        records: new Map([
          [f.recordId, { ...f.state, recipientCommitment: `0x${'5c'.repeat(32)}` }],
        ]),
      }),
      reason: 'commitment_mismatch',
    },
    {
      name: 'recipient: a salt that does not open the commitment',
      mutate: (f) => {
        f.pack.recipient = { evm: RECIPIENT, salt: `0x${'5d'.repeat(32)}` };
      },
      reason: 'recipient_mismatch',
    },
    {
      name: 'missing receipt: the pack lists OPENED, the chain has none',
      mutate: (f) => {
        (f.pack.receipts as unknown[]).push({
          type: 'OPENED',
          signer: RECIPIENT,
          txHash: TX_HASH,
          at: iso(DELIVERED_AT),
        });
      },
      reason: 'receipt_not_on_chain',
    },
    {
      name: 'receipt time differs from the chain',
      mutate: (f) => {
        (f.pack.receipts as { at: string }[])[0]!.at = iso(DELIVERED_AT + 1);
      },
      reason: 'receipt_mismatch',
    },
    {
      name: 'the chain cannot be reached',
      chain: () => ({ down: true }),
      reason: 'chain_unavailable',
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const f = await eoaFixture(c.options);
      c.mutate?.(f);
      const { reader } = c.chain ? chainFor(base(), c.chain(f)) : chainWith(f);
      const second = chainFor(chiado(), { records: new Map([[f.recordId, f.state]]) });
      const result = await verify(f.pack, [reader, second.reader]);
      expectFailure(result, c.reason);
      expectNoEcho(result, f.recordId.slice(2), SIGNER_EVM.slice(2));
    });
  }

  it('an ERC-1271 account that does not accept the signature', async () => {
    const f = erc1271Fixture();
    const { reader } = chainWith(f, { code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]) });
    expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
  });

  it('an ERC-1271 call that reverts', async () => {
    const f = erc1271Fixture();
    const { reader } = chainWith(f, {
      code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]),
      erc1271Reverts: true,
    });
    expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
  });

  it('a non-ECDSA signature from a signer with no code', async () => {
    const f = erc1271Fixture();
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
  });

  it('an ERC-1271 account that answers with no data or less than a word (L-1)', async () => {
    for (const raw of ['0x', ERC1271_MAGIC]) {
      const f = erc1271Fixture();
      const { reader } = chainWith(f, {
        code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]),
        erc1271Raw: raw,
      });
      expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
    }
  });

  it('a record time no timestamp can hold (uint64 max) is malformed_record (L-1)', async () => {
    const f = await eoaFixture();
    f.state.timestamp = 2n ** 64n - 1n;
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'malformed_record');
  });
});

describe('verifyProofPack: 65-byte smart-account signatures (IR-M1-4d-1 L-2)', () => {
  /** A Safe-style 65-byte signature: v = 0 and a high s, never a canonical ECDSA form. */
  const SAFE_STYLE = `0x${'0a'.repeat(32)}${'ff'.repeat(32)}00`;

  it('goes to ERC-1271 and verifies when the account accepts it', async () => {
    const f = erc1271Fixture(SAFE_STYLE);
    const { reader } = chainWith(f, {
      code: new Map([[VECTOR_RECORD.signer, '0x6080604052']]),
      erc1271: (hash, signature) =>
        hash === VECTOR_DIGEST && signature === SAFE_STYLE ? ERC1271_MAGIC : '0xffffffff',
    });
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.signerType).toBe('contract');
  });

  it('is refused for a signer with no code (the EOA path requires the canonical form)', async () => {
    const f = erc1271Fixture(SAFE_STYLE);
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
  });

  it('an EOA signature in its high-s twin is refused (canonical form on the ECDSA path)', async () => {
    const f = await eoaFixture();
    const sig = f.pack.signature as string;
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = (n - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, '0');
    const v = sig.endsWith('1b') ? '1c' : '1b';
    f.pack.signature = `${sig.slice(0, 66)}${high}${v}`;
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'signature_invalid');
  });

  it('still refuses a 65-byte signature that is not lowercase hex', async () => {
    const f = erc1271Fixture(SAFE_STYLE.replace('0a', '0A'));
    const { reader, fetchFn } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'malformed_pack');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('verifyProofPack: finality (IR-M1-4d-1 M-3)', () => {
  it('reports latest for a record that is not finalized yet, after trying finalized first', async () => {
    const f = await eoaFixture();
    const { reader, calls } = chainWith(f, { finalizedRecords: new Map() });
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.finality).toBe('latest');
    expect(calls.map((c) => c.tag)).toEqual(['finalized', 'latest']);
  });

  it('a receipt newer than the finalized block verifies at latest (IR-M1-4d-2 R2-M-1)', async () => {
    const f = await eoaFixture();
    const finalState = { ...f.state, receiptAt: [0n, 0n, 0n, 0n] as const };
    const { reader, calls } = chainWith(f, {
      finalizedRecords: new Map([[f.recordId, finalState]]),
    });
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.finality).toBe('latest');
    expect(result.valid && result.receipts).toEqual([{ type: 'DELIVERED', at: iso(DELIVERED_AT) }]);
    expect(calls.map((c) => c.tag)).toEqual(['finalized', 'latest']);
  });

  it('a receipt missing at both blocks still fails receipt_not_on_chain', async () => {
    const f = await eoaFixture();
    const bare = { ...f.state, receiptAt: [0n, 0n, 0n, 0n] as const };
    const { reader, calls } = chainFor(base(), {
      records: new Map([[f.recordId, bare]]),
    });
    expectFailure(await verify(f.pack, [reader]), 'receipt_not_on_chain');
    expect(calls.map((c) => c.tag)).toEqual(['finalized', 'latest']);
  });

  it('reads latest only on a chain without the finalized tag', async () => {
    const f = await eoaFixture();
    const config = Object.freeze({ ...base(), finalizedTag: false });
    const { reader, calls } = chainFor(config, { records: new Map([[f.recordId, f.state]]) });
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.finality).toBe('latest');
    expect(calls.map((c) => c.tag)).toEqual(['latest']);
  });

  it('a record found at neither block is record_not_found', async () => {
    const f = await eoaFixture();
    const { reader, calls } = chainFor(base(), {});
    expectFailure(await verify(f.pack, [reader]), 'record_not_found');
    expect(calls.map((c) => c.tag)).toEqual(['finalized', 'latest']);
  });
});

describe('verifyProofPack: disclosed content key, in the 07 §8 order (G-46, D-66)', () => {
  it('a disclosure without the envelope rejects the pack', async () => {
    const f = await eoaFixture();
    delete f.pack.envelope;
    const { reader, fetchFn } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'envelope_missing');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a 31-byte or a 33-byte content key rejects the pack', async () => {
    for (const hex of [MESSAGE_CEK_HEX.slice(2), `${MESSAGE_CEK_HEX}00`]) {
      const f = await eoaFixture();
      f.pack.disclosure = { contentKey: b64(hex) };
      const { reader, fetchFn } = chainWith(f);
      expectFailure(await verify(f.pack, [reader]), 'content_key_invalid');
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  type ContentCase = {
    name: string;
    options?: FixtureOptions;
    mutate: (f: Fixture) => void;
    reason: string;
  };
  const contentCases: ContentCase[] = [
    {
      name: 'step 2: an envelope that does not hash to the recorded value',
      mutate: (f) => {
        const env = clone(MESSAGE_ENVELOPE) as Mutable<Envelope>;
        env.createdAt += 1;
        f.pack.envelope = env;
      },
      reason: 'envelope_hash_mismatch',
    },
    {
      name: 'step 3: an envelope whose sig does not verify (sig is outside the hash)',
      mutate: (f) => {
        const env = clone(MESSAGE_ENVELOPE) as Mutable<Envelope>;
        env.sig = `${env.sig.slice(0, 126)}${env.sig.endsWith('80') ? '81' : '80'}`;
        f.pack.envelope = env;
      },
      reason: 'envelope_signature_invalid',
    },
    {
      name: 'step 4: a 32-byte key that is not the committed CEK',
      mutate: (f) => {
        f.pack.disclosure = { contentKey: b64(TWO_WRAP_COMMITTED_CEK_HEX) };
      },
      reason: 'key_commitment_mismatch',
    },
    {
      name: 'step 4: a key that opens a two-key ciphertext under AES-GCM but fails kc',
      options: { envelope: TWO_WRAP_ENVELOPE },
      mutate: (f) => {
        f.pack.disclosure = { contentKey: b64(TWO_WRAP_OTHER_CEK_HEX) };
      },
      reason: 'key_commitment_mismatch',
    },
    {
      name: 'step 6: a plaintext that is not a valid payload',
      options: { envelope: TWO_WRAP_ENVELOPE },
      mutate: () => undefined,
      reason: 'payload_invalid',
    },
    {
      name: 'after step 6: the record kind does not match the payload (D-86)',
      options: { kind: 2 },
      mutate: () => undefined,
      reason: 'kind_mismatch',
    },
  ];

  for (const c of contentCases) {
    it(c.name, async () => {
      const f = await eoaFixture(c.options);
      c.mutate(f);
      const { reader } = chainWith(f);
      const result = await verify(f.pack, [reader]);
      // The record and its receipts still verify on their own; the pack proves no content.
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      expect(result.contentVerified).toBe(false);
      expect(result.verdict).toBe('record_only');
      expect(result.content).toEqual({
        status: 'failed',
        reason: c.reason,
        message: proofFailureMessage(c.reason as never),
      });
      expect(result.receipts).toEqual([{ type: 'DELIVERED', at: iso(DELIVERED_AT) }]);
      expectNoEcho(result, 'Hello from', MESSAGE_CEK_HEX, b64(MESSAGE_CEK_HEX));
    });
  }
});

describe('verifyProofPack: sender bound to the record signer (M1-4d-b, IR-M1-4d-1 M-1)', () => {
  /** A Nostr key that is not the envelope's sender: the recipient's own agent key. */
  const RECIPIENT_NOSTR = `0x${'ab'.repeat(32)}`;

  it('the recipient notarizes an envelope it received, under its own card: not shown as the author', async () => {
    const agentCard = cardFor({ agentNostr: RECIPIENT_NOSTR });
    const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard) } });
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.contentVerified).toBe(false);
    expect(result.content).toEqual({
      status: 'failed',
      reason: 'sender_mismatch',
      message: proofFailureMessage('sender_mismatch' as never),
    });
    expectNoEcho(result, 'Hello from', MESSAGE_CEK_HEX, b64(MESSAGE_CEK_HEX));
  });

  it('the sender check runs before the content key is used (07 §8 step 3)', async () => {
    const agentCard = cardFor({ agentNostr: RECIPIENT_NOSTR });
    const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard) } });
    f.pack.disclosure = { contentKey: b64(TWO_WRAP_COMMITTED_CEK_HEX) };
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.content).toEqual({
      status: 'failed',
      reason: 'sender_mismatch',
      message: proofFailureMessage('sender_mismatch' as never),
    });
  });

  it('without a card the content opens but is not attributed: verdict stays record_only', async () => {
    const f = await eoaFixture({ card: false });
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.signerCard).toBeNull();
    expect(result.contentVerified).toBe(false);
    expect(result.content).toEqual({
      status: 'unattributed',
      reason: 'sender_not_bound',
      message: proofFailureMessage('sender_not_bound' as never),
      sender: MESSAGE_ENVELOPE.from,
      payload: {
        type: 'text',
        body: 'Hello from the AgentLink test vectors ✓',
        files: [],
        replyTo: null,
      },
    });
  });

  it('a valid card without a disclosed key: the card is reported, the verdict is record_only', async () => {
    const f = await eoaFixture();
    delete f.pack.envelope;
    f.pack.disclosure = null;
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid && result.signerCard).toEqual(cardFor());
  });

  it('a card whose cardSig is not by its owner (forged) is refused', async () => {
    const agentCard = cardFor();
    const f = await eoaFixture({
      card: { agentCard, cardSig: await signCard(agentCard, OTHER_OWNER) },
    });
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expectFailure(result, 'card_invalid');
    expectNoEcho(result, OWNER_EVM, 'Hello from');
  });

  it('a card moved to a different owner after signing is refused', async () => {
    const signed = cardFor();
    const cardSig = await signCard(signed);
    const agentCard = cardFor({ ownerEvm: OTHER_OWNER.address.toLowerCase() });
    const f = await eoaFixture({ card: { agentCard, cardSig } });
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'card_invalid');
  });

  it('a card changed after signing to name the envelope sender is refused', async () => {
    const signed = cardFor({ agentNostr: RECIPIENT_NOSTR });
    const cardSig = await signCard(signed);
    const f = await eoaFixture({ card: { agentCard: cardFor(), cardSig } });
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'card_invalid');
  });

  it('a cardSig that is the agent key signature (cardAgentSig), not the owner one, is refused', async () => {
    const agentCard = cardFor();
    const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard, SIGNER) } });
    const { reader } = chainWith(f);
    expectFailure(await verify(f.pack, [reader]), 'card_invalid');
  });

  it('a card that had expired when the record was made is refused', async () => {
    for (const expiresAt of [NOTARIZED_AT - 1, NOTARIZED_AT]) {
      const agentCard = cardFor({ expiresAt });
      const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard) } });
      const { reader } = chainWith(f);
      expectFailure(await verify(f.pack, [reader]), 'card_expired');
    }
  });

  it('a card that was still valid when the record was made is accepted', async () => {
    const agentCard = cardFor({ expiresAt: NOTARIZED_AT + 1 });
    const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard) } });
    const { reader } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.valid && result.signerCard).toEqual(agentCard);
  });

  it('card-bound content without proof of possession never reports verified (card_pop_missing)', async () => {
    const f = await eoaFixture();
    const result = await verify(f.pack, [chainWith(f).reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid && result.contentVerified).toBe(false);
    expect(result.valid && result.content.status).toBe('unattributed');
    expect(result.valid && 'sender' in result.content && result.content.sender).toBe(
      MESSAGE_ENVELOPE.from,
    );
  });

  it('a card whose owner key is its agent key is refused (04 §2.9)', async () => {
    const agentCard = cardFor({ ownerEvm: SIGNER_EVM });
    const f = await eoaFixture({ card: { agentCard, cardSig: await signCard(agentCard, SIGNER) } });
    expectFailure(await verify(f.pack, [chainWith(f).reader]), 'card_invalid');
  });

  it('a card for another agent, or a card without its cardSig, is a malformed pack', async () => {
    const other = cardFor({ agentEvm: OTHER.address.toLowerCase() });
    const f1 = await eoaFixture({ card: { agentCard: other, cardSig: await signCard(other) } });
    expectFailure(await verify(f1.pack, [chainWith(f1).reader]), 'malformed_pack');
    const f2 = await eoaFixture();
    delete (f2.pack.signer as Record<string, unknown>).cardSig;
    expectFailure(await verify(f2.pack, [chainWith(f2).reader]), 'malformed_pack');
  });

  it('a card failure is a property of the pack: no content is opened', async () => {
    const agentCard = cardFor();
    const f = await eoaFixture({
      card: { agentCard, cardSig: await signCard(agentCard, OTHER_OWNER) },
    });
    const result = await verify(f.pack, [chainWith(f).reader]);
    expect(JSON.stringify(result)).not.toContain('Hello from');
  });

  it('the new codes are listed with fixed text', () => {
    expect(PROOF_PACK_FAILURES).toEqual(expect.arrayContaining(['card_invalid', 'card_expired']));
    expect(PROOF_CONTENT_FAILURES).toEqual(
      expect.arrayContaining(['sender_mismatch', 'sender_not_bound', 'card_pop_missing']),
    );
  });
});

describe('verifyProofPack: card proof of possession (M1-4d-d; 07 §8, 04 §2.9, D-102)', () => {
  /** `cardAgentSig`: the agent EVM key's EIP-712 signature over the card (04 §2.9). */
  const agentSig = (card: CardJson = cardFor(), account: typeof SIGNER = SIGNER) =>
    signCard(card, account);
  const PAYLOAD = {
    type: 'text',
    body: 'Hello from the AgentLink test vectors ✓',
    files: [],
    replyTo: null,
  };

  async function withPop(over: { cardAgentSig?: string; cardPop?: string } = {}) {
    return eoaFixture({ pop: { cardAgentSig: await agentSig(), cardPop: CARD_POP, ...over } });
  }

  it('both signatures valid, content passes every step: verified and attributed to the signer', async () => {
    const f = await withPop();
    const { reader, calls } = chainWith(f);
    const result = await verify(f.pack, [reader]);
    expect(result.verdict).toBe('verified');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.contentVerified).toBe(true);
    expect(result.signerType).toBe('account');
    expect(result.signerCard).toEqual(cardFor());
    expect(result.content).toEqual({
      status: 'verified',
      payload: PAYLOAD,
      sender: MESSAGE_ENVELOPE.from,
    });
    // Proof of possession is checked locally: no extra chain read.
    expect(calls.map((c) => c.fn ?? c.method)).toEqual(['getRecord']);
    expectNoEcho(result, CARD_POP);
  });

  it('a recipient-exported pack carrying the sender card signatures it received verifies', async () => {
    // The pack is the same whoever exports it: the record signer's card with its two signatures,
    // as received in a handshake or card-update (04 §2.9).
    const f = await withPop();
    const exported = clone(f.pack);
    const result = await verify(exported, [chainWith(f).reader]);
    expect(result.verdict).toBe('verified');
  });

  it('valid proof of possession without a disclosed key: record_only, the card is reported', async () => {
    const f = await withPop();
    delete f.pack.envelope;
    f.pack.disclosure = null;
    const result = await verify(f.pack, [chainWith(f).reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid && result.content).toEqual({ status: 'not_disclosed' });
    expect(result.valid && result.signerCard).toEqual(cardFor());
  });

  it('a card without either signature stays record_only with card_pop_missing', async () => {
    const f = await eoaFixture();
    const result = await verify(f.pack, [chainWith(f).reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid && result.content).toEqual({
      status: 'unattributed',
      reason: 'card_pop_missing',
      message: proofFailureMessage('card_pop_missing' as never),
      payload: PAYLOAD,
      sender: MESSAGE_ENVELOPE.from,
    });
  });

  it('a card naming another message key cannot carry the sender key cardPop', async () => {
    // The card's owner and agent EVM signatures are fine, but the cardPop is by the vector key,
    // not the card's agentNostr: the pack is refused before any content step.
    const RECIPIENT_NOSTR = `0x${'ab'.repeat(32)}`;
    const agentCard = cardFor({ agentNostr: RECIPIENT_NOSTR });
    const f = await eoaFixture({
      card: { agentCard, cardSig: await signCard(agentCard) },
      pop: { cardAgentSig: await agentSig(agentCard), cardPop: CARD_POP },
    });
    expectFailure(await verify(f.pack, [chainWith(f).reader]), 'card_pop_invalid');
  });

  it('one signature without the other is a malformed pack', async () => {
    const f1 = await eoaFixture({ pop: { cardAgentSig: await agentSig() } });
    expectFailure(await verify(f1.pack, [chainWith(f1).reader]), 'malformed_pack');
    const f2 = await eoaFixture({ pop: { cardPop: CARD_POP } });
    expectFailure(await verify(f2.pack, [chainWith(f2).reader]), 'malformed_pack');
  });

  it('the signatures without the card are a malformed pack', async () => {
    const f = await eoaFixture({
      card: false,
      pop: { cardAgentSig: await agentSig(), cardPop: CARD_POP },
    });
    expectFailure(await verify(f.pack, [chainWith(f).reader]), 'malformed_pack');
  });

  it('a cardPop not in bare 128 lowercase hex is a malformed pack', async () => {
    for (const cardPop of [
      `0x${CARD_POP}`,
      CARD_POP.toUpperCase(),
      CARD_POP.slice(2),
      `${CARD_POP}00`,
    ]) {
      const f = await withPop({ cardPop });
      expectFailure(await verify(f.pack, [chainWith(f).reader]), 'malformed_pack');
    }
  });

  const flipped = `${CARD_POP.slice(0, 127)}${CARD_POP.endsWith('a') ? 'b' : 'a'}`;
  const forgedPop: [string, string][] = [
    ['by another key', CARD_POP_WRONG_SIGNER],
    ['replayed from another key epoch of the same agent', CARD_POP_EPOCH_1],
    ['replayed from the same agent keys under another owner', CARD_POP_OTHER_OWNER],
    ['replayed from a card with another display name', CARD_POP_OTHER_NAME],
    ['over the card hash under the envelope tag', CARD_POP_ENVELOPE_TAG],
    ['over the card hash under the owner-action tag', CARD_POP_OWNER_ACTION_TAG],
    ['over the untagged card hash', CARD_POP_UNTAGGED],
    ['that is the envelope signature', MESSAGE_ENVELOPE.sig],
    ['with one bit flipped', flipped],
  ];
  for (const [name, cardPop] of forgedPop) {
    it(`a cardPop ${name} is refused: card_pop_invalid, no content opened`, async () => {
      const f = await withPop({ cardPop });
      const result = await verify(f.pack, [chainWith(f).reader]);
      expectFailure(result, 'card_pop_invalid');
      expectNoEcho(result, 'Hello from', cardPop, OWNER_EVM);
    });
  }

  it('this card cardPop, moved to the next epoch card of the same agent, is refused', async () => {
    const agentCard = cardFor({ keyEpoch: 1 });
    const f = await eoaFixture({
      card: { agentCard, cardSig: await signCard(agentCard) },
      pop: { cardAgentSig: await agentSig(agentCard), cardPop: CARD_POP },
    });
    expectFailure(await verify(f.pack, [chainWith(f).reader]), 'card_pop_invalid');
  });

  it('a cardAgentSig that is forged or made for another card is refused: card_pop_invalid', async () => {
    const cases: string[] = [
      await agentSig(cardFor(), OTHER),
      await signCard(cardFor()),
      await agentSig(cardFor({ keyEpoch: 1 })),
      await agentSig(cardFor({ ownerEvm: OTHER_OWNER.address.toLowerCase() })),
      await agentSig(cardFor({ nameHash: `0x${'8a'.repeat(32)}` })),
    ];
    for (const cardAgentSig of cases) {
      const f = await withPop({ cardAgentSig });
      const result = await verify(f.pack, [chainWith(f).reader]);
      expectFailure(result, 'card_pop_invalid');
      expect(JSON.stringify(result)).not.toContain('Hello from');
    }
  });

  it('a cardAgentSig in its high-s twin is refused (canonical ECDSA, 04 §2.4.1)', async () => {
    const sig = await agentSig();
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = sig.slice(130) === '1b' ? '1c' : '1b';
    const twin = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${v}`;
    const f = await withPop({ cardAgentSig: twin });
    const result = await verify(f.pack, [chainWith(f).reader]);
    expect(result.verdict).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('Hello from');
  });

  it('a pack with an invalid proof of possession fails even without a disclosed key', async () => {
    const f = await withPop({ cardPop: CARD_POP_EPOCH_1 });
    delete f.pack.envelope;
    f.pack.disclosure = null;
    expectFailure(await verify(f.pack, [chainWith(f).reader]), 'card_pop_invalid');
  });

  it('the card checks run first: a forged cardSig is card_invalid, an expired card card_expired', async () => {
    const f1 = await eoaFixture({
      card: { agentCard: cardFor(), cardSig: await signCard(cardFor(), OTHER_OWNER) },
      pop: { cardAgentSig: await agentSig(), cardPop: CARD_POP_WRONG_SIGNER },
    });
    expectFailure(await verify(f1.pack, [chainWith(f1).reader]), 'card_invalid');
    const expired = cardFor({ expiresAt: NOTARIZED_AT });
    const f2 = await eoaFixture({
      card: { agentCard: expired, cardSig: await signCard(expired) },
      pop: { cardAgentSig: await agentSig(expired), cardPop: CARD_POP_WRONG_SIGNER },
    });
    expectFailure(await verify(f2.pack, [chainWith(f2).reader]), 'card_expired');
  });

  it('a contract-account (ERC-1271) signer with both valid signatures stays record_only (M1-4d-e)', async () => {
    // The record signature does not recover to the signer, so it goes to the account's
    // isValidSignature, which accepts it: signerType is contract.
    const f = await eoaFixture({
      signWith: OTHER,
      pop: { cardAgentSig: await agentSig(), cardPop: CARD_POP },
    });
    const { reader } = chainWith(f, {
      code: new Map([[SIGNER_EVM, '0x6080604052']]),
      erc1271: (hash) => (hash === f.digest ? ERC1271_MAGIC : '0xffffffff'),
    });
    const result = await verify(f.pack, [reader]);
    expect(result.verdict).toBe('record_only');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.signerType).toBe('contract');
    expect(result.contentVerified).toBe(false);
    expect(result.content).toEqual({
      status: 'unattributed',
      reason: 'card_pop_missing',
      message: proofFailureMessage('card_pop_missing' as never),
      payload: PAYLOAD,
      sender: MESSAGE_ENVELOPE.from,
    });
  });

  it('a contract-account signer with a forged cardPop is still refused', async () => {
    const f = await eoaFixture({
      signWith: OTHER,
      pop: { cardAgentSig: await agentSig(), cardPop: CARD_POP_WRONG_SIGNER },
    });
    const { reader } = chainWith(f, {
      code: new Map([[SIGNER_EVM, '0x6080604052']]),
      erc1271: (hash) => (hash === f.digest ? ERC1271_MAGIC : '0xffffffff'),
    });
    expectFailure(await verify(f.pack, [reader]), 'card_pop_invalid');
  });

  it('the codes are listed with fixed text; sender_attribution_pending is retired', () => {
    expect(PROOF_PACK_FAILURES).toContain('card_pop_invalid');
    expect(PROOF_CONTENT_FAILURES).toContain('card_pop_missing');
    expect(PROOF_CONTENT_FAILURES).not.toContain('sender_attribution_pending');
    expect(PROOF_PACK_FAILURES).not.toContain('card_pop_missing');
    expect(proofFailureMessage('card_pop_invalid' as never)).toMatch(/agent profile/);
  });
});

describe('verifyProofPack: strict parsing of untrusted input (I-5)', () => {
  it('refuses an oversized pack before parsing or any request', async () => {
    const f = await eoaFixture();
    const { reader, fetchFn } = chainWith(f);
    const big = `${JSON.stringify(f.pack).slice(0, -1)},"pad":"${'x'.repeat(MAX_PROOF_PACK_BYTES)}"}`;
    expectFailure(await verify(big, [reader]), 'pack_too_large');
    expectFailure(await verify(new TextEncoder().encode(big), [reader]), 'pack_too_large');
    expectFailure(
      await verifyProofPack(
        { ...f.pack, pad: 'x'.repeat(MAX_PROOF_PACK_BYTES) },
        { chains: [reader] },
      ),
      'pack_too_large',
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(MAX_PROOF_PACK_BYTES).toBe(256 * 1024);
  });

  const MARK = 'packfieldmarker';
  const malformed: [string, (f: Fixture) => unknown, string][] = [
    ['not JSON', () => `{"type": "agentlink.proof", ${MARK}`, 'malformed_pack'],
    ['not UTF-8', () => new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'malformed_pack'],
    ['a JSON array', () => '[]', 'malformed_pack'],
    [
      'a duplicate key',
      (f) => JSON.stringify(f.pack).replace('{"type"', '{"type":"x","type"'),
      'malformed_pack',
    ],
    ['an unknown field', (f) => ({ ...f.pack, [MARK]: 1 }), 'malformed_pack'],
    [
      'an uppercase record ID',
      (f) => ({
        ...f.pack,
        recordId: (f.pack.recordId as string).toUpperCase().replace('0X', '0x'),
      }),
      'malformed_pack',
    ],
    [
      'a fractional chain ID',
      (f) => JSON.stringify(f.pack).replace('"chainId":84532', '"chainId":84532.0'),
      'malformed_pack',
    ],
    [
      'a maxFee as a number',
      (f) => ({ ...f.pack, record: { ...(f.pack.record as object), maxFee: 250000 } }),
      'malformed_pack',
    ],
    [
      'a signer that is not the record signer',
      (f) => ({ ...f.pack, signer: { evm: `0x${'5e'.repeat(20)}` } }),
      'malformed_pack',
    ],
    [
      'an exportedAt that is not a timestamp',
      (f) => ({ ...f.pack, exportedAt: MARK }),
      'malformed_pack',
    ],
    ['another type', (f) => ({ ...f.pack, type: MARK }), 'unsupported_pack'],
    ['another version', (f) => ({ ...f.pack, version: 2 }), 'unsupported_pack'],
  ];
  for (const [name, make, reason] of malformed) {
    it(`refuses ${name} with a fixed code and no echo`, async () => {
      const f = await eoaFixture();
      const { reader, fetchFn } = chainWith(f);
      const input = make(f);
      const result =
        typeof input === 'string' || input instanceof Uint8Array
          ? await verifyProofPack(input, { chains: [reader] })
          : await verifyProofPack(input as object, { chains: [reader] });
      expectFailure(result, reason);
      expectNoEcho(result, MARK);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it('never throws on hostile input: cycles, bigints, null, numbers', async () => {
    const { reader } = chainFor(base(), {});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [cyclic, { n: 1n }, null, 42, undefined]) {
      const result = await verifyProofPack(input as never, { chains: [reader] });
      expect(result.valid).toBe(false);
    }
  });

  it('refuses bad options with a ChainInputError that names no value', async () => {
    const f = await eoaFixture();
    await expect(verifyProofPack(JSON.stringify(f.pack), {} as never)).rejects.toBeInstanceOf(
      ChainInputError,
    );
    await expect(
      verifyProofPack(JSON.stringify(f.pack), { chains: [{ config: base() }] as never }),
    ).rejects.toBeInstanceOf(ChainInputError);
  });

  it('every failure code has fixed plain-language text without protocol jargon (11 §5)', () => {
    for (const code of [...PROOF_PACK_FAILURES, ...PROOF_CONTENT_FAILURES]) {
      const text = proofFailureMessage(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/wallet|gas|seed phrase|transaction/i);
    }
  });
});

describe('package root', () => {
  it('exports the verifier', () => {
    expect(packageRoot.verifyProofPack).toBe(verifyProofPack);
    expect(packageRoot.MAX_PROOF_PACK_BYTES).toBe(MAX_PROOF_PACK_BYTES);
  });
});
