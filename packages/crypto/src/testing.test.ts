// IR-M1-1g-1 M-2: the in-memory KeyStores are reachable only through the test-only subpath
// @agentlink/crypto/testing, which tools/deps-check allows only in test files.
import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import * as keystore from './keystore.js';
import * as testing from './testing.js';

const TEST_ONLY = ['MemoryKeyStore', 'MemoryOwnerKeyStore'];

describe('@agentlink/crypto/testing', () => {
  it('exports exactly the in-memory KeyStores', () => {
    expect(Object.keys(testing).sort()).toEqual([...TEST_ONLY].sort());
  });

  it('is the only entry that has them', () => {
    for (const name of TEST_ONLY) {
      expect(Object.keys(main), name).not.toContain(name);
      expect(Object.keys(keystore), name).not.toContain(name);
    }
  });

  it('is a package subpath of its own', async () => {
    const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      default: './dist/testing.js',
    });
  });
});
