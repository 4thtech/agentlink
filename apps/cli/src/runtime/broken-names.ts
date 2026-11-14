// WIN-BROKEN-ID: the in-memory names of this process whose open failed with `identity_missing`
// (broken-id.ts header). Kept apart so agent-dir.ts can mark them without an import cycle.
import { isAgentName } from './agent-name.js';

/** True when `error` carries the `identity_missing` code (core, node KeyStore). */
export function isIdentityMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'identity_missing'
  );
}

export interface BrokenIds {
  note(name: string): void;
  clear(name: string): void;
  has(name: string): boolean;
}

const registries = new Map<string, Set<string>>();

/** The broken-ID names of this process for `home` (in memory only). */
export function brokenIds(home: string): BrokenIds {
  let names = registries.get(home);
  if (names === undefined) {
    names = new Set();
    registries.set(home, names);
  }
  const set = names;
  return Object.freeze<BrokenIds>({
    note: (name) => {
      if (isAgentName(name)) set.add(name);
    },
    clear: (name) => {
      set.delete(name);
    },
    has: (name) => set.has(name),
  });
}
