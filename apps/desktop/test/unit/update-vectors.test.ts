// UPD-1: the app's verdict on every document of the shared `desktop-update` vectors (format v2),
// generated independently in Python (tools/vectors/generate_desktop_update.py). The cross-runtime
// harness checks the same file's BIP-340 messages and signatures through @4thtech-io/crypto; here the
// app's own parser and acceptance rules (src/main/updater/manifest.ts) must agree with them and give
// the verdict this table states. The vectors are only read, never written.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeHex } from '@4thtech-io/crypto';
import {
  INITIAL_KEY_STATE,
  UpdateRefusal,
  acceptManifest,
  applyStatement,
  manifestMessage,
  parseUpdateDocument,
  pinnedRoot,
  statementMessage,
  type AssetKind,
  type Channel,
  type KeyState,
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
  readFileSync(new URL('../../../../test-vectors/desktop-update/vectors.json', import.meta.url), 'utf8'),
) as { suite: string; cases: VectorCase[] };
const byId = new Map(file.cases.map((c) => [c.id, c]));
const vector = (id: string): VectorCase => {
  const c = byId.get(id);
  if (c === undefined) throw new Error(`no vector ${id}`);
  return c;
};

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ROOT = pinnedRoot({
  rootPublicKey: vector('statement-introduce-beta').input.signer,
  minimumStatementSequence: 0,
}) as PinnedRoot;
const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

interface Ctx {
  channel?: Channel;
  kind?: AssetKind;
  arch?: string;
  currentVersion?: string;
  failedVersion?: string | null;
  state?: KeyState;
}

/** Parses as the app does, then applies or accepts; returns a short verdict. */
function verdict(id: string, c: Ctx = {}): string {
  const channel = c.channel ?? 'beta';
  try {
    const doc = parseUpdateDocument(enc(vector(id).input.document));
    if (doc.kind === 'statement') {
      const s = applyStatement(c.state ?? INITIAL_KEY_STATE, doc.statement, ROOT, NOW, channel);
      return s.updateKey === null ? `revoked#${s.sequence}` : `key#${s.sequence}`;
    }
    const accepted = acceptManifest(doc.manifest, {
      root: ROOT,
      state: c.state ?? INITIAL_KEY_STATE,
      currentVersion: c.currentVersion ?? '0.5.2',
      channel,
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

describe('shared desktop-update vectors (format v2)', () => {
  it('is the desktop-update suite and every case is covered by the table below', () => {
    expect(file.suite).toBe('desktop-update');
    expect([...byId.keys()].sort()).toEqual(
      [
        'manifest-beta-ok',
        'manifest-beta-renewed',
        'manifest-downgrade',
        'manifest-stable-by-beta-key',
        'manifest-stable-ok',
        'manifest-statement-expired',
        'manifest-tampered',
        'manifest-v1',
        'manifest-v2-under-v1-tag',
        'statement-expired-beta',
        'statement-introduce-beta',
        'statement-introduce-stable',
        'statement-renew-beta',
        'statement-revoke-beta',
        'statement-under-update-key',
        'statement-v2-under-v1-tag',
      ].sort(),
    );
  });

  it('the app computes the same BIP-340 message as the independent generator (v2 tags)', () => {
    for (const c of file.cases) {
      const doc = c.input.document;
      if (c.input.tag !== doc['domain']) continue; // cross-tag cases: checked by the harness
      const parsed = parseUpdateDocument(enc(doc));
      const message =
        parsed.kind === 'statement'
          ? statementMessage(parsed.statement)
          : manifestMessage(parsed.manifest);
      expect(encodeHex(message), c.id).toBe(c.expected.message);
    }
  });

  it('statements: channel-bound, renew and revoke apply, an expired one is still adopted', () => {
    expect(verdict('statement-introduce-beta')).toBe('key#1');
    expect(verdict('statement-renew-beta')).toBe('key#2');
    expect(verdict('statement-revoke-beta')).toBe('revoked#4');
    expect(verdict('statement-expired-beta')).toBe('key#5');
    expect(verdict('statement-introduce-stable')).toBe('wrong_channel');
    expect(verdict('statement-introduce-stable', { channel: 'stable' })).toBe('key#3');
    expect(verdict('statement-introduce-beta', { channel: 'stable' })).toBe('wrong_channel');
  });

  it('manifests: the zip for this Mac is accepted; dmg and x64 pick their own asset', () => {
    expect(verdict('manifest-beta-ok')).toBe('accepted 0.5.3 AgentLink-0.5.3-arm64.zip');
    expect(verdict('manifest-beta-ok', { kind: 'dmg' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.dmg',
    );
    expect(verdict('manifest-beta-ok', { arch: 'x64' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-x64.zip',
    );
    expect(verdict('manifest-beta-renewed')).toBe('accepted 0.5.3 AgentLink-0.5.3-arm64.zip');
    expect(verdict('manifest-stable-ok', { channel: 'stable' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.zip',
    );
  });

  it('manifests: every refusal of the v2 list', () => {
    expect(verdict('manifest-v1')).toBe('old_format');
    expect(verdict('manifest-statement-expired')).toBe('statement_expired');
    expect(verdict('manifest-stable-by-beta-key')).toBe('wrong_channel');
    expect(verdict('manifest-stable-by-beta-key', { channel: 'stable' })).toBe('wrong_channel');
    expect(verdict('manifest-stable-ok')).toBe('wrong_channel');
    expect(verdict('manifest-downgrade')).toBe('not_newer');
    expect(verdict('manifest-beta-ok', { currentVersion: '0.5.3' })).toBe('not_newer');
    expect(verdict('manifest-beta-ok', { failedVersion: '0.5.3' })).toBe('failed_version');
    expect(verdict('manifest-beta-ok', { failedVersion: '0.5.4' })).toBe(
      'accepted 0.5.3 AgentLink-0.5.3-arm64.zip',
    );
    expect(verdict('manifest-beta-ok', { arch: 'ia32' })).toBe('no_asset_for_this_computer');
    expect(verdict('manifest-tampered')).toBe('bad_signature');
    const revoked = applyStatement(
      INITIAL_KEY_STATE,
      (parseUpdateDocument(enc(vector('statement-revoke-beta').input.document)) as {
        kind: 'statement';
        statement: Parameters<typeof applyStatement>[1];
      }).statement,
      ROOT,
      NOW,
      'beta',
    );
    expect(verdict('manifest-beta-ok', { state: revoked })).toBe('unrotated_key');
  });

  it('a v1 statement is refused as the old format too', () => {
    const v1 = { ...vector('statement-introduce-beta').input.document };
    v1['domain'] = 'agentlink-desktop-root/v1';
    expect(() => parseUpdateDocument(enc(v1))).toThrow(UpdateRefusal);
    try {
      parseUpdateDocument(enc(v1));
    } catch (error) {
      expect((error as UpdateRefusal).code).toBe('old_format');
    }
  });
});
