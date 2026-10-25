// M1-26-b (D-40, 02 F-51, 06 §2.1, §2.4, 11 §5.1): the fixed text of every tool, the copy sheet
// and the registry name no network or fee token and never ask for a chain. Values from a result
// are scanned in proofs.test.ts (every proof tool result) and the surface in
// test/tool-surface.test.ts (output fields only under `advanced`, the one `chain?` override).
import { describe, expect, it } from 'vitest';
import { ACK_TEXT } from './acknowledge.js';
import { EXPORT_TEXT } from './export-proof-pack.js';
import { FETCH_FILE_TEXT } from './fetch-file.js';
import { FILE_TEXT } from './files-common.js';
import { GET_PROOF_TEXT } from './get-proof.js';
import { INBOX_TEXT } from './inbox.js';
import { INVITE_TEXT } from './invite-common.js';
import { PROOF_TEXT } from './proofs-common.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';
import { RESULT_TEXT } from './result.js';
import { SEND_TEXT } from './send.js';
import { en } from './strings/en.js';
import { TERMS_TEXT } from './terms-common.js';
import { TOOL_TEXT } from './text.js';
import { VERIFY_TEXT } from './verify-proof-pack.js';

const NETWORK_NAMES =
  /\b(chains?|on-chain|blockchain|base|sepolia|gnosis|chiado|usdc|usdt|xdai)\b/i;

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

describe('no network name or chain prompt in any tool text (M1-26-b)', () => {
  it('every fixed summary, nextStep and copy string names no network or fee token', () => {
    const all = Object.entries(TABLES).flatMap(([name, table]) => strings(table, name));
    expect(all.length).toBeGreaterThan(100);
    for (const [at, text] of all) expect(text, at).not.toMatch(NETWORK_NAMES);
  });

  it('M1-36h: no tool takes a chain by default; only the Advanced agentlink_notarize does, optional', () => {
    for (const tool of TOOLS) {
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props, tool.name).not.toContain('chain');
      expect(`${tool.title} ${tool.description}`, tool.name).not.toMatch(NETWORK_NAMES);
      expect(`${tool.title} ${tool.description}`, tool.name).not.toMatch(/\bchains?\b/i);
    }
    for (const tool of ADVANCED_TOOLS) {
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      if (tool.name === 'agentlink_notarize') {
        expect(props).toContain('chain');
        expect(required).not.toContain('chain');
        expect(tool.description).toMatch(/picks where to record it automatically/);
        expect(tool.description).toMatch(/Leave chain out unless the user explicitly asks/);
      } else {
        expect(props, tool.name).not.toContain('chain');
        expect(`${tool.title} ${tool.description}`, tool.name).not.toMatch(NETWORK_NAMES);
      }
    }
  });
});
