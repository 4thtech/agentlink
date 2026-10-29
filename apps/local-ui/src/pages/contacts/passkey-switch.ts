// HOTFIX-045-TOUCHID: the one-time switch to a passkey inside a presence sheet, for an owner set up
// before 0.3.0 (or switched on another computer). It is the same owner operation as the first-run
// switch (M1-UX-FIRSTRUN-V2-c; `POST /api/owner/passkey`, owner-passkey.ts registerOwnerPasskey):
// one passkey creation on this page, then the backup code and the assertion in one octet-stream body.
// The server checks the code (the wrong-code backoff applies), keeps the same owner and never
// rewrites the `owner` item, so the backup code keeps working. It signs nothing: the operation the
// sheet is for still needs its own gesture afterwards (one entry, one operation, D-68). The code is
// zeroed after encoding and is never logged or put in a URL.
import { createUpgradePasskey, encodeUpgradeBody } from '../first-run/passkey.js';
import { createUpgradeApi, type UpgradeProblem } from '../first-run/setup-api.js';
import type { PasskeySwitchValues } from './owner.js';

export type PasskeySwitchOutcome =
  | { readonly kind: 'switched' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly problem: UpgradeProblem; readonly retryAfter?: number };

export type SwitchToPasskey = (
  values: PasskeySwitchValues,
  code: string,
) => Promise<PasskeySwitchOutcome>;

/** The browser switch: Touch ID (the platform authenticator), then the one registration request. */
export const switchToPasskey: SwitchToPasskey = async (values, code) => {
  if (code.length === 0) return { kind: 'error', problem: 'presence_required' };
  const made = await createUpgradePasskey(values, { platform: true });
  if (made.kind === 'cancelled') return { kind: 'cancelled' };
  if (made.kind === 'unsupported') return { kind: 'unsupported' };
  const secret = new TextEncoder().encode(code);
  let body: Uint8Array;
  try {
    body = encodeUpgradeBody(secret, made.body);
  } catch {
    return { kind: 'error', problem: 'presence_required' };
  } finally {
    secret.fill(0);
    made.body.fill(0);
  }
  try {
    const result = await createUpgradeApi().register(body);
    if (result.kind === 'registered') return { kind: 'switched' };
    return {
      kind: 'error',
      problem: result.problem,
      ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
    };
  } finally {
    body.fill(0);
  }
};
