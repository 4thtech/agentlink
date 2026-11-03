// R2: the fixed reason codes of a catch-all `failed` answer (no message text, I-5/I-7).
import { describe, expect, it } from 'vitest';
import { FAILURE_REASONS, failedBody, failureReasonOf } from './failure-reasons.js';

const named = (name: string, code?: string, message = 'SECRET /home/x token=abc'): Error =>
  Object.assign(new Error(message), { name }, code === undefined ? {} : { code });

describe('failureReasonOf', () => {
  it('maps our own error classes to a fixed reason', () => {
    expect(failureReasonOf(named('StorageError', 'network'))).toBe('storage_unreachable');
    expect(failureReasonOf(named('StorageError', 'invalid_argument'))).toBe('internal');
    expect(failureReasonOf(named('KeyStoreError', 'keychain_failed'))).toBe('keychain_unavailable');
    expect(failureReasonOf(named('NodeKeyStoreError', 'backend_unavailable'))).toBe(
      'keychain_unavailable',
    );
    expect(failureReasonOf(named('AgentFolderLockError', 'in_use'))).toBe('busy');
    expect(failureReasonOf(named('HarnessError', 'write_failed'))).toBe('ai_app_config_unwritable');
    expect(failureReasonOf(named('Error', 'ECONNREFUSED'))).toBe('relay_unreachable');
    // F23: a rename that raced another change of the ID has its own reason (core concurrent_rotation).
    expect(failureReasonOf(named('CoreError', 'concurrent_rotation'))).toBe('concurrent_change');
    expect(failureReasonOf(named('CoreError', 'key_epoch_mismatch'))).toBe('internal');
  });
  it('answers internal for anything else, including non-errors', () => {
    for (const v of [new Error('x'), undefined, null, 'text', 5, {}, { code: 5 }]) {
      expect(failureReasonOf(v)).toBe('internal');
    }
  });
  it('only ever returns a member of the closed set and never the message', () => {
    const body = failedBody(named('StorageError', 'network'));
    expect(FAILURE_REASONS).toContain(body.reason);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|token|home/);
    expect(failedBody()).toEqual({ status: 'failed', reason: 'internal' });
  });
});
