// M1-6a: S3 endpoint and configuration checks (04 §4 SSRF rules applied to the storage endpoint).
// The checks run on the raw string, before any URL parser, as for relay URLs (04 §4).
import { describe, expect, it } from 'vitest';
import { validateS3Endpoint, validateStoragePrefix, newObjectKey } from './index.js';
import { testPrefix } from './fake-s3.fixture.js';

describe('validateS3Endpoint', () => {
  it.each([
    'https://acct.r2.cloudflarestorage.com',
    'https://s3.us-east-1.amazonaws.com',
    'https://fsn1.your-objectstorage.com/',
    'https://minio.example.org:9000',
    'https://s3.xn--bcher-kva.example',
  ])('accepts %s', (endpoint) => {
    expect(validateS3Endpoint(endpoint)).toBe(endpoint.replace(/\/$/, ''));
  });

  it.each([
    ['http (not https)', 'http://s3.example.com'],
    ['no scheme', 's3.example.com'],
    ['user info', 'https://user:pass@s3.example.com'],
    ['query', 'https://s3.example.com/?x=1'],
    ['fragment', 'https://s3.example.com/#x'],
    ['a path', 'https://s3.example.com/bucket'],
    ['localhost', 'https://localhost'],
    ['.localhost', 'https://s3.localhost'],
    ['.local', 'https://nas.local'],
    ['.internal', 'https://metadata.google.internal'],
    ['.home.arpa', 'https://nas.home.arpa'],
    ['.localdomain', 'https://s3.localdomain'],
    ['IPv4 literal', 'https://127.0.0.1'],
    ['metadata IP', 'https://169.254.169.254'],
    ['decimal IPv4', 'https://2130706433'],
    ['hex label', 'https://0x7f.1'],
    ['numeric label', 'https://10.s3.example.com'],
    ['IPv6 literal', 'https://[::1]'],
    ['single label', 'https://minio'],
    ['upper case', 'https://S3.Example.com'],
    ['percent-encoding', 'https://s3%2eexample.com'],
    ['full-width dot', 'https://s3。example.com'],
    ['whitespace', 'https://s3.example.com '],
    ['backslash', 'https://s3.example.com\\'],
    ['trailing dot', 'https://s3.example.com.'],
    ['port 0', 'https://s3.example.com:0'],
    ['port leading zero', 'https://s3.example.com:0443'],
    ['port too large', 'https://s3.example.com:65536'],
    ['label with leading hyphen', 'https://-s3.example.com'],
    ['numeric last label', 'https://s3.example.123'],
    ['too long', `https://${'a'.repeat(250)}.example.com`],
  ])('refuses %s', (_name, endpoint) => {
    expect(() => validateS3Endpoint(endpoint)).toThrow(
      expect.objectContaining({ code: 'invalid_config' }),
    );
  });

  it('never echoes the endpoint in the error', () => {
    const endpoint = 'https://user:topsecretpw@s3.example.com';
    try {
      validateS3Endpoint(endpoint);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('topsecretpw');
      expect(String((error as Error).message)).not.toContain('s3.example.com');
    }
  });
});

describe('storage prefix and object keys (04 §2.9, 07 §5.2)', () => {
  it('accepts a base64url prefix of exactly 16 bytes', () => {
    const prefix = testPrefix();
    expect(validateStoragePrefix(prefix)).toBe(prefix);
  });

  it.each([
    ['too short', 'AAAAAAAAAAAAAAAAAAAA'],
    ['too long', 'AAAAAAAAAAAAAAAAAAAAAAAA'],
    ['an agent ID', '0x' + 'ab'.repeat(20)],
    ['a slash', 'AAAAAAAAAAAAAAAAAAAA/A'],
    ['padding', 'AAAAAAAAAAAAAAAAAAAAAA=='],
    ['empty', ''],
  ])('refuses a prefix with %s', (_name, prefix) => {
    expect(() => validateStoragePrefix(prefix)).toThrow(
      expect.objectContaining({ code: 'invalid_config' }),
    );
  });

  it('builds agentlink/<storagePrefix>/<random 128-bit> keys, fresh each time', () => {
    const prefix = testPrefix();
    const keys = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const key = newObjectKey(prefix);
      expect(key).toMatch(new RegExp(`^agentlink/${prefix}/[A-Za-z0-9_-]{22}$`));
      keys.add(key);
    }
    expect(keys.size).toBe(64);
  });
});
