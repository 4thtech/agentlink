// The MCP tool-surface guard (M1-9e; 06 §2.0, §9; I-4; D-53, D-55; 11 §5).
//
// - The committed snapshot `test/fixtures/tool-surface.json` is generated from the real registry
//   (names, input and output schemas, annotations as the MCP `tools/list` shows them). Any drift
//   fails here. CHANGING THE SNAPSHOT NEEDS THE OWNER'S "merge" IN CHAT (D-51, D-52). Regenerate
//   with `UPDATE_TOOL_SURFACE=1 pnpm --filter @4thtech-io/agentlink exec vitest run test/tool-surface.test.ts`.
// - The D-53 and D-55 assertions run against the 06 §2.0 table read from the spec itself, so the
//   expected values cannot be retyped wrongly here.
// - `auditSurface` is the one rule set; it runs on the real registry (must be clean) and on bad
//   fixture surfaces (each must be caught), so the guard itself is tested.
// - The stdio schema-validation check lives in test/mcp-conformance.test.ts.
//
// TODO (post-0.1.0, M1-9e): "a removed or renamed tool, or a removed or newly required field, fails
// unless the PR records a decision-log entry" needs the previous release's surface to compare with
// (a published snapshot or the base branch). Until 0.1.0 ships there is nothing frozen to compare
// against; add the comparison with the 0.1.0 release card.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { toMcpTool } from '../src/mcp/server.js';
import { ADVANCED_TOOLS, TOOLS } from '../src/tools/registry.js';

const SNAPSHOT = new URL('./fixtures/tool-surface.json', import.meta.url);
const SPEC = new URL('../../../docs/foundation/06-mcp-server.md', import.meta.url);

interface SurfaceTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

// ---- The 06 §2.0 table -------------------------------------------------------------------------

interface TableRow {
  readonly name: string;
  readonly annotations: readonly [boolean, boolean, boolean, boolean];
  readonly approval: boolean;
  readonly phase: 'M1a' | 'M1b';
}

