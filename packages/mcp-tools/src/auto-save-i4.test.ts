// W4-AUTO-SAVE (S2; D-142; 06 §2.3; I-4): the tool surface does not change. No tool turns
// auto-save on or off, changes the Inbox folder or its limits, or sets "Ask before saving";
// `agentlink_fetch_file` keeps its schema.
import { describe, expect, it } from 'vitest';
import { ADVANCED_TOOLS, TOOLS, findTool } from './registry.js';

describe('no MCP tool changes an auto-save setting (I-4)', () => {
  it('no tool input names autoSave, askBeforeSaving or the Inbox folder', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/autoSave|askBeforeSaving|inboxFolder|policy\.set/i);
    }
  });

  it('agentlink_fetch_file keeps exactly {envelopeId, fileIndex?}', () => {
    const tool = findTool('agentlink_fetch_file');
    const props = Object.keys(
      (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(props).toEqual(['envelopeId', 'fileIndex']);
  });
});
