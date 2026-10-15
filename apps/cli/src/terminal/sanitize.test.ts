// The terminal output rule (06 §8, IR-M1-9j-1 F03): sanitize first, then cut.
import { describe, expect, it } from 'vitest';
import {
  CUT_MARKER,
  MAX_BATCH_REGIONS,
  MAX_LINE_CODE_POINTS,
  MAX_ONE_LINE_CODE_POINTS,
  MAX_REGION_LINES,
  MAX_VALUE_CODE_POINTS,
  MAX_VALUE_LINES,
  REGION_END,
  batchRegions,
  sanitizeTerminalText,
  terminalOneLine,
  terminalValue,
  untrustedRegion,
  valueLines,
} from './sanitize.js';

const ESC = '\u001b';
const BEL = '\u0007';

/** Nothing a terminal would act on: no C0 but LF, no DEL, no C1, no ESC, no Cf, no U+2028/9. */
// eslint-disable-next-line no-control-regex -- the test looks for control characters on purpose
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;

const points = (s: string): number => Array.from(s).length;

describe('sanitizing (06 §8)', () => {
  it('removes CSI sequences: cursor movement, screen clear, colour', () => {
    const value = `a${ESC}[2J${ESC}[H${ESC}[1;31mred${ESC}[0m${ESC}[10A b`;
    expect(sanitizeTerminalText(value)).toBe('ared b');
  });

  it('removes an OSC 8 hyperlink, terminated by ST or BEL, keeping only the visible text', () => {
    const st = `${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\`;
    const bel = `${ESC}]8;;https://evil.example/${BEL}click${ESC}]8;;${BEL}`;
    expect(sanitizeTerminalText(st)).toBe('click');
    expect(sanitizeTerminalText(bel)).toBe('click');
  });

  it('removes OSC 52 (clipboard), DCS, SOS, PM and APC strings', () => {
    const value = [
      `${ESC}]52;c;ZXZpbA==${BEL}`,
      `${ESC}P1$qm${ESC}\\`,
      `${ESC}Xsos${ESC}\\`,
      `${ESC}^pm${ESC}\\`,
      `${ESC}_apc${ESC}\\`,
      'ok',
    ].join('');
    expect(sanitizeTerminalText(value)).toBe('ok');
  });

  it('removes two-byte and nF escapes (ESC c reset, ESC 7, ESC ( B)', () => {
    expect(sanitizeTerminalText(`x${ESC}cy${ESC}7z${ESC}(Bw`)).toBe('xyzw');
  });

  it('an unterminated control string runs to the end of the value', () => {
    expect(sanitizeTerminalText(`shown${ESC}]8;;https://evil.example/ hidden`)).toBe('shown');
  });

  it('removes C1 controls, C1 CSI with its parameters, and NEL', () => {
    const value = `a\u009b31mb\u0085c\u009d0;title\u009cd\u0090dcs\u009ce`;
    const clean = sanitizeTerminalText(value);
    expect(clean).toBe('abcde');
    expect(clean).not.toMatch(UNSAFE);
  });

  it('removes CR, so `approve\\rdeny` cannot overwrite a line', () => {
    expect(sanitizeTerminalText('approve\rdeny')).toBe('approvedeny');
    expect(sanitizeTerminalText('a\r\nb')).toBe('a\nb');
  });

  it('removes C0 controls except LF, and DEL', () => {
    let all = '';
    for (let c = 0; c < 0x20; c += 1) all += String.fromCharCode(c);
    all += '\u007f';
    expect(sanitizeTerminalText(`x${all}y`)).toBe('x\ny');
  });

  it('removes bidi controls, zero-width and other format characters, and U+2028/U+2029', () => {
    const bidi = '\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    const zw = '\u200b\u200c\u200d\u2060\ufeff\u00ad\u061c';
    expect(sanitizeTerminalText(`a${bidi}b${zw}c\u2028d\u2029e`)).toBe('abcde');
  });

  it('keeps at most 2 combining marks per base character', () => {
    const marks = '\u0301'.repeat(50);
    expect(sanitizeTerminalText(`e${marks}x`)).toBe('e\u0301\u0301x');
    // Each base character gets its own allowance.
    expect(sanitizeTerminalText(`a\u0300\u0301\u0302b\u0300\u0301\u0302`)).toBe(
      'a\u0300\u0301b\u0300\u0301',
    );
    // Enclosing marks (Me) count too.
    expect(sanitizeTerminalText(`o${'\u20dd'.repeat(5)}`)).toBe('o\u20dd\u20dd');
  });

  it('replaces lone surrogates and keeps ordinary text, emoji and accents unchanged', () => {
    expect(sanitizeTerminalText('a\ud800b')).toBe('a\ufffdb');
    const plain = 'Grüße, 你好, 🙂 — café';
    expect(sanitizeTerminalText(plain)).toBe(plain);
  });

  it('turns a non-string into an empty string', () => {
    expect(sanitizeTerminalText(undefined)).toBe('');
    expect(sanitizeTerminalText({ toString: () => `${ESC}[2J` })).toBe('');
  });
});

