// RET-3 (S2; D-148; 04 §4.2; 06 §1; I-4): deleting history is the owner's, in the app. No MCP tool
// deletes anything, moves a file to the Trash, or names history retention (RET-7's proposing
// `agentlink_tidy` needs its own spec PR and Fable review).
import { describe, expect, it } from 'vitest';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

describe('no MCP tool deletes history (I-4, 06 §1)', () => {
  it('no tool is named for deleting, trashing or tidying', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/delete|trash|tidy|purge|erase|remove|history/i);
    }
  });

  it('no tool input names history, envelope lists or retention', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/history|envelopeIds|keepDays|trash/i);
    }
  });
});
