// Test helpers for @agentlink/types. Not part of the build (tsconfig.json excludes src/testing).
import { expect } from 'vitest';

/** A short, never-throwing label for an assertion message (values may be cyclic, deep or hostile). */
export function label(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? typeof value : text.slice(0, 120);
  } catch {
    return `<${typeof value}>`;
  }
}

export interface SafeParser {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

/** The value parses, and the output is deep-equal to the input (no normalisation, no stripping). */
export function expectRoundTrip(schema: SafeParser, value: unknown): void {
  const first = schema.safeParse(value);
  expect(first.success, label(value)).toBe(true);
  expect(first.data).toStrictEqual(value);
  // Through JSON text and back: the wire form parses to the same value.
  const again = schema.safeParse(JSON.parse(JSON.stringify(first.data)));
  expect(again.success).toBe(true);
  expect(again.data).toStrictEqual(value);
}

export function expectAccept(schema: SafeParser, value: unknown): void {
  expect(schema.safeParse(value).success, label(value)).toBe(true);
}

export function expectReject(schema: SafeParser, value: unknown): void {
  expect(schema.safeParse(value).success, label(value)).toBe(false);
}
