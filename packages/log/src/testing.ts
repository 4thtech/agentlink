// Secret-canary helper (04 §8.4: "a CI test asserts known secret patterns never appear in logs").
// Import it from "@agentlink/log/testing" in tests only. It has no test-framework dependency: it
// returns leaks or throws, so it works under Vitest, Playwright or Miniflare alike.
//
// How a package adds its canaries (see README.md):
//   1. Define canaries: realistic fake secrets your package handles (keys, tokens, URLs, plaintext).
//   2. In a `*.canary.test.ts`, call assertNoCanaryLeaks({ canaries, exercise }). `exercise` gets a
//      debug-level logger; pass it into your public API and drive the paths that touch the secrets,
//      including failures. Every line at every level, and anything written to the console while
//      `exercise` runs, is searched for every canary.
//   3. Keep a negative control: a test that feeds a deliberately leaking exercise to findCanaryLeaks()
//      and expects a leak, so the check can never pass vacuously.

import { captureConsole } from './console.js';
import { createLogger, type Level, type Logger, type Sink } from './logger.js';

/** A known fake secret. `forms` are other encodings of the same secret to search for too. */
export interface Canary {
  readonly name: string;
  readonly value: string;
  readonly forms?: readonly string[];
}

/** One canary found in captured output. Carries names and places only, never the line itself. */
export interface Leak {
  readonly canary: string;
  /** "log:<level>" for logger lines, "console:<method>" for direct console output. */
  readonly source: string;
  readonly index: number;
}

export interface CapturedLine {
  readonly source: string;
  readonly line: string;
}

// Canary values are assembled at run time so the source holds no secret-shaped literal for the
// secret scanner to trip on. Each is caught by one value rule of redact.ts; the tests prove which.
const hex = (word: string): string => word.repeat(64 / word.length);

/** Shape canaries: one per value rule. Logged anywhere (message, any field), they must never appear. */
export const PATTERN_CANARIES: readonly Canary[] = [
  { name: 'hex64', value: hex('c0ffee11') },
  { name: 'hex64-0x', value: `0x${hex('feedface')}` },
  { name: 'nsec', value: `nsec1${'canary'.repeat(9)}qqqq` },
  { name: 'ncryptsec', value: `ncryptsec1${'canary'.repeat(20)}` },
  { name: 'sigv4-signature', value: 'CanarySigV4SignatureValue' },
  { name: 'sigv4-credential', value: 'CANARYKEYID/20261014/auto/s3/aws4_request' },
  { name: 'aws4-authorization', value: 'Signature=canary-aws4-header-signature' },
  { name: 'authorization-header', value: ['Basic', 'Y2FuYXJ5OmF1dGg='].join(' ') },
  { name: 'bearer', value: 'canary.bearer.token-value' },
  { name: 'local-ui-token', value: 'canaryLocalUiSessionToken' },
  {
    name: 'recovery-code',
    value: ['CANA', 'RYRE', 'COVE', 'RYCO', 'DE23', '4567'].join('-'),
    forms: ['CANARYRECOVERYCODE234567'],
  },
  {
    name: 'jwt',
    value: ['eyJhbGciOiJub25lIn0', 'eyJjYW5hcnkiOiJqd3QifQ', 'Y2FuYXJ5LXNpZ25hdHVyZQ'].join('.'),
  },
  { name: 'url-query', value: 'canary-presigned-query-secret' },
  { name: 'url-fragment', value: 'canary-fragment-file-key' },
  { name: 'url-userinfo', value: 'canary-url-password' },
  { name: 'url-path', value: 'canary-rpc-path-api-key' },
  { name: 'url-encoded', value: 'canary-encoded-object-id' },
  { name: 'sigv4-encoded', value: 'canary-encoded-session-token' },
  { name: 'basic', value: 'Y2FuYXJ5OmJhc2ljLWF1dGg=' },
  { name: 'key-value', value: 'canary-key-value-password' },
  { name: 'data-uri', value: 'Y2FuYXJ5LWRhdGEtdXJp' },
];

