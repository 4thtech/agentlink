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

/** The kind of proof a request carries: the typed master code, a passkey, or native presence. */
export type OwnerCodeProofKind = 'code' | 'passkey' | 'native';

/**
 * Which proof each step takes. Test Touch ID: a passkey assertion or, in the desktop app, native
 * presence (DESK051-C2: one helper gesture that opens `ALKH`, so "works" means native approvals
 * will work), never the master code. Replace: any presence. Check and finish are about the typed
 * master code itself, so only a typed code; cancel takes none (the gate answers it first). Native
 * presence carries no typed code, so it is never accepted where a typed code is the point.
 */
export function ownerCodeProofAllowed(
  step: LocalUiOwnerCodeStep,
  kind: OwnerCodeProofKind,
): boolean {
  switch (step) {
    case 'test':
      return kind === 'passkey' || kind === 'native';
    case 'replace':
      return true;
    default:
      return kind === 'code';
  }
}
