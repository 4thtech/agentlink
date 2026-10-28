/** The embedded `[name, base64url]` entries found in a built bundle's source. */
export function entriesFromBundle(source: string): [string, string][];
/** Findings for embedded entries; empty when index.html, a JS and a CSS file are present. */
export function embeddedUiProblems(entries: readonly (readonly [string, string])[]): string[];
