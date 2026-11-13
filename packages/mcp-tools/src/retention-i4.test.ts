// RET-6 (S2; D-148; 04 §4.2 "Retention policy"; 06 §1, §3; I-4): no MCP tool can change
// `history.messagesKeepDays` or `history.filesKeepDays`. They change only through an owner-signed
// `policy.set` from Settings › Storage, with presence.
// - No tool input names the keys, `history`, a policy or retention, and every tool refuses an argument
//   that carries them (inputs are strict).
// - The handlers' client surface has nothing that loads, prepares, signs or applies a policy, or runs
//   or previews the retention pass (the typecheck fails otherwise).
import { describe, expect, it } from 'vitest';
import type { ToolClient } from './context.js';
import { matchesSchema } from './input.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

type PolicyMember = Extract<
  keyof ToolClient,
  | 'policy'
  | 'ownerActions'
  | 'setPolicy'
  | 'applyPolicy'
  | 'preparePolicyEdit'
  | 'historyRetention'
  | 'retention'
>;
const noPolicyMember: [PolicyMember] extends [never] ? true : false = true;

const SAMPLES: readonly Record<string, unknown>[] = [
  { history: { messagesKeepDays: 0, filesKeepDays: 1 } },
  { messagesKeepDays: 90 },
  { filesKeepDays: 30 },
  { policy: { history: { filesKeepDays: 30 } } },
];

describe('no MCP tool changes history retention (RET-6, I-4)', () => {
  it('no tool input names the history keys, a policy or retention', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/keepDays|retention|policy|history/i);
    }
  });

  it('every tool refuses an argument that carries them (strict inputs)', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      for (const sample of SAMPLES) {
        expect(matchesSchema(tool.inputSchema, sample), tool.name).toBe(false);
      }
    }
  });

  it('ToolClient has no policy or retention member (checked by the typecheck too)', () => {
    expect(noPolicyMember).toBe(true);
  });
});
