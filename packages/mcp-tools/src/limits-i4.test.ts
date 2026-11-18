// SEC-HARD-CEILING and SEC-OUTBOUND-CAPS (D-156; 06 §1; I-4): the hard proof ceilings and the
// outgoing caps are the owner's, changed only by an owner-signed `policy.set` from the app's Rules
// page. No MCP tool names them, takes them as input, or reaches a policy write.
import { describe, expect, it } from 'vitest';
import type { ToolClient } from './context.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

// The handlers' client surface has no policy or owner-action member (fails the typecheck).
type NoPolicyWrite = Extract<
  keyof ToolClient,
  'policy' | 'ownerActions' | 'applyOwnerAction' | 'setPolicy' | 'prepareEdit' | 'setLimits'
>;
const noPolicyWrite: [NoPolicyWrite] extends [never] ? true : false = true;

describe('no MCP tool changes the limits (I-4)', () => {
  it('no tool is named for limits, ceilings, budgets or rules', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/limit|ceiling|budget|policy|rule|cap/i);
    }
  });

  it('no tool input names a limit field', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(
        /hardMaxPerActionUSD|hardDailyUSD|perActionMaxUSD|dailyBudgetUSD|outgoing|PerDay|PerContact/i,
      );
    }
  });

  it('ToolClient has no policy write member (typecheck too)', () => {
    expect(noPolicyWrite).toBe(true);
  });
});
