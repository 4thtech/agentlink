// storage.set, storage.remove and backup.export (M1-9i-a; D-115; 04 §2.5.1 op table, §2.2, §2.3.3;
// 07 §3.4 `own_storage`, §5.2). Written from the spec text:
// - `storage.set` params are exactly `{id, provider, endpoint, bucket, region, credentialDigest}`:
//   `id` 8 bytes as 16 lowercase hex; `provider` one of the eight names; `endpoint` exactly what
//   `validateEndpoint` returns (`https://host[:port]`, the 04 §4 grammar, no trailing slash);
//   `bucket` the S3 bucket rule (3 to 63 of `[a-z0-9.-]`); `region` 1 to 32 of `[a-z0-9-]`;
//   `credentialDigest` 64 lowercase hex. No credential is ever a param.
// - `storage.remove` params are exactly `{id}`.
// - `backup.export` params are exactly `{kitId, contents}`: `kitId` 16 bytes as base64url without
//   padding, `contents` `"full"` or `"identity"`.
// - All three expire, with L(op) = 600 s, and no envelope carries them.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_KIT_CONTENTS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  STORAGE_PROVIDERS,
  backupExportActionSchema,
  isCanonicalS3Endpoint,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
  signedStorageSetSchema,
  storageRemoveActionSchema,
  storageSetActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, OWNER_NOSTR, SHA, b64u, signed } from './testing/fixtures.js';

const NONCE = b64u(16, 'X');
const ID = '0123456789abcdef';

const setParams = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  provider: 'r2',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'my-agent-files',
  region: 'auto',
  credentialDigest: SHA,
  ...over,
});

const action = (op: string, params: Record<string, unknown>) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op,
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

const setAction = (over: Record<string, unknown> = {}) => action('storage.set', setParams(over));
const removeAction = (params: Record<string, unknown> = { id: ID }) =>
  action('storage.remove', params);
const exportAction = (
  params: Record<string, unknown> = { kitId: b64u(16, 'K'), contents: 'full' },
) => action('backup.export', params);

