// RED stub (M1-1a): signatures only; the implementation follows in the next commit.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export const MAX_JSON_DEPTH = 128;
export function parseJson(_text: string): JsonValue {
  throw new Error('not implemented');
}
export function serializeNumber(_value: number): string {
  throw new Error('not implemented');
}
export function canonicalize(_value: unknown): string {
  throw new Error('not implemented');
}
export function canonicalizeToBytes(_value: unknown): Uint8Array {
  throw new Error('not implemented');
}
