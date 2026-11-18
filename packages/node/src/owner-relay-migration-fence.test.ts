// REL-0513-FENCE (I-4; 04 §2.5, §2.6): the package entry's `updateContactDetailsAtTerminal` is the
// owner-terminal path only, like performOwnerOperation, changeOwnerCode and restoreInTerminal: it
// takes no owner-store or terminal seam and hardwires the OS keychain and this process's own TTY
// prompt. Same-process code cannot hand it a fake store or terminal (with the exported epochKeysOf
// token) to reach the epoch advance without the owner's gesture. The seam variant
// (updateContactDetailsWith) stays inside the package.
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';
import { updateContactDetailsAtTerminal } from './index.js';
import { HARNESS_MARKERS } from './owner-terminal.js';

describe('updateContactDetailsAtTerminal takes no seams (fence)', () => {
  it('ignores a store and a terminal passed in, and never reaches them', async () => {
    const touched: string[] = [];
    const terminal = {
      write: () => void touched.push('terminal.write'),
      readSecret: () => {
        touched.push('terminal.readSecret');
        return Promise.resolve(new Uint8Array(4));
      },
      confirm: () => {
        touched.push('terminal.confirm');
        return Promise.resolve(true);
      },
    };
    const store = {
      secretKind: () => {
        touched.push('store.secretKind');
        return Promise.resolve(1);
      },
      unlock: () => {
        touched.push('store.unlock');
        return Promise.reject(new Error('fake'));
      },
      lock: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const client = {
      identity: {
        relayMigration: () => {
          touched.push('relayMigration');
          return Promise.resolve({
            status: 'needed',
            relays: ['wss://a.example', 'wss://b.example'],
          });
        },
      },
    };
    const input = {
      agent: '0x' + '11'.repeat(20),
      client,
      epochKeys: {},
      ownerKeys: {
        ownerEvm: new Uint8Array(20),
        ownerNostr: new Uint8Array(32),
        ownerEnc: new Uint8Array(32),
      },
      store,
      terminal,
    } as unknown as Parameters<typeof updateContactDetailsAtTerminal>[0];
    // No AI-harness marker (so the seam, not the marker, is what is tested) and no TTY here: the
    // real terminal path refuses before anything passed in is used.
    const saved = HARNESS_MARKERS.map((name) => [name, process.env[name]] as const);
    for (const name of HARNESS_MARKERS) Reflect.deleteProperty(process.env, name);
    try {
      await expect(updateContactDetailsAtTerminal(input)).rejects.toMatchObject({
        code: 'owner_prompt_unavailable',
      });
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
    expect(touched.filter((t) => t.startsWith('terminal.') || t.startsWith('store.'))).toEqual([]);
  });

  it('the seam variant and the signing pieces are not package exports', () => {
    const names = Object.keys(entry);
    for (const name of ['updateContactDetailsWith', 'signRelayMigration', 'RelayCardSession']) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain('updateContactDetailsAtTerminal');
  });
});
