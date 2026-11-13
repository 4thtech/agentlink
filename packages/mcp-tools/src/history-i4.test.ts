// RET-3 (S2; D-148; 04 §4.2; 06 §1; I-4): deleting history is the owner's, in the app. No MCP tool
// deletes anything, moves a file to the Trash, or names history retention. RET-7: the one tool that
// touches the subject, `agentlink_tidy`, only proposes (pending_approval); its client surface counts
// and never applies.
import { describe, expect, it } from 'vitest';
import type { ToolClient } from './context.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

// IR-RET-3-1 Info 15: the handlers' client surface has no history member (fails the typecheck).
type NoHistory = Extract<
  keyof ToolClient,
  'history' | 'deleteHistory' | 'trash' | 'applyTidy' | 'tidy' | 'tidyApply'
>;
const noHistory: [NoHistory] extends [never] ? true : false = true;

// RET-7: the preview answers counts and sizes only: never a plan, its hash or message IDs.
type Preview = Awaited<ReturnType<NonNullable<ToolClient['tidyPreview']>>>;
type PlanLeak = Extract<keyof Preview, 'planHash' | 'envelopeIds' | 'savedFiles' | 'input'>;
const noPlanLeak: [PlanLeak] extends [never] ? true : false = true;

describe('no MCP tool deletes history (I-4, 06 §1)', () => {
  it('no tool is named for deleting or trashing; only agentlink_tidy names tidying', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/delete|trash|purge|erase|remove|history/i);
      if (tool.name !== 'agentlink_tidy') expect(tool.name).not.toMatch(/tidy/i);
    }
  });

  it('no tool input names history, envelope lists or retention', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/history|envelopeIds|keepDays|trash/i);
    }
  });

  it('ToolClient has no history or apply member; the preview leaks no plan (typecheck too)', () => {
    expect(noHistory).toBe(true);
    expect(noPlanLeak).toBe(true);
  });
});
