// NET-OWNER-SET (S2; D-158 (6); 07 §4.3 "Use your own servers"; 06 §4; I-4): an I-4 canary. Saving
// your own server list, a reset to the automatic servers and the announce choice are owner
// operations with presence, reached only from the app's Advanced › Message network and the owner's
// terminal. No MCP tool, tool argument, tool description, fixed text or `nextStep` names or starts
// them, and the tools' client surface has nothing that could.
import { describe, expect, it } from 'vitest';
import type { ToolClient } from './context.js';
import { matchesSchema } from './input.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

// IR L2: the full scan of every source of this package (all text tables, strings/privacy.ts, inline
// strings, tables added later) and of the CLI's MCP server is packages/node/src/
// network-servers-i4-scan.test.ts (a Node package; this one may not read files).

/** The server-list change's routes, owner pieces and words (never in a tool). */
const FORBIDDEN =
  /\/api\/ui\/network\/(servers|reset|announce|progress)|changeServers|signServerChange|serverList|owner servers|use your own servers|automatic servers/i;

type ChangeMember = Extract<
  keyof ToolClient,
  'changeServers' | 'serverList' | 'network' | 'resetServers' | 'identity' | 'cardUpdates'
>;
const noChangeMember: [ChangeMember] extends [never] ? true : false = true;

describe('no MCP path to a server-list change (NET-OWNER-SET, I-4)', () => {
  it('no tool name, title, description or input schema names it', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const text = `${tool.name} ${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
      expect(text, tool.name).not.toMatch(FORBIDDEN);
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(
        /automatic|announce|servers/i,
      );
    }
  });

  it('every tool refuses the change body as an argument (strict inputs)', () => {
    const bodies = [
      { servers: ['wss://a.example.org', 'wss://b.example.org'], automatic: false, announce: true },
      { servers: ['wss://a.example.org'], review: true },
      { automatic: true },
      { announce: false },
    ];
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      for (const body of bodies)
        expect(matchesSchema(tool.inputSchema, body), tool.name).toBe(false);
    }
  });

  it('ToolClient has no member that changes servers (checked by the typecheck too)', () => {
    expect(noChangeMember).toBe(true);
  });
});
