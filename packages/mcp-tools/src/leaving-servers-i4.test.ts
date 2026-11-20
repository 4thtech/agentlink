// M1-7j (S2; D-158 (6); 07 §4.3; I-4): no MCP tool or AI path changes the own server list, the
// leaving servers (`identity.prev_relays`) or the announce choice (`identity.announce_default`), and
// none can produce an owner-channel `card-update`. They change only through the owner's rotation
// with presence and an owner signature (04 §2.6), in core flows.
// - No tool input names servers, relays, the leaving servers, the announce choice or a card-update,
//   and every tool refuses an argument that carries them (inputs are strict).
// - The handlers' client surface has nothing that rotates, signs a card, changes a list, prunes or
//   announces (the typecheck fails otherwise).
import { describe, expect, it } from 'vitest';
import type { ToolClient } from './context.js';
import { matchesSchema } from './input.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';

type ServerMember = Extract<
  keyof ToolClient,
  | 'identity'
  | 'rotate'
  | 'cardUpdates'
  | 'sendCardUpdates'
  | 'announceToOwner'
  | 'leavingServers'
  | 'pruneLeavingServers'
  | 'announceDefault'
  | 'relays'
  | 'outbox'
>;
const noServerMember: [ServerMember] extends [never] ? true : false = true;

const SAMPLES: readonly Record<string, unknown>[] = [
  { relays: ['wss://relay.example.org', 'wss://relay2.example.org'] },
  { prevRelays: [{ url: 'wss://relay.example.org', until: 1 }] },
  { prev_relays: [] },
  { announceDefault: false },
  { announce_default: 0 },
  { servers: ['wss://relay.example.org'] },
  { type: 'card-update' },
];

describe('no MCP tool changes the servers, the leaving servers or the announce choice (M1-7j, I-4)', () => {
  it('no tool input names them or a card-update', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/relay|prev|announce|server|card-?update|rotat/i);
    }
  });

  it('every tool refuses an argument that carries them (strict inputs)', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      for (const sample of SAMPLES) {
        expect(matchesSchema(tool.inputSchema, sample), tool.name).toBe(false);
      }
    }
  });

  it('ToolClient has no rotate, card, list, prune or announce member (checked by the typecheck too)', () => {
    expect(noServerMember).toBe(true);
  });
});
