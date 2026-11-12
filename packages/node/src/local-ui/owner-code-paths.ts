// UX1113 WP-S2 (08 §1; 04 §2.5 "Touch ID & master code page"): the fixed paths of the owner-code
// steps. A route may carry `ownerCode: <step>` only at its step's path (routes.ts), and each step is
// registered once. Kept in their own file so api/owner-presence.ts and routes.ts share them without
// importing each other (as reveal-path.ts and invite-paths.ts do).

/** The steps of Settings › Touch ID & master code, each run by the central presence gate. */
export type LocalUiOwnerCodeStep = 'check' | 'test' | 'replace' | 'finish' | 'cancel';

export const OWNER_CODE_PATHS: Readonly<Record<LocalUiOwnerCodeStep, string>> = Object.freeze({
  /** Check my master code: the master code only; signs nothing. */
  check: '/api/ui/owner-code/check',
  /** Test Touch ID: a passkey assertion only; signs nothing. */
  test: '/api/ui/owner-presence/test',
  /** Replace master code: presence, then a new code staged (`owner-next`) and shown once. */
  replace: '/api/ui/owner-code/replace',
  /** The new code typed back: the staged item replaces the `owner` item. */
  finish: '/api/ui/owner-code/replace/finish',
  /** Drops the staged change of this page session. */
  cancel: '/api/ui/owner-code/replace/cancel',
});

export const OWNER_CODE_STEPS: readonly LocalUiOwnerCodeStep[] = Object.freeze([
  'check',
  'test',
  'replace',
  'finish',
  'cancel',
]);

export function isOwnerCodeStep(value: unknown): value is LocalUiOwnerCodeStep {
  return typeof value === 'string' && (OWNER_CODE_STEPS as readonly string[]).includes(value);
}

/**
 * Which proof each step takes (one kind only): Test Touch ID a passkey assertion; Check, finish and
 * cancel never a passkey (Check and finish take a typed code; cancel takes none); Replace either.
 */
export function ownerCodeProofAllowed(step: LocalUiOwnerCodeStep, passkey: boolean): boolean {
  switch (step) {
    case 'test':
      return passkey;
    case 'replace':
      return true;
    default:
      return !passkey;
  }
}
