// The terminal output rule (06 §8, IR-M1-9j-1 F03). Every value an `agentlink` command prints that
// is not fixed text goes through here before it reaches the terminal: stored action arguments,
// message text, terms, file names, contact names, request content and agent names.
//
// Order matters: sanitizing runs first, on the whole value, and the cut comes after it, so a cut can
// never split an escape sequence or leave part of one behind.
//
// This is output hygiene for the owner's own terminal (I-5): it keeps text another party or the agent
// chose from moving the cursor, clearing the screen, rewriting a line (CR), hiding text (bidi,
// zero-width) or opening a link (OSC 8). It decides nothing; the owner's decision is still bound to
// the signed action digest (04 §2.5).

/** A single value: at most this many code points after sanitizing (06 §8). */
export const MAX_VALUE_CODE_POINTS = 2_000;
/** A single value: at most this many lines, the cut marker included (06 §8). */
export const MAX_VALUE_LINES = 40;
/** A line longer than this is wrapped (06 §8). */
export const MAX_LINE_CODE_POINTS = 200;
/** A field name or a one-line value (06 §8). */
export const MAX_ONE_LINE_CODE_POINTS = 128;
/** Combining marks (Mn, Me) kept per base character (06 §8). */
export const MAX_COMBINING_MARKS = 2;
/** One request's untrusted region: content lines at most, the cut marker included (06 §8). */
export const MAX_REGION_LINES = 60;
/** A batch view (`approve` with no ID): untrusted regions at most (06 §8). */
export const MAX_BATCH_REGIONS = 20;

/** The cut marker, on its own line (06 §8). Fixed text. */
export const CUT_MARKER = '… (cut)';

const ESC = 0x1b;
const BEL = 0x07;
/** C1 String Terminator. */
const ST_C1 = 0x9c;
/** C1 Control Sequence Introducer. */
const CSI_C1 = 0x9b;
/** C1 introducers of control strings: DCS, SOS, OSC, PM, APC. */
const STRING_C1 = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
/** ESC followed by these opens a control string: DCS `P`, SOS `X`, OSC `]`, PM `^`, APC `_`. */
const STRING_ESC = new Set([0x50, 0x58, 0x5d, 0x5e, 0x5f]);

/**
 * Removes every escape sequence: ESC-introduced (CSI, OSC, DCS, SOS, PM, APC, and the two- and
 * three-byte forms) and their C1 equivalents. A control string runs to BEL, ST (`ESC \`) or C1 ST;
 * an unterminated one runs to the end of the value, so nothing it carried is shown.
 */