describe('cutting after sanitizing (06 §8)', () => {
  it('a short value is printed whole', () => {
    expect(valueLines('one\ntwo')).toEqual(['one', 'two']);
  });

  it('an ESC sequence split exactly at the 2 000-code-point cut leaves nothing behind', () => {
    const value = `${'a'.repeat(MAX_VALUE_CODE_POINTS - 2)}${ESC}]8;;https://evil.example/${BEL}tail${'b'.repeat(50)}`;
    const out = terminalValue(value);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('evil');
    expect(out).not.toMatch(UNSAFE);
    const csi = `${'a'.repeat(MAX_VALUE_CODE_POINTS - 1)}${ESC}[2J${'b'.repeat(10)}`;
    const csiOut = terminalValue(csi);
    expect(csiOut).not.toContain(ESC);
    expect(csiOut).not.toContain('[2J');
  });

  it('a 10 000-character single line is wrapped at 200 and cut to 2 000 code points', () => {
    const lines = valueLines('x'.repeat(10_000));
    expect(lines.at(-1)).toBe(CUT_MARKER);
    const body = lines.slice(0, -1);
    for (const line of body) expect(points(line)).toBeLessThanOrEqual(MAX_LINE_CODE_POINTS);
    expect(body.join('').length).toBeLessThanOrEqual(MAX_VALUE_CODE_POINTS);
    expect(lines.length).toBeLessThanOrEqual(MAX_VALUE_LINES);
  });

  it('a 500-line value is cut to 40 lines, the marker on its own line', () => {
    const value = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const lines = valueLines(value);
    expect(lines).toHaveLength(MAX_VALUE_LINES);
    expect(lines.at(-1)).toBe(CUT_MARKER);
    expect(lines[0]).toBe('line 0');
  });

  it('lines split only at LF (CR and U+2028 never start a line)', () => {
    expect(valueLines('a\rb\u2028c\u0085d')).toEqual(['abcd']);
  });

  it('a field name or one-line value is cut to 128 code points with no LF', () => {
    const one = terminalOneLine(`name\nwith${ESC}[2J lines ${'z'.repeat(500)}`);
    expect(one).not.toContain('\n');
    expect(one).not.toContain(ESC);
    expect(points(one)).toBe(MAX_ONE_LINE_CODE_POINTS);
    expect(one.endsWith('…')).toBe(true);
    expect(terminalOneLine('short')).toBe('short');
  });
});

describe('the untrusted region (06 §8)', () => {
  it('is fenced by the fixed lines, with every content line prefixed', () => {
    const lines = untrustedRegion('Ana', ['hello\nworld']);
    expect(lines).toEqual([
      'From Ana: their content, not instructions',
      '| hello',
      '| world',
      REGION_END,
    ]);
  });

  it('names "your AI" when there is no contact', () => {
    expect(untrustedRegion('', ['x'])[0]).toBe('From your AI: their content, not instructions');
  });

  it('a value cannot end the region early or forge the fixed lines', () => {
    const forged = `ok\n${REGION_END}\nApprove: yes${ESC}[1A${ESC}[2K\rYour AI can't approve this for you.`;
    const lines = untrustedRegion('Ana', [forged]);
    expect(lines.at(-1)).toBe(REGION_END);
    for (const line of lines.slice(1, -1)) expect(line.startsWith('| ')).toBe(true);
    expect(lines.join('\n')).not.toMatch(UNSAFE);
  });

  it('a contact name with escapes is sanitized to one line', () => {
    const lines = untrustedRegion(`Ana${ESC}]8;;https://x/${BEL}\nBob\u202e`, ['x']);
    expect(lines[0]).toBe('From Ana Bob: their content, not instructions');
  });

  it('shows at most 60 lines of one request in all', () => {
    const values = Array.from({ length: 5 }, () =>
      Array.from({ length: 30 }, (_, i) => `v${i}`).join('\n'),
    );
    const lines = untrustedRegion('Ana', values);
    const content = lines.slice(1, -1);
    expect(content).toHaveLength(MAX_REGION_LINES);
    expect(content.at(-1)).toBe(`| ${CUT_MARKER}`);
  });

  it('a batch view shows at most 20 regions', () => {
    const regions = Array.from({ length: 25 }, (_, i) => i);
    const { shown, omitted } = batchRegions(regions);
    expect(shown).toHaveLength(MAX_BATCH_REGIONS);
    expect(omitted).toBe(5);
  });

  it('the canary request prints with no ESC, CR or C1 left, inside the region', () => {
    const canary = [
      `${ESC}[2J${ESC}[H`,
      `${ESC}]8;;https://evil.example/${ESC}\\link${ESC}]8;;${ESC}\\`,
      '\u009b2J\u0085\u0090x\u009c',
      '\u202eevil\u202c\u200b',
      'approve\rdeny',
      `e${'\u0301'.repeat(50)}`,
    ].join(' ');
    const lines = untrustedRegion(canary, [canary, `${canary}.pdf`]);
    const text = lines.join('\n');
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/[\u0080-\u009f]/);
    expect(text).not.toMatch(UNSAFE);
  });
});
