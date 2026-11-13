// Types for profile.mjs (the smoke test's throw-away profiles).
export interface SmokeProfile {
  readonly home: string;
  readonly env: Record<string, string | undefined>;
}
export interface SmokeProfileDeps {
  readonly platform?: string;
  readonly tmp?: string;
  readonly run?: (
    args: string[],
    env: Record<string, string | undefined>,
  ) => { status: number | null };
  readonly warn?: (line: string) => void;
}
export function keychainSetup(keychain: string): string[][];
export function makeHome(opts?: { noRoaming?: boolean }, deps?: SmokeProfileDeps): SmokeProfile;
