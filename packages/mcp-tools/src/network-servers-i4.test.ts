// NET-OWNER-SET (S2; D-158 (6); 07 §4.3 "Use your own servers"; 06 §4; I-4): an I-4 canary. Saving
// your own server list, a reset to the automatic servers and the announce choice are owner
// operations with presence, reached only from the app's Advanced › Message network and the owner's
// terminal. No MCP tool, tool argument, tool description, fixed text or `nextStep` names or starts
// them, and the tools' client surface has nothing that could.
import { describe, expect, it } from 'vitest';
import { ACK_TEXT } from './acknowledge.js';
import type { ToolClient } from './context.js';
import { EXPORT_TEXT } from './export-proof-pack.js';
import { FETCH_FILE_TEXT } from './fetch-file.js';
import { FILE_TEXT } from './files-common.js';
import { GET_PROOF_TEXT } from './get-proof.js';
import { INBOX_TEXT } from './inbox.js';
import { matchesSchema } from './input.js';
import { INVITE_TEXT } from './invite-common.js';
import { PROOF_TEXT } from './proofs-common.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';
import { RESULT_TEXT } from './result.js';
import { SEND_TEXT } from './send.js';
import { en } from './strings/en.js';
import { TERMS_TEXT } from './terms-common.js';
import { TOOL_TEXT } from './text.js';
import { VERIFY_TEXT } from './verify-proof-pack.js';

/** Every fixed string of the tools' text tables (summaries, nextStep, copy), with where it is. */
function strings(value: unknown, at: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([at, value]);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) strings(v, `${at}.${key}`, out);
  }
  return out;
}
const TABLES = {
  ACK_TEXT,
  EXPORT_TEXT,
  FETCH_FILE_TEXT,
  FILE_TEXT,
  GET_PROOF_TEXT,
  INBOX_TEXT,
  INVITE_TEXT,
  PROOF_TEXT,
  RESULT_TEXT,
  SEND_TEXT,
  TERMS_TEXT,
  TOOL_TEXT,
  VERIFY_TEXT,
  en,
};

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

  it('no fixed summary, nextStep or copy string names the routes or the owner pieces', () => {
    const all = Object.entries(TABLES).flatMap(([name, table]) => strings(table, name));
    expect(all.length).toBeGreaterThan(100);
    for (const [at, text] of all) expect(text, at).not.toMatch(FORBIDDEN);
  });

  it('ToolClient has no member that changes servers (checked by the typecheck too)', () => {
    expect(noChangeMember).toBe(true);
  });
});
