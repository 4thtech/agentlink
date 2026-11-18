// RELAY-CARD-MIGRATION (I-4; 04 §2.5, §2.6): no MCP tool triggers or approves "Update your contact
// details". The migration is a rotation signed with owner presence in an owner surface only (the
// app's presence gate or `agentlink owner update-contact-details`); no tool names it, and neither
// the tool sources nor the CLI's MCP server reach the rotation, the migration or the card-update
// sender.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVANCED_TOOLS, TOOLS } from '@4thtech-io/mcp-tools/registry.js';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_TOOLS_SRC = join(HERE, '..', '..', '..', 'packages', 'mcp-tools', 'src');
const CLI_MCP_SRC = join(HERE, '..', 'src', 'mcp');

function sources(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('no MCP path to the relay migration (I-4)', () => {
  it('no tool is named for it', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/relay|migrat|contact_details|rotate/i);
    }
  });

  it('no tool source and no MCP server source calls the rotation or the migration', () => {
    const files = [...sources(MCP_TOOLS_SRC), ...sources(CLI_MCP_SRC)];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /relayMigration|signRelayMigration|updateContactDetails|identity\.rotate\(/,
      );
    }
  });
});