describe('storage and backup owner-action constants (M1-9i-a, D-115)', () => {
  it('adds the three ops with L(op) = 600 s', () => {
    for (const op of ['storage.set', 'storage.remove', 'backup.export'] as const) {
      expect(OWNER_ACTION_OPS).toContain(op);
      expect(OWNER_ACTION_MAX_LIFETIME_SECONDS[op]).toBe(600);
    }
  });

  it('fixes the provider names and the kit contents', () => {
    expect(STORAGE_PROVIDERS).toEqual([
      'r2',
      's3',
      'b2',
      'hetzner',
      'scaleway',
      'wasabi',
      'minio',
      'other',
    ]);
    expect(BACKUP_KIT_CONTENTS).toEqual(['full', 'identity']);
    expect(Object.isFrozen(STORAGE_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(BACKUP_KIT_CONTENTS)).toBe(true);
  });
});

describe('storage.set schema (04 §2.5.1)', () => {
  it('accepts the exact form through every schema it passes', () => {
    for (const body of [
      setAction(),
      setAction({ provider: 'other', endpoint: 'https://s3.eu-central-1.example.com:8443' }),
      setAction({ provider: 'minio', endpoint: 'https://xn--bcher-kva.example', region: 'eu-1' }),
      setAction({ bucket: 'a.b-c', region: 'x' }),
      setAction({ bucket: 'b'.repeat(63), region: 'r'.repeat(32) }),
    ]) {
      expectRoundTrip(storageSetActionSchema, body);
      expectRoundTrip(ownerActionSchema, body);
      expectRoundTrip(signedOwnerActionSchema, signed(body));
      expectRoundTrip(signedStorageSetSchema, signed(body));
    }
    for (const provider of STORAGE_PROVIDERS) {
      expectRoundTrip(ownerActionSchema, setAction({ provider }));
    }
  });

  it('rejects an unknown or missing key, and any credential in params', () => {
    const missing = setParams();
    delete missing.region;
    for (const params of [
      { ...setParams(), note: 'x' },
      { ...setParams(), accessKeyId: 'AKIA' },
      { ...setParams(), secretAccessKey: 'secret' },
      missing,
    ]) {
      expectReject(ownerActionSchema, action('storage.set', params));
      expectReject(signedOwnerActionSchema, signed(action('storage.set', params)));
    }
  });

  it('rejects an `id` that is not 8 bytes as 16 lowercase hex', () => {
    for (const id of [
      '0123456789ABCDEF',
      '0123456789abcde',
      '0123456789abcdef0',
      '0x0123456789abcdef',
      '',
      7,
      'g123456789abcdef',
    ]) {
      expectReject(ownerActionSchema, setAction({ id }));
    }
  });

  it('rejects an endpoint that is not in canonical form', () => {
    for (const endpoint of [
      'https://acct.r2.cloudflarestorage.com/',
      'http://acct.r2.cloudflarestorage.com',
      'HTTPS://acct.r2.cloudflarestorage.com',
      'https://ACCT.r2.cloudflarestorage.com',
      'https://acct.r2.cloudflarestorage.com/bucket',
      'https://acct.r2.cloudflarestorage.com?x=1',
      'https://user@acct.r2.cloudflarestorage.com',
      'https://acct.r2.cloudflarestorage.com.',
      'https://localhost',
      'https://minio.local',
      'https://s3.internal',
      'https://127.0.0.1',
      'https://10.0.0.1:9000',
      'https://[::1]',
      'https://0x7f.example',
      'https://example',
      'https://example.com:0',
      'https://example.com:08443',
      'https://example.com:65536',
      'https://exa%6dple.com',
      'https://exa\\mple.com',
      'https://-bad.example.com',
      `https://${'a'.repeat(64)}.example.com`,
      `https://${'a.'.repeat(130)}com`,
      '',
      42,
    ]) {
      expectReject(ownerActionSchema, setAction({ endpoint }));
    }
  });

  it('rejects other providers, buckets, regions and digest spellings', () => {
    for (const over of [
      { provider: 'R2' },
      { provider: 'gcs' },
      { provider: '' },
      { bucket: 'ab' },
      { bucket: 'b'.repeat(64) },
      { bucket: 'My-Bucket' },
      { bucket: 'my_bucket' },
      { bucket: '-bucket' },
      { bucket: 'bucket-' },
      { bucket: 'a..b' },
      { bucket: 'a/b' },
      { region: '' },
      { region: 'r'.repeat(33) },
      { region: 'EU' },
      { region: 'eu_1' },
      { credentialDigest: SHA.toUpperCase() },
      { credentialDigest: `0x${SHA}` },
      { credentialDigest: SHA.slice(2) },
    ]) {
      expectReject(ownerActionSchema, setAction(over));
    }
  });
});

describe('storage.remove and backup.export schemas (04 §2.5.1)', () => {
  it('accept the exact forms', () => {
    for (const body of [
      removeAction(),
      exportAction(),
      exportAction({ kitId: b64u(16, 'Q'), contents: 'identity' }),
    ]) {
      expectRoundTrip(ownerActionSchema, body);
      expectRoundTrip(signedOwnerActionSchema, signed(body));
    }
    expectRoundTrip(storageRemoveActionSchema, removeAction());
    expectRoundTrip(backupExportActionSchema, exportAction());
  });

  it('reject other keys and spellings', () => {
    for (const body of [
      removeAction({}),
      removeAction({ id: ID, provider: 'r2' }),
      removeAction({ id: ID.toUpperCase() }),
      removeAction({ id: `${ID}00` }),
      exportAction({ kitId: b64u(16, 'K') }),
      exportAction({ kitId: b64u(16, 'K'), contents: 'all' }),
      exportAction({ kitId: b64u(16, 'K'), contents: 'Full' }),
      exportAction({ kitId: `${b64u(16, 'K')}==`, contents: 'full' }),
      exportAction({ kitId: b64u(15, 'K'), contents: 'full' }),
      exportAction({ kitId: b64u(32, 'K'), contents: 'full' }),
      exportAction({ kitId: b64u(16, 'K'), contents: 'full', agent: AGENT_EVM }),
      { ...removeAction(), expiresAt: 0 },
      { ...exportAction(), expiresAt: 1760000000 },
    ]) {
      expectReject(ownerActionSchema, body);
      expectReject(signedOwnerActionSchema, signed(body));
    }
  });

  it('no envelope carries them (local owner surfaces only)', () => {
    for (const body of [setAction(), removeAction(), exportAction()]) {
      expectReject(signedApprovalOpSchema, signed(body));
    }
  });

  it('signedStorageSetSchema takes only storage.set (what `own_storage` stores, 07 §3.4)', () => {
    expectReject(signedStorageSetSchema, signed(removeAction()));
    expectReject(signedStorageSetSchema, signed(exportAction()));
  });
});

describe('isCanonicalS3Endpoint (04 §4 grammar, adapted to https)', () => {
  it('is true only for the exact `https://host[:port]` form', () => {
    expect(isCanonicalS3Endpoint('https://s3.amazonaws.com')).toBe(true);
    expect(isCanonicalS3Endpoint('https://s3.amazonaws.com:443')).toBe(true);
    expect(isCanonicalS3Endpoint('https://s3.amazonaws.com/')).toBe(false);
    expect(isCanonicalS3Endpoint('https://s3.amazonaws.com:65535')).toBe(true);
    expect(isCanonicalS3Endpoint(undefined)).toBe(false);
  });
});