function readTable(): TableRow[] {
  const spec = readFileSync(SPEC, 'utf8');
  const start = spec.indexOf('### 2.0 Tool surface');
  const end = spec.indexOf('**Consolidation', start);
  const rows: TableRow[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const name = /^`(agentlink_[a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (name === undefined) continue;
    // "false (marks items read; ...)" keeps its leading boolean.
    const flags = cells.slice(2, 6).map((c) => /^(true|false)\b/.exec(c)?.[1]);
    if (flags.some((f) => f === undefined)) throw new Error(`unreadable annotation cells: ${name}`);
    const phase = /^M1([ab])\b/.exec(cells[7] ?? '')?.[1];
    if (phase === undefined) throw new Error(`unreadable phase: ${name}`);
    rows.push({
      name,
      annotations: flags.map((f) => f === 'true') as unknown as TableRow['annotations'],
      approval: cells[6] !== '—',
      phase: phase === 'a' ? 'M1a' : 'M1b',
    });
  }
  return rows;
}

// ---- The rule set ------------------------------------------------------------------------------

/** 11 §5.1 words that must not reach default UI strings (titles, descriptions, instructions). */
const BANNED_WORDS: readonly [string, RegExp][] = [
  ['wallet', /\bwallets?\b/i],
  ['gas', /\bgas\b/i],
  ['seed phrase', /\bseed phrases?\b/i],
  ['transaction', /\btransactions?\b/i],
];

/** Tool names that would change policy, export keys, add credentials, decide approvals or hooks (I-4). */
const DENIED_NAME =
  /polic|export|key|credential|secret|storage|approve|decide|deny|hook|config|install|setting|block|ignore|read_file|read_path|backup|restore/i;
/** Argument names that would carry a key, a credential, a path or a decision (I-4). */
/**
 * Descriptions and titles must not offer a denied capability (I-4, 06 §1 rule 4, "no hooks").
 * NOTE for M1-9d: the name and argument rules also flag legitimate M1b tools (`export` in
 * agentlink_export_proof_pack; `path` and `file` on send and fetch_file). Do not loosen them: add an
 * explicit per-tool allowlist entry with a justification when those tools land.
 */
const DENIED_TEXT =
  /\b(set|change|update|edit|modify|install|remove|export|reveal|read)\s+(the\s+|your\s+|any\s+)?(polic(y|ies)|hooks?|harness (config\w*|settings)|private keys?|keys?|credentials?|passphrase|arbitrary files?)/i;
const DENIED_ARG =
  /private|secret|seed|passphrase|password|token|credential|accesskey|apikey|signature|signed|polic|path|file|hook|decide|approve\b|approved\b|owner/i;

/**
 * Explicit per-tool exceptions to DENIED_ARG (M1-9d-1; the M1-9e note above). Each names one tool
 * and one argument, with why it does not read arbitrary files (I-4, 06 §1 rule 4). Nothing else is
 * exempt, and the rules themselves are unchanged.
 */
const ARG_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  agentlink_send: {
    // 06 §2.2, §2.3: one file, resolved with realpath and sent only from inside an owner-allowed
    // folder (`files.allowedFolders`); hidden and protected paths refused; outside → needs_setup,
    // the file never opened (04 §4; test/files-mcp.test.ts).
    path: 'attaches one file from an owner-allowed folder only (04 §4)',
  },
  agentlink_fetch_file: {
    // 06 §2.3: an index into the received message's files[], not a path; the file is saved only
    // into `files.inboxFolder` under a sanitised, never-overwriting name (D-84).
    fileIndex: 'an index into a received message, not a path',
  },
  agentlink_verify_proof_pack: {
    // 06 §2.4, G-25, D-87 (owner decision 2026-10-18): a proof pack file strictly inside
    // `proofs.exportFolder` or `files.inboxFolder` only. A lexical check refuses any other path
    // before the disk is touched; then realpath, no-follow open, regular file, 256 KiB cap, device
    // and inode match; fixed codes only (src/runtime/proofs.test.ts). Read-only: writes nothing.
    path: 'a proof pack inside the export or inbox folder only (D-87)',
  },
};

/**
 * Explicit per-tool exceptions to DENIED_NAME (M1-9d-2; the M1-9e note above). The name is fixed by
 * the 06 §2.0 table (D-53), frozen at 0.1.0. Nothing else is exempt, and the rule is unchanged.
 */
const NAME_ALLOWLIST: Readonly<Record<string, string>> = {
  // 06 §2.4: saves a proof pack (07 §8) of the agent's own record into `proofs.exportFolder`. It
  // exports no key: the message's content key goes into the pack only with the owner's approval
  // (`proofs.allowKeyDisclosure`, never `allow`; 06 §3), and no agent key ever leaves the KeyStore.
  agentlink_export_proof_pack: 'saves a proof pack; the content key only with owner approval',
};

/**
 * Words the file tools' titles and descriptions must not use (M1-9d-1; 11 §5, D-40): storage and
 * network internals a user never needs to see.
 */
const FILE_JARGON =
  /\b(chains?|presigned|locators?|s3|r2|buckets?|ciphertext|alf1|nostr|relays?)\b/i;
const FILE_TOOLS: ReadonlySet<string> = new Set(['agentlink_send', 'agentlink_fetch_file']);

/**
 * M1-26-b (D-40, 02 F-51, 11 §5.1): users never choose or see a chain outside Advanced.
 * - Output: a network (`chain`, `chainId`, `network`) or a fee-token name (`token`, except the hex
 *   address of `fee.token`, 06 §2.4) appears only inside an `advanced` member, at any depth.
 * - Input: no tool on the default surface takes a network argument (M1-36h, D-39/D-40); only the
 *   Advanced surface (`agentlink mcp --advanced`) adds the `chain?` override, on agentlink_notarize
 *   alone and never as required.
 * - Titles and descriptions name no network or fee token; "chain" appears only in the Advanced
 *   description of the one tool with the override (to say: leave it out).
 */
const NETWORK_NAMES = /\b(base|sepolia|gnosis|chiado|usdc|usdt|xdai|blockchain|on-chain)\b/i;
const CHAIN_WORD = /\bchains?\b/i;
const CHAIN_OVERRIDE_TOOL = 'agentlink_notarize';
const NETWORK_FIELD = /^(chain|chainId|network)$/;

/** Output fields that name a network or a fee token outside `advanced`, as dotted paths. */
export function networkFieldsOutsideAdvanced(schema: unknown, at = ''): string[] {
  const out: string[] = [];
  if (Array.isArray(schema)) {
    for (const item of schema) out.push(...networkFieldsOutsideAdvanced(item, at));
    return out;
  }
  if (typeof schema !== 'object' || schema === null) return out;
  const record = schema as Record<string, unknown>;
  const props = record['properties'];
  if (typeof props === 'object' && props !== null) {
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      if (key === 'advanced') continue;
      const where = at === '' ? key : `${at}.${key}`;
      if (NETWORK_FIELD.test(key)) out.push(where);
      if (key === 'token' && !at.endsWith('fee')) out.push(where);
      out.push(...networkFieldsOutsideAdvanced(sub, where));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'properties') out.push(...networkFieldsOutsideAdvanced(value, at));
  }
  return out;
}

function argNames(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) argNames(item, out);
  } else if (typeof schema === 'object' && schema !== null) {
    const record = schema as Record<string, unknown>;
    const props = record['properties'];
    if (typeof props === 'object' && props !== null) out.push(...Object.keys(props));
    for (const value of Object.values(record)) argNames(value, out);
  }
  return out;
}

/** Every violation of the tool-surface rules, as readable lines. Empty: the surface is clean. */
export function auditSurface(
  tools: readonly SurfaceTool[],
  table: readonly TableRow[],
  instructions: string,
  advanced = false,
): string[] {
  const override = (name: string): boolean => advanced && name === CHAIN_OVERRIDE_TOOL;
  const bad: string[] = [];
  const byName = new Map(table.map((row) => [row.name, row]));
  for (const tool of tools) {
    const { name } = tool;
    const row = byName.get(name);
    if (!name.startsWith('agentlink_')) bad.push(`${name}: name lacks the agentlink_ prefix`);
    if (row === undefined) bad.push(`${name}: not a tool of the 06 §2.0 table`);
    if (DENIED_NAME.test(name) && NAME_ALLOWLIST[name] === undefined) {
      bad.push(`${name}: name suggests a denied capability (I-4)`);
    }
    for (const [where, text] of [
      ['title', tool.title ?? ''],
      ['description', tool.description ?? ''],
    ] as const) {
      if (DENIED_TEXT.test(text)) bad.push(`${name}: ${where} offers a denied capability (I-4)`);
    }
    const a = tool.annotations ?? {};
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (typeof a[hint] !== 'boolean') bad.push(`${name}: annotation ${hint} not set explicitly`);
    }
    if (row !== undefined) {
      const actual = [
        a['readOnlyHint'],
        a['destructiveHint'],
        a['idempotentHint'],
        a['openWorldHint'],
      ];
      if (JSON.stringify(actual) !== JSON.stringify(row.annotations)) {
        bad.push(`${name}: annotations ${JSON.stringify(actual)} differ from 06 §2.0`);
      }
    }
    for (const arg of argNames(tool.inputSchema)) {
      if (DENIED_ARG.test(arg) && ARG_ALLOWLIST[name]?.[arg] === undefined) {
        bad.push(`${name}: argument "${arg}" is a denied kind (I-4)`);
      }
    }
    if (FILE_TOOLS.has(name)) {
      for (const [where, text] of [
        ['title', tool.title ?? ''],
        ['description', tool.description ?? ''],
      ] as const) {
        const word = FILE_JARGON.exec(text)?.[0];
        if (word !== undefined) bad.push(`${name}: ${where} uses jargon "${word}" (11 §5)`);
      }
    }
    const inputProps = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>;
    // Every tool's `status` enum lists pending_approval (the common result shape), so the tools
    // that can actually return it are the table's "Approval" column.
    if (row?.approval === true && !('approvalId' in inputProps)) {
      bad.push(`${name}: can return pending_approval but accepts no approvalId`);
    }
    for (const [word, pattern] of BANNED_WORDS) {
      for (const [where, text] of [
        ['title', tool.title ?? ''],
        ['description', tool.description ?? ''],
      ] as const) {
        if (pattern.test(text)) bad.push(`${name}: ${where} uses "${word}" (11 §5)`);
      }
    }
    // M1-26-b: no network outside Advanced, no chain prompt (D-40, 11 §5.1).
    for (const field of new Set(networkFieldsOutsideAdvanced(tool.outputSchema ?? {}))) {
      bad.push(`${name}: output field "${field}" names a network outside advanced (D-40)`);
    }
    for (const arg of argNames(tool.inputSchema)) {
      if (NETWORK_FIELD.test(arg) && !(override(name) && arg === 'chain')) {
        bad.push(`${name}: argument "${arg}" asks for a network (D-40)`);
      }
    }
    const required = (tool.inputSchema['required'] ?? []) as unknown[];
    if (required.some((r) => typeof r === 'string' && NETWORK_FIELD.test(r))) {
      bad.push(`${name}: requires a network argument (D-40)`);
    }
    for (const [where, text] of [
      ['title', tool.title ?? ''],
      ['description', tool.description ?? ''],
    ] as const) {
      const word = NETWORK_NAMES.exec(text)?.[0];
      if (word !== undefined) bad.push(`${name}: ${where} names a network "${word}" (11 §5.1)`);
      if (CHAIN_WORD.test(text) && !(where === 'description' && override(name))) {
        bad.push(`${name}: ${where} says "chain" (11 §5.1)`);
      }
    }
    if (name === 'agentlink_send') {
      const type = (inputProps['type'] ?? {}) as { enum?: string[] };
      for (const banned of ['offer', 'accept', 'reject']) {
        if (type.enum?.includes(banned)) bad.push(`${name}: type enum carries "${banned}" (D-55)`);
      }
    }
  }
  // The instructions tell the model what not to say; that one clause names the words on purpose.
  const prose = instructions.replace(/never mention wallets, gas, keys or chains[^.]*\./i, '');
  for (const [word, pattern] of BANNED_WORDS) {
    if (pattern.test(prose)) bad.push(`server instructions use "${word}" (11 §5)`);
  }
  // M1-36h (11 §5.1): no network, "on-chain" or "notarization" wording in the instructions either.
  const network = NETWORK_NAMES.exec(prose)?.[0];
  if (network !== undefined) bad.push(`server instructions name a network "${network}" (11 §5.1)`);
  if (CHAIN_WORD.test(prose)) bad.push('server instructions say "chain" (11 §5.1)');
  if (/\bnotari[sz]ation\b/i.test(prose)) {
    bad.push('server instructions say "notarization" (11 §5.1: add proof)');
  }
  return bad;
}

// ---- Tests -------------------------------------------------------------------------------------

const surface = TOOLS.map(toMcpTool) as unknown as SurfaceTool[];
const advancedSurface = ADVANCED_TOOLS.map(toMcpTool) as unknown as SurfaceTool[];
const table = readTable();

describe('the chain override is Advanced only (M1-36h; D-39, D-40; 11 §5.1)', () => {
  const props = (tool: SurfaceTool | undefined): Record<string, unknown> =>
    (tool?.inputSchema['properties'] ?? {}) as Record<string, unknown>;

  it('the default surface has no chain argument and never says "chain"', () => {
    for (const tool of surface) {
      expect(argNames(tool.inputSchema), tool.name).not.toContain('chain');
      expect(`${tool.title ?? ''} ${tool.description ?? ''}`, tool.name).not.toMatch(CHAIN_WORD);
    }
    const notarize = surface.find((t) => t.name === 'agentlink_notarize');
    expect(Object.keys(props(notarize)).sort()).toEqual([
      'approvalId',
      'clientRequestId',
      'envelopeId',
      'requestReceipt',
    ]);
    expect(notarize?.inputSchema['additionalProperties']).toBe(false);
  });

  it('the Advanced surface differs only by the optional chain override on agentlink_notarize', () => {
    expect(advancedSurface.map((t) => t.name)).toEqual(surface.map((t) => t.name));
    for (const [i, tool] of advancedSurface.entries()) {
      if (tool.name === 'agentlink_notarize') continue;
      expect(tool, tool.name).toEqual(surface[i]);
    }
    const base = surface.find((t) => t.name === 'agentlink_notarize')!;
    const adv = advancedSurface.find((t) => t.name === 'agentlink_notarize')!;
    expect(props(adv)['chain']).toEqual({ type: 'string', pattern: '^[a-z0-9-]{1,32}$' });
    expect(adv.inputSchema['required']).toEqual(['envelopeId']);
    const { chain: _chain, ...rest } = props(adv);
    expect(rest).toEqual(props(base));
    expect(adv.description).toMatch(/leave chain out unless the user explicitly asks for one/);
    expect(base.description).not.toMatch(/leave chain out/);
    expect({ ...adv, inputSchema: undefined, description: undefined }).toEqual({
      ...base,
      inputSchema: undefined,
      description: undefined,
    });
  });
});

describe('server instructions wording (M1-36h; 11 §5.1, I-5)', () => {
  it('say "public proof" and "adding proof", never "on-chain" or "notarization"', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/add a public proof when the user asks for it/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Adding proof costs a small fee/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/on-chain|notari[sz]ation/i);
  });

  it('tell the model the network is picked automatically and never to ask the user to choose one', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /AgentLink picks the proof network automatically, so never ask the user to choose one/,
    );
  });

  it('are fixed text: no placeholder, template or run-time value (I-5)', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/[{}]|\$\{/);
  });

  it('auditSurface flags network wording in the instructions', () => {
    const audit = (text: string) => auditSurface(surface, table, text).join('\n');
    expect(audit(`${SERVER_INSTRUCTIONS} Pick a chain.`)).toMatch(/instructions say "chain"/);
    expect(audit(`${SERVER_INSTRUCTIONS} Proof is on-chain.`)).toMatch(/name a network "on-chain"/);
    expect(audit(`${SERVER_INSTRUCTIONS} Notarization costs.`)).toMatch(/say "notarization"/);
  });
});

describe('tool-surface snapshot', () => {
  const current = surface.map(
    ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
    }),
  );

  it('matches the committed snapshot (changes need the owner\'s "merge" in chat)', () => {
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (process.env['UPDATE_TOOL_SURFACE'] === '1') writeFileSync(SNAPSHOT, text);
    const committed = readFileSync(SNAPSHOT, 'utf8');
    expect(
      JSON.parse(text),
      'The MCP tool surface changed (names, schemas or annotations). The surface is frozen (D-53, ' +
        'I-4): such a change needs the owner\'s "merge" in chat (D-51, D-52). If it is intended, ' +
        'regenerate test/fixtures/tool-surface.json with UPDATE_TOOL_SURFACE=1 and say so in the PR.',
    ).toEqual(JSON.parse(committed));
  });
});

describe('06 §2.0 table (D-53, D-55)', () => {
  it('lists the 15 tools, 9 in M1a and 6 in M1b', () => {
    expect(table).toHaveLength(15);
    expect(table.filter((r) => r.phase === 'M1a')).toHaveLength(9);
    expect(table.filter((r) => r.phase === 'M1b')).toHaveLength(6);
  });

  // M1-9d is split (M1-9d-1: files; M1-9d-2: the proof tools). Each M1b tool is registered against
  // the table here when its card lands; the rest stay pending.
  const REGISTERED_M1B: readonly string[] = [
    'agentlink_fetch_file',
    'agentlink_notarize',
    'agentlink_acknowledge',
    'agentlink_get_proof',
    'agentlink_export_proof_pack',
    'agentlink_verify_proof_pack',
  ];

  it('the registry is the M1a rows plus the landed M1b rows; the other M1b rows stay pending', () => {
    const m1a = table.filter((r) => r.phase === 'M1a').map((r) => r.name);
    for (const name of REGISTERED_M1B) {
      expect(table.find((r) => r.name === name)?.phase).toBe('M1b');
    }
    expect(surface.map((t) => t.name).sort()).toEqual([...m1a, ...REGISTERED_M1B].sort());
    const pending = table
      .filter((r) => r.phase === 'M1b' && !REGISTERED_M1B.includes(r.name))
      .map((r) => r.name);
    expect(pending).toHaveLength(0);
    for (const name of pending) expect(surface.map((t) => t.name)).not.toContain(name);
  });

  it('agentlink_fetch_file carries idempotentHint false (06 §2.0) and no path argument', () => {
    const tool = surface.find((t) => t.name === 'agentlink_fetch_file');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(Object.keys(tool?.inputSchema['properties'] ?? {}).sort()).toEqual([
      'envelopeId',
      'fileIndex',
    ]);
  });

  it('the registry holds exactly the 15 tools of the table, in its order (D-53, D-55)', () => {
    expect(surface.map((t) => t.name)).toEqual(table.map((r) => r.name));
  });

  it('agentlink_verify_proof_pack takes path or json only; no tool asks for a chain by default', () => {
    const verify = surface.find((t) => t.name === 'agentlink_verify_proof_pack');
    expect(Object.keys(verify?.inputSchema['properties'] ?? {}).sort()).toEqual(['json', 'path']);
    for (const tool of surface) {
      const required = (tool.inputSchema['required'] ?? []) as string[];
      expect(required, tool.name).not.toContain('chain');
    }
  });

  it('agentlink_export_proof_pack leaves the content key and the recipient out by default', () => {
    const tool = surface.find((t) => t.name === 'agentlink_export_proof_pack');
    const props = (tool?.inputSchema['properties'] ?? {}) as Record<string, { default?: unknown }>;
    expect(Object.keys(props).sort()).toEqual([
      'approvalId',
      'envelopeId',
      'includeContentKey',
      'includeRecipient',
      'recordId',
    ]);
    expect(tool?.inputSchema['required']).toBeUndefined();
  });

  it('no tool name is duplicated', () => {
    const names = surface.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('auditSurface on the real registry', () => {
  it('is clean: prefix, four annotations per the table, approvalId, no denied capability, vocabulary', () => {
    expect(auditSurface(surface, table, SERVER_INSTRUCTIONS)).toEqual([]);
  });

  it('the Advanced surface is clean under the Advanced rules (M1-36h)', () => {
    expect(auditSurface(advancedSurface, table, SERVER_INSTRUCTIONS, true)).toEqual([]);
  });

  it('the Advanced surface fails the default rules: its chain override is Advanced only', () => {
    const bad = auditSurface(advancedSurface, table, SERVER_INSTRUCTIONS).join('\n');
    expect(bad).toMatch(/agentlink_notarize: argument "chain" asks for a network/);
    expect(bad).toMatch(/agentlink_notarize: description says "chain"/);
  });

  it('agentlink_send has no offer, accept or reject type (D-55)', () => {
    const send = surface.find((t) => t.name === 'agentlink_send')!;
    const type = (send.inputSchema['properties'] as Record<string, { enum?: string[] }>)['type'];
    expect(type?.enum).toEqual(['text', 'note', 'request', 'delivery']);
  });

  it('keeps the policy-free surface: no tool is destructive (06 §2.0)', () => {
    expect(surface.filter((t) => t.annotations?.['destructiveHint'] === true)).toEqual([]);
  });
});

describe('auditSurface catches bad surfaces (local demonstration, kept as a test)', () => {
  const base = surface.find((t) => t.name === 'agentlink_list_contacts')!;
  const fixture = (patch: Partial<SurfaceTool>): SurfaceTool[] => [
    ...surface,
    { ...base, ...patch },
  ];
  const audit = (tools: SurfaceTool[]): string[] => auditSurface(tools, table, SERVER_INSTRUCTIONS);

  it('an export tool other than the allowlisted proof-pack tool', () => {
    expect(audit(fixture({ name: 'agentlink_export_keys' })).join('\n')).toMatch(
      /agentlink_export_keys: name suggests a denied capability/,
    );
  });

  it('a path argument on agentlink_get_proof (the allowlist is per tool)', () => {
    const tools = surface.map((t) =>
      t.name === 'agentlink_get_proof'
        ? { ...t, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
        : t,
    );
    expect(audit(tools).join('\n')).toMatch(/agentlink_get_proof: argument "path"/);
  });

  it('a set_policy tool', () => {
    expect(audit(fixture({ name: 'agentlink_set_policy' })).join('\n')).toMatch(
      /denied capability/,
    );
  });
  it('a privateKey argument', () => {
    const tools = fixture({
      name: 'agentlink_status',
      inputSchema: { type: 'object', properties: { privateKey: { type: 'string' } } },
    });
    expect(audit(tools).join('\n')).toMatch(/argument "privateKey"/);
  });
  it('a name without the agentlink_ prefix', () => {
    expect(audit(fixture({ name: 'send_message' })).join('\n')).toMatch(
      /lacks the agentlink_ prefix/,
    );
  });
  it('a write tool marked readOnlyHint true', () => {
    const send = surface.find((t) => t.name === 'agentlink_send')!;
    const tools = surface.map((t) =>
      t === send ? { ...t, annotations: { ...t.annotations, readOnlyHint: true } } : t,
    );
    expect(audit(tools).join('\n')).toMatch(/agentlink_send: annotations/);
  });
  it('a missing annotation', () => {
    const tools = surface.map((t) =>
      t.name === 'agentlink_status' ? { ...t, annotations: { readOnlyHint: true } } : t,
    );
    expect(audit(tools).join('\n')).toMatch(/not set explicitly/);
  });
  it('a pending_approval tool without approvalId', () => {
    const send = surface.find((t) => t.name === 'agentlink_send')!;
    const props = { ...(send.inputSchema['properties'] as object) } as Record<string, unknown>;
    delete props['approvalId'];
    const tools = surface.map((t) =>
      t === send ? { ...t, inputSchema: { ...t.inputSchema, properties: props } } : t,
    );
    expect(audit(tools).join('\n')).toMatch(/accepts no approvalId/);
  });
  it('an offer type on agentlink_send', () => {
    const send = surface.find((t) => t.name === 'agentlink_send')!;
    const props = send.inputSchema['properties'] as Record<string, { enum: string[] }>;
    const inputSchema = {
      ...send.inputSchema,
      properties: { ...props, type: { enum: [...props['type']!.enum, 'offer'] } },
    };
    const tools = surface.map((t) => (t === send ? { ...t, inputSchema } : t));
    expect(audit(tools).join('\n')).toMatch(/carries "offer"/);
  });
  it('a description that offers a denied capability', () => {
    const tools = fixture({
      name: 'agentlink_status',
      description: 'Change the policy for a contact.',
    });
    expect(audit(tools).join('\n')).toMatch(/description offers a denied capability/);
    const hook = fixture({
      name: 'agentlink_status',
      description: 'Install hooks into your harness.',
    });
    expect(audit(hook).join('\n')).toMatch(/description offers a denied capability/);
  });
  it('a path argument on a tool without an allowlist entry, and file jargon', () => {
    const tools = fixture({
      name: 'agentlink_status',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    });
    expect(audit(tools).join('\n')).toMatch(/agentlink_status: argument "path"/);
    const send = surface.find((t) => t.name === 'agentlink_send')!;
    const jargon = surface.map((t) =>
      t === send ? { ...t, description: `${t.description ?? ''} Uploads to a presigned URL.` } : t,
    );
    expect(audit(jargon).join('\n')).toMatch(/agentlink_send: description uses jargon/);
  });
  it('a network outside advanced: an output field, a chain argument, a network name (M1-26-b)', () => {
    const status = surface.find((t) => t.name === 'agentlink_status')!;
    const withChain = (outputSchema: Record<string, unknown>) =>
      surface.map((t) => (t === status ? { ...t, outputSchema } : t));
    const credit = (props: Record<string, unknown>) => ({
      type: 'object',
      properties: { credits: { type: 'array', items: { type: 'object', properties: props } } },
    });
    expect(audit(withChain(credit({ chain: { type: 'string' } }))).join('\n')).toMatch(
      /agentlink_status: output field "credits.chain" names a network outside advanced/,
    );
    expect(audit(withChain(credit({ token: { type: 'string' } }))).join('\n')).toMatch(
      /output field "credits.token"/,
    );
    // Under `advanced` both are fine; `fee.token` (a hex address, 06 §2.4) is fine too.
    expect(
      audit(
        withChain(
          credit({
            advanced: {
              type: 'object',
              properties: { chain: { type: 'string' }, token: { type: 'string' } },
            },
            fee: { type: 'object', properties: { token: { type: 'string' } } },
          }),
        ),
      ).join('\n'),
    ).not.toMatch(/agentlink_status: output field/);
    const getProof = surface.find((t) => t.name === 'agentlink_get_proof')!;
    const chainArg = surface.map((t) =>
      t === getProof
        ? { ...t, inputSchema: { type: 'object', properties: { chain: { type: 'string' } } } }
        : t,
    );
    expect(audit(chainArg).join('\n')).toMatch(/agentlink_get_proof: argument "chain" asks/);
    const notarize = surface.find((t) => t.name === 'agentlink_notarize')!;
    const required = surface.map((t) =>
      t === notarize
        ? { ...t, inputSchema: { ...t.inputSchema, required: ['envelopeId', 'chain'] } }
        : t,
    );
    expect(audit(required).join('\n')).toMatch(/agentlink_notarize: requires a network/);
    expect(
      audit(fixture({ name: 'agentlink_status', description: 'Credits on Base Sepolia.' })).join(
        '\n',
      ),
    ).toMatch(/agentlink_status: description names a network "Base"/);
    expect(
      audit(fixture({ name: 'agentlink_status', description: 'Pick a chain first.' })).join('\n'),
    ).toMatch(/agentlink_status: description says "chain"/);
  });

  it('banned vocabulary in a description and in the instructions', () => {
    expect(
      audit(fixture({ name: 'agentlink_status', description: 'Pays the gas fee.' })).join('\n'),
    ).toMatch(/uses "gas"/);
    expect(
      auditSurface(surface, table, `${SERVER_INSTRUCTIONS} Open your wallet.`).join('\n'),
    ).toMatch(/instructions use "wallet"/);
  });
});
