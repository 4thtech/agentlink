// IR-M1-8a-1 L-1, L-7: osKeychain against a mocked @napi-rs/keyring, so its conversions, the Linux
// pin and the loader hardening are covered on every runner, not only where a real keychain exists.
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  calls: [] as unknown[][],
  secret: undefined as unknown,
  constructorError: undefined as Error | undefined,
}));

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      native.calls.push(args);
      if (native.constructorError !== undefined) throw native.constructorError;
    }
    getSecret(): Promise<unknown> {
      return Promise.resolve(native.secret);
    }
    setSecret(): Promise<void> {
      return Promise.resolve();
    }
    deleteCredential(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

const { osKeychain } = await import('./keychain.js');

afterEach(() => {
  native.calls.length = 0;
  native.secret = undefined;
  native.constructorError = undefined;
});

describe('osKeychain (mocked binding)', () => {
  it('opens every entry under its service, pinned to the Secret Service on Linux', async () => {
    await osKeychain('svc').get('acct');
    expect(native.calls).toEqual([['svc', 'acct', { linux: { store: 'secret-service' } }]]);
    await osKeychain().set('acct', new Uint8Array(1));
    expect(native.calls[1]?.[0]).toBe('agentlink');
  });

  it('copies a number[] secret into bytes and zeroes the array', async () => {
    const raw = [1, 2, 3];
    native.secret = raw;
    expect(await osKeychain('svc').get('acct')).toEqual(Uint8Array.from([1, 2, 3]));
    expect(raw).toEqual([0, 0, 0]);
  });

  it('passes a Uint8Array through, maps a missing secret to null, refuses other types', async () => {
    const bytes = Uint8Array.from([9]);
    native.secret = bytes;
    expect(await osKeychain('svc').get('acct')).toBe(bytes);
    native.secret = undefined;
    expect(await osKeychain('svc').get('acct')).toBeNull();
    native.secret = 'text';
    await expect(osKeychain('svc').get('acct')).rejects.toThrow(TypeError);
  });

  it('surfaces an unavailable store (constructor throw) as a rejection', async () => {
    native.constructorError = new Error('no secret service');
    await expect(osKeychain('svc').get('acct')).rejects.toThrow('no secret service');
  });

  it('clears the napi-rs loader overrides before the binding loads (L-7)', async () => {
    process.env['NAPI_RS_NATIVE_LIBRARY_PATH'] = '/tmp/evil.node';
    process.env['NAPI_RS_FORCE_WASI'] = '1';
    process.env['NAPI_RS_WASI_FLAVOR'] = 'x';
    await osKeychain('svc').get('acct');
    expect(process.env['NAPI_RS_NATIVE_LIBRARY_PATH']).toBeUndefined();
    expect(process.env['NAPI_RS_FORCE_WASI']).toBeUndefined();
    expect(process.env['NAPI_RS_WASI_FLAVOR']).toBeUndefined();
  });
});
