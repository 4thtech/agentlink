// R1: the running CLI's version, set once by main.ts, for the last-exit record.
let current = '0.0.0';

export function setCliVersion(version: string): void {
  current = version;
}

export function cliVersion(): string {
  return current;
}
