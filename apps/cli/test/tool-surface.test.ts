// The MCP tool-surface guard (M1-9e; 06 §2.0, §9; I-4; D-53, D-55; 11 §5).
//
// - The committed snapshot `test/fixtures/tool-surface.json` is generated from the real registry
//   (names, input and output schemas, annotations as the MCP `tools/list` shows them). Any drift
//   fails here. CHANGING THE SNAPSHOT NEEDS THE OWNER'S "merge" IN CHAT (D-51, D-52). Regenerate
//   with `UPDATE_TOOL_SURFACE=1 pnpm --filter @4thtech/agentlink exec vitest run test/tool-surface.test.ts`.
// - The D-53 and D-55 assertions run against the 06 §2.0 table read from the spec itself, so the
//   expected values cannot be retyped wrongly here.
// - `auditSurface` is the one rule set; it runs on the real registry (must be clean) and on bad
//   fixture surfaces (each must be caught), so the guard itself is tested.
// - The Inspector CLI check lives in test/inspector-cli.test.ts.
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
import { TOOLS } from '../src/tools/registry.js';

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
const DENIED_ARG =
  /private|secret|seed|passphrase|password|token|credential|accesskey|apikey|signature|signed|polic|path|file|hook|decide|approve\b|approved\b|owner/i;

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
): string[] {
  const bad: string[] = [];
  const byName = new Map(table.map((row) => [row.name, row]));
  for (const tool of tools) {
    const { name } = tool;
    const row = byName.get(name);
    if (!name.startsWith('agentlink_')) bad.push(`${name}: name lacks the agentlink_ prefix`);
    if (row === undefined) bad.push(`${name}: not a tool of the 06 §2.0 table`);
    if (DENIED_NAME.test(name)) bad.push(`${name}: name suggests a denied capability (I-4)`);
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
      if (DENIED_ARG.test(arg)) bad.push(`${name}: argument "${arg}" is a denied kind (I-4)`);
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
    if (name === 'agentlink_send') {
      const type = (inputProps['type'] ?? {}) as { enum?: string[] };
      for (const banned of ['offer', 'accept', 'reject']) {
        if (type.enum?.includes(banned)) bad.push(`${name}: type enum carries "${banned}" (D-55)`);
      }
    }
  }
  // The instructions tell the model what not to say; that one sentence names the words on purpose.
  const prose = instructions.replace(/Never mention wallets, gas, keys or chains[^.]*\./, '');
  for (const [word, pattern] of BANNED_WORDS) {
    if (pattern.test(prose)) bad.push(`server instructions use "${word}" (11 §5)`);
  }
  return bad;
}

// ---- Tests -------------------------------------------------------------------------------------

const surface = TOOLS.map(toMcpTool) as unknown as SurfaceTool[];
const table = readTable();

describe('tool-surface snapshot', () => {
  const current = surface.map(({ name, inputSchema, outputSchema, annotations }) => ({
    name,
    inputSchema,
    outputSchema,
    annotations,
  }));

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
  it('lists the 15 tools, 9 in M1a and 6 pending until M1-9d', () => {
    expect(table).toHaveLength(15);
    expect(table.filter((r) => r.phase === 'M1a')).toHaveLength(9);
    expect(table.filter((r) => r.phase === 'M1b')).toHaveLength(6);
  });

  it('the registry is exactly the M1a rows; the M1b rows stay pending', () => {
    const m1a = table.filter((r) => r.phase === 'M1a').map((r) => r.name);
    expect(surface.map((t) => t.name).sort()).toEqual([...m1a].sort());
    // M1-9d adds the six M1b tools; then this test registers them against the table too.
    const pending = table.filter((r) => r.phase === 'M1b').map((r) => r.name);
    for (const name of pending) expect(surface.map((t) => t.name)).not.toContain(name);
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
  it('banned vocabulary in a description and in the instructions', () => {
    expect(
      audit(fixture({ name: 'agentlink_status', description: 'Pays the gas fee.' })).join('\n'),
    ).toMatch(/uses "gas"/);
    expect(
      auditSurface(surface, table, `${SERVER_INSTRUCTIONS} Open your wallet.`).join('\n'),
    ).toMatch(/instructions use "wallet"/);
  });
});