/** A secret with no recognisable shape: only the key rule protects it. Log it under sensitive keys only. */
export const KEY_ONLY_CANARY: Canary = { name: 'key-only', value: 'canary-shapeless-secret-value' };

/** Every built-in canary. */
export const CANARIES: readonly Canary[] = [...PATTERN_CANARIES, KEY_ONLY_CANARY];

// Printable ASCII without quote or backslash: JSON.stringify leaves these alone, so a leaked canary
// always appears verbatim in a captured line.
const VERBATIM_IN_JSON = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/;

function checkCanaries(canaries: readonly Canary[]): void {
  if (canaries.length === 0) throw new Error('canary check: no canaries given');
  for (const canary of canaries) {
    for (const form of [canary.value, ...(canary.forms ?? [])]) {
      if (form.length < 8)
        throw new Error(`canary "${canary.name}": every form needs at least 8 characters`);
      if (!VERBATIM_IN_JSON.test(form)) {
        throw new Error(
          `canary "${canary.name}": use printable ASCII without quotes or backslashes`,
        );
      }
    }
  }
}

/** Returns every canary found in `lines`, case-insensitively (a hex secret upper-cased still leaks). */
export function findCanaryLeaks(
  lines: readonly CapturedLine[],
  canaries: readonly Canary[],
): Leak[] {
  checkCanaries(canaries);
  const leaks: Leak[] = [];
  lines.forEach(({ source, line }, index) => {
    const haystack = line.toLowerCase();
    for (const canary of canaries) {
      const forms = [canary.value, ...(canary.forms ?? [])];
      if (forms.some((form) => haystack.includes(form.toLowerCase()))) {
        leaks.push({ canary: canary.name, source, index });
      }
    }
  });
  return leaks;
}

function stringifyConsoleArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface CanaryRun {
  /** Debug level, so every level is captured. Hand it to the code under test. */
  readonly logger: Logger;
  /** The capture sink behind `logger`, for code that builds its own logger from a sink. */
  readonly sink: Sink;
}

/**
 * Runs `exercise` with a debug-level logger whose lines are captured, and with the console captured
 * too (code that bypasses the logger is caught as well). Returns everything that was written.
 */
export async function captureOutput(
  exercise: (run: CanaryRun) => void | Promise<void>,
): Promise<CapturedLine[]> {
  const lines: CapturedLine[] = [];
  const sink: Sink = (level: Level, line: string) => {
    lines.push({ source: `log:${level}`, line });
  };
  const logger = createLogger({ level: 'debug', sink });
  const restore = captureConsole((method, data) => {
    lines.push({ source: `console:${method}`, line: data.map(stringifyConsoleArgument).join(' ') });
  });
  try {
    await exercise({ logger, sink });
  } finally {
    restore();
  }
  return lines;
}

export interface CanaryCheck {
  readonly canaries: readonly Canary[];
  readonly exercise: (run: CanaryRun) => void | Promise<void>;
  /** Fail when the exercise wrote fewer lines than this (guards against an exercise that logs nothing). */
  readonly minLines?: number;
}

/** Runs the exercise and returns the leaks (empty when clean). */
export async function runCanaryCheck(check: CanaryCheck): Promise<Leak[]> {
  checkCanaries(check.canaries);
  const lines = await captureOutput(check.exercise);
  const minLines = check.minLines ?? 1;
  if (lines.length < minLines) {
    throw new Error(
      `canary check: the exercise wrote ${lines.length} lines, expected at least ${minLines}`,
    );
  }
  return findCanaryLeaks(lines, check.canaries);
}

/** Runs the exercise and throws if any canary appears in any captured line. */
export async function assertNoCanaryLeaks(check: CanaryCheck): Promise<void> {
  const leaks = await runCanaryCheck(check);
  if (leaks.length > 0) {
    const where = leaks
      .map((leak) => `${leak.canary} in ${leak.source} line ${leak.index}`)
      .join('; ');
    throw new Error(`secret canary leaked into output: ${where}`);
  }
}
