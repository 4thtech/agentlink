// Tool input validation against the registry's own `inputSchema` (06 §1: "a handler is a function of
// its validated input"; IR-M1-9c-1 F04). The low-level MCP SDK server does not check arguments, so
// `callTool` runs this before any handler: a call whose arguments break the frozen schema gets the
// fixed INVALID_ARGUMENT result and never reaches a handler.
//
// A small, strict JSON Schema subset: exactly the keywords registry.ts uses (type, properties,
// required, additionalProperties: false, enum, const, pattern, minLength and maxLength in code
// points, minimum, maximum, minItems, maxItems, items, anyOf). Any other keyword fails closed, so a
// registry change that uses one cannot be silently ignored. Handlers still apply the core's own
// schemas (for example `TermsInput`) on top.
import type { JsonSchema } from './registry.js';

const KNOWN = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  'anyOf',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** True when `value` satisfies `schema`. Never throws; an unknown keyword is a failure. */
export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) return false;
  const s = schema as Record<string, unknown>;

  if (s['anyOf'] !== undefined) {
    const options = s['anyOf'] as JsonSchema[];
    if (!options.some((option) => matchesSchema(option, value))) return false;
  }
  if (s['type'] !== undefined) {
    const types = Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string];
    if (!types.some((type) => typeMatches(type, value))) return false;
  }
  if (s['const'] !== undefined && value !== s['const']) return false;
  if (s['enum'] !== undefined && !(s['enum'] as unknown[]).includes(value)) return false;

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof s['minLength'] === 'number' && length < s['minLength']) return false;
    if (typeof s['maxLength'] === 'number' && length > s['maxLength']) return false;
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(value))
      return false;
  }
  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < s['minimum']) return false;
    if (typeof s['maximum'] === 'number' && value > s['maximum']) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < s['minItems']) return false;
    if (typeof s['maxItems'] === 'number' && value.length > s['maxItems']) return false;
    const items = s['items'] as JsonSchema | undefined;
    if (items !== undefined && !value.every((item) => matchesSchema(items, item))) return false;
  }
  if (isObject(value)) {
    const properties = (s['properties'] ?? {}) as Record<string, JsonSchema>;
    for (const name of (s['required'] ?? []) as string[]) {
      if (!Object.hasOwn(value, name)) return false;
    }
    for (const [name, item] of Object.entries(value)) {
      const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
      if (property === undefined) {
        if (s['additionalProperties'] === false) return false;
        continue;
      }
      if (!matchesSchema(property, item)) return false;
    }
  }
  return true;
}