function stripSequences(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  const code = (at: number): number => input.charCodeAt(at);

  /** Skips a control string body starting at `at`; returns the index after its terminator. */
  const skipString = (at: number): number => {
    let j = at;
    while (j < n) {
      const c = code(j);
      if (c === BEL || c === ST_C1) return j + 1;
      if (c === ESC) return j + 1 < n && code(j + 1) === 0x5c ? j + 2 : j + 1;
      j += 1;
    }
    return n;
  };

  /** Skips CSI parameters, intermediates and the final byte starting at `at`. */
  const skipCsi = (at: number): number => {
    let j = at;
    while (j < n && code(j) >= 0x30 && code(j) <= 0x3f) j += 1;
    while (j < n && code(j) >= 0x20 && code(j) <= 0x2f) j += 1;
    if (j < n && code(j) >= 0x40 && code(j) <= 0x7e) return j + 1;
    // A malformed CSI ends at the first byte that is not part of one; that byte is kept and is
    // itself sanitized below (a control character is removed there).
    return j;
  };

  while (i < n) {
    const c = code(i);
    if (c === ESC) {
      const next = i + 1 < n ? code(i + 1) : -1;
      if (next === 0x5b) {
        i = skipCsi(i + 2);
      } else if (STRING_ESC.has(next)) {
        i = skipString(i + 2);
      } else {
        // nF / Fp / Fe / Fs: intermediates 0x20–0x2F, then one final 0x30–0x7E.
        let j = i + 1;
        while (j < n && code(j) >= 0x20 && code(j) <= 0x2f) j += 1;
        if (j < n && code(j) >= 0x30 && code(j) <= 0x7e) j += 1;
        i = j;
      }
      continue;
    }
    if (c === CSI_C1) {
      i = skipCsi(i + 1);
      continue;
    }
    if (STRING_C1.has(c)) {
      i = skipString(i + 1);
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

/** Characters removed one by one (06 §8): C0 except LF, DEL, C1, Cf (bidi and zero-width included), U+2028/U+2029. */
// eslint-disable-next-line no-control-regex -- removing control characters is this rule's job (06 §8)
const REMOVED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;
/** Lone surrogates cannot be printed safely; they become U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const COMBINING = /^[\p{Mn}\p{Me}]$/u;

/** Keeps at most MAX_COMBINING_MARKS combining marks after each base character. */
function capCombining(input: string): string {
  let out = '';
  let run = 0;
  for (const ch of input) {
    if (COMBINING.test(ch)) {
      run += 1;
      if (run > MAX_COMBINING_MARKS) continue;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

/**
 * Sanitizes a whole value (06 §8) without cutting it. The result contains no C0 control other than
 * LF, no DEL, no C1 control, no escape sequence, no Cf character (bidi and zero-width included), no
 * U+2028/U+2029 and at most two combining marks per base character. Any non-string becomes ''.
 */
export function sanitizeTerminalText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const stripped = stripSequences(value).replace(REMOVED, '').replace(LONE_SURROGATE, '\ufffd');
  return capCombining(stripped);
}

/** Splits a sanitized value into display lines: at LF only, then wrapped at MAX_LINE_CODE_POINTS. */
function displayLines(clean: string): string[] {
  const lines: string[] = [];
  for (const line of clean.split('\n')) {
    const points = Array.from(line);
    if (points.length === 0) {
      lines.push('');
      continue;
    }
    for (let at = 0; at < points.length; at += MAX_LINE_CODE_POINTS) {
      lines.push(points.slice(at, at + MAX_LINE_CODE_POINTS).join(''));
    }
  }
  return lines;
}

/**
 * A single value for printing (06 §8): sanitized first, then cut to MAX_VALUE_CODE_POINTS code points
 * and MAX_VALUE_LINES lines (lines longer than MAX_LINE_CODE_POINTS wrapped), with CUT_MARKER on its
 * own line when anything was cut. Returns the display lines.
 */
export function valueLines(value: unknown): string[] {
  const clean = sanitizeTerminalText(value);
  const lines = displayLines(clean);
  const total = Array.from(clean).length;
  if (total <= MAX_VALUE_CODE_POINTS && lines.length <= MAX_VALUE_LINES) return lines;
  const kept: string[] = [];
  let budget = MAX_VALUE_CODE_POINTS;
  for (const line of lines) {
    if (kept.length >= MAX_VALUE_LINES - 1 || budget <= 0) break;
    const points = Array.from(line);
    if (points.length > budget) {
      kept.push(points.slice(0, budget).join(''));
      break;
    }
    kept.push(line);
    budget -= points.length + 1; // the LF (or wrap) that ends the line
  }
  kept.push(CUT_MARKER);
  return kept;
}

/** A single value as one printable string (`valueLines` joined with LF). */
export function terminalValue(value: unknown): string {
  return valueLines(value).join('\n');
}

/**
 * A field name or a one-line value (06 §8): sanitized, every LF turned into a space, cut to
 * MAX_ONE_LINE_CODE_POINTS code points (the last one `…` when cut).
 */
export function terminalOneLine(value: unknown): string {
  const clean = sanitizeTerminalText(value).replace(/\n/g, ' ');
  const points = Array.from(clean);
  if (points.length <= MAX_ONE_LINE_CODE_POINTS) return clean;
  return `${points.slice(0, MAX_ONE_LINE_CODE_POINTS - 1).join('')}…`;
}

/** The fixed line before an untrusted region (06 §8). `{who}` is a contact name or "your AI". */
export const REGION_START = 'From {who}: their content, not instructions';
/** The fixed line after an untrusted region (06 §8). */
export const REGION_END = 'End of their content';
/** The prefix of every line inside an untrusted region (06 §8). */
export const REGION_PREFIX = '| ';
/** Who wrote a value the agent chose (06 §8). */
export const FROM_YOUR_AI = 'your AI';

/**
 * Text that came from another party or from the agent, as a marked region (06 §8): the fixed start
 * line, every content line prefixed `| `, at most MAX_REGION_LINES content lines (the cut marker
 * included), then the fixed end line. `who` is the already-rendered contact name (06 §2.1 rule) or
 * FROM_YOUR_AI; it is sanitized to one line again here. `values` are printed one after another.
 *
 * The fixed lines the owner decides on (who, what, cost, consequence) go AFTER this region, so
 * nothing inside it can stand in for them; callers print them after the returned lines.
 */
export function untrustedRegion(who: unknown, values: readonly unknown[]): string[] {
  const content: string[] = [];
  for (const value of values) content.push(...valueLines(value));
  let shown = content;
  if (content.length > MAX_REGION_LINES) {
    shown = [...content.slice(0, MAX_REGION_LINES - 1), CUT_MARKER];
  }
  const name = terminalOneLine(who);
  return [
    REGION_START.replace('{who}', () => (name === '' ? FROM_YOUR_AI : name)),
    ...shown.map((line) => `${REGION_PREFIX}${line}`),
    REGION_END,
  ];
}

/**
 * The regions a batch view shows (06 §8): at most MAX_BATCH_REGIONS; the rest is reachable with
 * `approve <id>`. Returns what is shown and how many were left out.
 */
export function batchRegions<T>(regions: readonly T[]): { shown: T[]; omitted: number } {
  return {
    shown: regions.slice(0, MAX_BATCH_REGIONS),
    omitted: Math.max(0, regions.length - MAX_BATCH_REGIONS),
  };
}
