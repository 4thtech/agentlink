// DESK-D12c test stand-in for the DESK-D12b presence helper: what it prints and what a gesture (or
// its refusal) does, with the alkh vectors' test records. No Secure Enclave, no TPM, no Touch ID or
// Windows Hello prompt. Test data only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_PRESENCE_MACOS,
  concatBytes,
  decodeHex,
  encodeUtf8,
  sha256,
  type NativePresenceKind,
} from '@4thtech-io/crypto';
import {
  NativeHelperError,
  type NativeHelper,
  type NativeReason,
  type NativeUiState,
} from './owner-native-helper.js';

const vectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'test-vectors',
      'alkh',
      'vectors.json',
    ),
    'utf8',
  ),
) as { cases: { id: string; input: Record<string, unknown> }[] };
const recordOf = (id: string): Uint8Array =>
  decodeHex(String(vectors.cases.find((c) => c.id === id)?.input['record']));
export const MAC_RECORD = recordOf('read-record-mac');
export const WIN_RECORD = recordOf('read-record-win');

/** The stand-in helper's released secret: deterministic per record (as ECDH or PKCS#1 v1.5 are). */
export function secretFor(kind: NativePresenceKind, record: Uint8Array): Uint8Array {
  const label = (n: number) => sha256(concatBytes(encodeUtf8(`stand-in/${String(n)}`), record));
  if (kind === NATIVE_PRESENCE_MACOS) return label(0);
  return concatBytes(...Array.from({ length: 8 }, (_, i) => label(i)));
}

/** The DESK-D12b helper, stood in: what it prints, and what a gesture (or its refusal) does. */
export class StandInHelper implements NativeHelper {
  readonly calls: string[] = [];
  readonly records: Uint8Array[] = [];
  /** What the owner does at the OS prompt: `ok`, or the state the helper's exit code maps to. */
  gesture: 'ok' | NativeUiState = 'ok';
  /** macOS `check`: `ok` (the key needs a gesture) or a refusal (e.g. it works without one). */
  checkState: 'ok' | NativeUiState = 'ok';
  createState: 'ok' | NativeUiState = 'ok';
  constructor(
    readonly kind: NativePresenceKind,
    readonly record: Uint8Array = kind === NATIVE_PRESENCE_MACOS ? MAC_RECORD : WIN_RECORD,
    private readonly keychain?: { readonly writes: readonly string[] },
  ) {}
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  #created = 0;
  /** Each `create` after the first makes a new credential (as the real helpers do). */
  create(): Promise<Uint8Array> {
    this.calls.push(`create@${String(this.keychain?.writes.length ?? 0)}`);
    if (this.createState !== 'ok') return Promise.reject(new NativeHelperError(this.createState));
    const record = this.record.slice();
    const n = this.#created++;
    if (n > 0) {
      // macOS: another opaque SE handle; Windows: another challenge.
      const at = this.kind === NATIVE_PRESENCE_MACOS ? 3 : record.length - 1;
      record[at] = ((record[at] as number) + n) & 0xff;
    }
    if (this.kind === NATIVE_PRESENCE_MACOS) return Promise.resolve(record);
    const sig = secretFor(this.kind, record);
    return Promise.resolve(
      concatBytes(record, new Uint8Array([sig.length >> 8, sig.length & 0xff]), sig),
    );
  }
  check(record: Uint8Array): Promise<void> {
    this.calls.push('check');
    this.records.push(record.slice());
    return this.checkState === 'ok'
      ? Promise.resolve()
      : Promise.reject(new NativeHelperError(this.checkState));
  }
  /**
   * When set, the owner has not touched yet: release waits for it. A real helper is killed on abort
   * (the OS prompt closes); this stand-in records the abort and, like a late touch, still answers.
   */
  touch: Promise<void> | undefined;
  aborted = 0;
  async release(
    record: Uint8Array,
    reason: NativeReason,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.calls.push(`release:${reason}@${String(this.keychain?.writes.length ?? 0)}`);
    this.records.push(record.slice());
    signal?.addEventListener('abort', () => (this.aborted += 1), { once: true });
    if (this.touch !== undefined) await this.touch;
    if (this.gesture !== 'ok') throw new NativeHelperError(this.gesture);
    return secretFor(this.kind, record);
  }
  remove(): Promise<void> {
    this.calls.push('remove');
    return Promise.resolve();
  }
}
