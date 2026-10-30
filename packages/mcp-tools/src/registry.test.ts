// The frozen M1a tool surface (06 §2.0, §9; I-4; M1-9c). The snapshot below is the committed
// tool-surface record: any rename, new tool, schema or annotation change fails here until the
// snapshot is updated in a reviewed change (with M1-9e's snapshot, 06 §9).
import { APPROVAL_TOOL_NAMES, MCP_TOOL_NAMES } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { PENDING_M1A_TOOLS, TOOLS } from './registry.js';

/** 06 §2.0, the M1a rows: [readOnly, destructive, idempotent, openWorld]. */
const M1A_TABLE: Readonly<Record<string, readonly [boolean, boolean, boolean, boolean]>> = {
  agentlink_status: [true, false, true, true],
  // W4-SHORT-INVITE (D-139): creating an invite uploads the encrypted invite to the drop.
  agentlink_create_invite: [false, false, false, true],
  agentlink_accept_invite: [false, false, false, true],
  agentlink_list_contacts: [true, false, true, false],
  agentlink_send: [false, false, false, true],
  agentlink_propose_terms: [false, false, false, true],
  agentlink_respond_to_terms: [false, false, false, true],
  agentlink_inbox: [false, false, false, true],
  agentlink_get_approval: [true, false, true, false],
};

/** 06 §2.0, the M1b rows (M1-9d-1: files; M1-9d-2: the proof tools). */
const M1B_TABLE: Readonly<Record<string, readonly [boolean, boolean, boolean, boolean]>> = {
  agentlink_fetch_file: [false, false, false, true],
  agentlink_notarize: [false, false, false, true],
  agentlink_acknowledge: [false, false, false, true],
  agentlink_get_proof: [true, false, true, true],
  agentlink_export_proof_pack: [false, false, false, false],
  agentlink_verify_proof_pack: [true, false, true, true],
};
const TABLE = { ...M1A_TABLE, ...M1B_TABLE };

/** The only path- or file-like arguments, each confined by 04 §4 (tool-surface.test.ts allowlist). */
const FILE_ARGS: Readonly<Record<string, readonly string[]>> = {
  agentlink_send: ['path'],
  agentlink_fetch_file: ['fileIndex'],
  // D-87: a pack file inside proofs.exportFolder or files.inboxFolder only.
  agentlink_verify_proof_pack: ['path'],
  // 06 §2.4: the message's content key goes into the pack only with the owner's approval
  // (`proofs.allowKeyDisclosure`, never `allow`); no agent key is ever exported.
  agentlink_export_proof_pack: ['includeContentKey'],
};

/**
 * The one name the danger rule would flag, fixed by the 06 §2.0 table (D-53): it saves a proof pack
 * of the agent's own record and exports no key (see tool-surface.test.ts NAME_ALLOWLIST).
 */
const NAME_EXCEPTIONS: readonly string[] = ['agentlink_export_proof_pack'];

describe('tool surface (06 §2.0, D-53)', () => {
  it('matches the committed snapshot', () => {
    expect(TOOLS).toMatchSnapshot();
  });

  it('registers exactly the nine M1a tools and the six M1b tools', () => {
    const registered = TOOLS.map((t) => t.name);
    expect([...registered, ...Object.keys(PENDING_M1A_TOOLS)].sort()).toEqual(
      Object.keys(TABLE).sort(),
    );
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('every name is a 06 §2.0 name with the agentlink_ prefix', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^agentlink_[a-z_]+$/);
      expect(MCP_TOOL_NAMES).toContain(tool.name);
    }
  });

  it('sets all four annotations exactly per the 06 §2.0 table', () => {
    for (const tool of TOOLS) {
      const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = TABLE[tool.name]!;
      expect(tool.annotations, tool.name).toStrictEqual({
        readOnlyHint,
        destructiveHint,
        idempotentHint,
        openWorldHint,
      });
    }
  });

  it('every tool with an Approval entry accepts approvalId, and only those tools', () => {
    for (const tool of TOOLS) {
      const approval = (APPROVAL_TOOL_NAMES as readonly string[]).includes(tool.name);
      expect(tool.approval, tool.name).toBe(approval);
      const input = tool.inputSchema['properties'] as Record<string, unknown>;
      const out = tool.outputSchema['properties'] as Record<string, unknown>;
      // agentlink_get_approval takes an approvalId to read, not to proceed with.
      expect('approvalId' in input, tool.name).toBe(
        approval || tool.name === 'agentlink_get_approval',
      );
      expect('approvalId' in out, tool.name).toBe(approval);
    }
  });

  it('declares strict object input and output schemas with the common result fields', () => {
    for (const tool of TOOLS) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        expect(schema['type']).toBe('object');
        expect(schema['additionalProperties']).toBe(false);
      }
      expect(tool.outputSchema['required']).toEqual(['status', 'summary']);
      for (const field of ['status', 'summary', 'nextStep', 'url', 'code']) {
        expect(tool.outputSchema['properties']).toHaveProperty(field);
      }
    }
  });

  it('bounds clientRequestId to 1..256 (07 §3.3; IR-M1-7e-1 F02, schema part)', () => {
    for (const tool of TOOLS) {
      const input = tool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
      if (input['clientRequestId'] === undefined) continue;
      expect(input['clientRequestId']).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 256,
      });
    }
  });

  it('no tool changes policies, keys, storage credentials, approvals, files or hooks (I-4)', () => {
    const dangerous =
      /policy|policies|export|key|credential|storage|approve|decide|hook|config|block|ignore|request_accept/i;
    for (const tool of TOOLS) {
      if (!NAME_EXCEPTIONS.includes(tool.name)) expect(tool.name).not.toMatch(dangerous);
      const allowed = FILE_ARGS[tool.name] ?? [];
      const input = Object.keys(tool.inputSchema['properties'] as object)
        .filter((arg) => !allowed.includes(arg))
        .join(' ');
      expect(input).not.toMatch(/policy|path|file|key|credential|signed|hook/i);
    }
    expect(TOOLS.filter((t) => t.annotations.destructiveHint)).toEqual([]);
  });

  it('the terms tools take TermsInput and never a free body (D-55)', () => {
    for (const name of ['agentlink_propose_terms', 'agentlink_respond_to_terms']) {
      const tool = TOOLS.find((t) => t.name === name)!;
      const props = tool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
      expect(props['terms']?.['additionalProperties'], name).toBe(false);
      expect(props).not.toHaveProperty('body');
      expect(props).not.toHaveProperty('text');
    }
  });

  it('agentlink_send cannot carry offer, accept or reject (D-55)', () => {
    const send = TOOLS.find((t) => t.name === 'agentlink_send')!;
    const props = send.inputSchema['properties'] as Record<string, { enum?: string[] }>;
    expect(props['type']?.enum).toEqual(['text', 'note', 'request', 'delivery']);
    // M1-9d-1: `path` attaches one file (06 §2.3); M1-9d-2: `notarize` (06 §2.2).
    expect(props['path']).toMatchObject({ type: 'string', minLength: 1 });
    expect(props['notarize']).toEqual({ type: 'boolean' });
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(TOOLS)).toBe(true);
    for (const tool of TOOLS) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.inputSchema)).toBe(true);
      expect(Object.isFrozen(tool.annotations)).toBe(true);
    }
  });
});
