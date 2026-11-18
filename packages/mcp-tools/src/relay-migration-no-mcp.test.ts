// RELAY-CARD-MIGRATION (I-4; 04 §2.5, §2.6): no MCP tool triggers or approves "Update your contact
// details". The migration is a rotation signed with owner presence in an owner surface only (the
// app's presence gate or `agentlink owner update-contact-details`); no tool names it, and no tool
// source reaches the rotation, the relay migration or the card-update sender.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('no MCP path to the relay migration (I-4)', () => {
  it('no tool is named for it', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/relay|migrat|contact_details|rotate/i);
    }
  });

  it('no tool source calls the rotation, the migration or the card-update sender', () => {
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /relayMigration|signRelayMigration|updateContactDetails|identity\.rotate|sendCardUpdates/,
      );
    }
  });
});
