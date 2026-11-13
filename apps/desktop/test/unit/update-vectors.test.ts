// UPD-1: the app's verdict on every document of the shared `desktop-update` vectors (format v2, one
// pinned update key), generated independently in Python (tools/vectors/generate_desktop_update.py).
// The cross-runtime harness checks the same file's BIP-340 messages and signatures through
// @4thtech-io/crypto; here the app's own parser and acceptance rules (src/main/updater/manifest.ts)
// must agree with them and give the verdict this table states. The vectors are only read.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeHex } from '@4thtech-io/crypto';
import {
  UpdateRefusal,
  acceptManifest,
  manifestMessage,
  parseUpdateDocument,
  pinnedRoot,
  type AssetKind,
  type Channel,
  type PinnedRoot,
} from '../../src/main/updater/manifest.js';

interface VectorCase {
  readonly id: string;
  readonly input: {
    readonly tag: string;
    readonly document: Record<string, unknown> & { readonly sig: string };
    readonly signer: string;
  };
  readonly expected: { readonly message: string; readonly valid: 'true' | 'false' };
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../../test-vectors/desktop-update/vectors.json', import.meta.url),
    'utf8',
  ),
) as { suite: string; cases: VectorCase[] };
const byId = new Map(file.cases.map((c) => [c.id, c]));
const vector = (id: string): VectorCase => {
  const c = byId.get(id);
  if (c === undefined) throw new Error(`no vector ${id}`);
  return c;
};

const NOW = Date.parse('2026-11-13T12:00:00Z');
const PINNED = pinnedRoot({
  rootPublicKey: vector('manifest-beta-ok').input.signer,
  minimumStatementSequence: 0,
}) as PinnedRoot;
const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

interface Ctx {
  channel?: Channel;
  kind?: AssetKind;
  arch?: string;
  currentVersion?: string;
  failedVersion?: string | null;
  root?: PinnedRoot;
}

/** Parses as the app does, then accepts; returns a short verdict. */
function verdict(id: string, c: Ctx = {}): string {
  try {
    const accepted = acceptManifest(parseUpdateDocument(enc(vector(id).input.document)), {
      root: c.root ?? PINNED,
      currentVersion: c.currentVersion ?? '0.5.2',
      channel: c.channel ?? 'beta',
      platform: 'darwin',
      arch: c.arch ?? 'arm64',
      kind: c.kind ?? 'zip',
      failedVersion: c.failedVersion ?? null,
      now: NOW,
    });
    return `accepted ${accepted.version} ${accepted.asset.url.split('/').pop() ?? ''}`;
  } catch (error) {
    if (error instanceof UpdateRefusal) return error.code;
    throw error;
  }
}

describe('shared desktop-update vectors (format v2, one pinned key)', () => {
  it('is the desktop-update suite and every case is covered by the table below', () => {
    expect(file.suite).toBe('desktop-update');
    expect([...byId.keys()].sort()).toEqual(
      [
        'manifest-beta-ok',
        'manifest-claims-pinned-key',
        'manifest-downgrade',
        'manifest-expired',
        'manifest-other-key',
        'manifest-other-key-under-pinned',
        'manifest-stable-ok',
        'manifest-tampered',
        'manifest-v1',
        'manifest-v2-under-v1-tag',
      ].sort(),
    );
  });

  it('the app computes the same BIP-340 message as the independent generator (v2 tag)', () => {
    let checked = 0;
    for (const c of file.cases) {
      if (c.input.tag !== c.input.document['domain'] || c.input.tag.endsWith('/v1')) continue;
      expect(encodeHex(manifestMessage(parseUpdateDocument(enc(c.input.document)))), c.id).toBe(
        c.expected.message,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it('accepted: the zip for this Mac; dmg and x64 pick their own asset', () => {
    expect(verdict('manifest-beta-ok')).toBe('accepted 0.5.3 AgentLink-0.5.3-arm64.zip');
    expect(verdict('manifest-beta-ok', { kind: 'dmg' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.dmg',
    );
    expect(verdict('manifest-beta-ok', { arch: 'x64' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-x64.zip',
    );
    expect(verdict('manifest-stable-ok', { channel: 'stable' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.zip',
    );
  });

  it('every refusal of the v2 list', () => {
    expect(verdict('manifest-v1')).toBe('old_format');
    expect(verdict('manifest-expired')).toBe('expired');
    expect(verdict('manifest-stable-ok')).toBe('wrong_channel');
    expect(verdict('manifest-beta-ok', { channel: 'stable' })).toBe('wrong_channel');
    expect(verdict('manifest-downgrade')).toBe('not_newer');
    expect(verdict('manifest-beta-ok', { currentVersion: '0.5.3' })).toBe('not_newer');
    expect(verdict('manifest-beta-ok', { failedVersion: '0.5.3' })).toBe('failed_version');
    expect(verdict('manifest-beta-ok', { failedVersion: '0.5.4' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.zip',
    );
    expect(verdict('manifest-beta-ok', { arch: 'ia32' })).toBe('no_asset_for_this_computer');
    expect(verdict('manifest-other-key')).toBe('wrong_key');
    expect(verdict('manifest-claims-pinned-key')).toBe('bad_signature');
    expect(verdict('manifest-tampered')).toBe('bad_signature');
    // A release that pins a new key: manifests by the old key are refused from then on.
    const repinned = pinnedRoot({
      rootPublicKey: vector('manifest-other-key').input.signer,
      minimumStatementSequence: 0,
    }) as PinnedRoot;
    expect(verdict('manifest-beta-ok', { root: repinned })).toBe('wrong_key');
    expect(verdict('manifest-other-key', { root: repinned })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.zip',
    );
  });

  it('agrees with the generator on validity under the pinned key', () => {
    for (const id of ['manifest-beta-ok', 'manifest-stable-ok', 'manifest-downgrade']) {
      expect(vector(id).expected.valid, id).toBe('true');
    }
    for (const id of ['manifest-claims-pinned-key', 'manifest-tampered', 'manifest-other-key-under-pinned']) {
      expect(vector(id).expected.valid, id).toBe('false');
    }
  });
});
