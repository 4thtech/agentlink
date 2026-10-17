// M1-15: hostile download names (04 §4 "Downloads"; M1-7f acceptance names).
import { describe, expect, it } from 'vitest';
import { FALLBACK_FILE_NAME, MAX_FILE_NAME_BYTES, sanitizeFileName } from './file-name.js';

const cp = (...n: number[]): string => String.fromCodePoint(...n);
// UTF-8 byte count, computed independently of the implementation.
const utf8 = (s: string): number => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, 'x').length;

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../.ssh/x', 'x'],
    ['../../.ssh/authorized_keys', 'authorized_keys'],
    ['..\\..\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\me\\evil.exe', 'evil.exe'],
    ['.bashrc', 'bashrc'],
    ['...hidden', 'hidden'],
    ['..', FALLBACK_FILE_NAME],
    ['.', FALLBACK_FILE_NAME],
    ['', FALLBACK_FILE_NAME],
    ['   ', FALLBACK_FILE_NAME],
    ['dir/', FALLBACK_FILE_NAME],
    ['a\u0000b.txt', 'ab.txt'],
    ['line\nbreak\r.txt', 'linebreak.txt'],
    ['bell\u0007.txt', 'bell.txt'],
    ['esc\u001b[31mred.txt', 'esc[31mred.txt'],
    ['del\u007f.txt', 'del.txt'],
    ['file.txt:stream', 'file.txt_stream'],
    ['a<b>c"d|e?f*g.txt', 'a_b_c_d_e_f_g.txt'],
    ['name. . .', 'name'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['NUL', '_NUL'],
    ['aux.tar.gz', '_aux.tar.gz'],
    ['COM1', '_COM1'],
    ['lpt9.log', '_lpt9.log'],
    ['CONIN$', '_CONIN$'],
    ['console.txt', 'console.txt'],
    ['com10', 'com10'],
    [42, FALLBACK_FILE_NAME],
    [undefined, FALLBACK_FILE_NAME],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('refuses superscript-digit device names (LPT¹, COM²)', () => {
    expect(sanitizeFileName(`LPT${cp(0xb9)}`)).toBe(`_LPT${cp(0xb9)}`);
    expect(sanitizeFileName(`com${cp(0xb2)}.txt`)).toBe(`_com${cp(0xb2)}.txt`);
  });

  it('prefixes device names followed by spaces before the extension (IR-M1-15-1 L3)', () => {
    expect(sanitizeFileName('CON .txt')).toBe('_CON .txt');
    expect(sanitizeFileName('nul .txt')).toBe('_nul .txt');
    expect(sanitizeFileName('com1   .log')).toBe('_com1   .log');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('CONTRACT .txt')).toBe('CONTRACT .txt');
  });

  it('removes line separators, tag characters and variation selectors (IR-M1-15-1 L3)', () => {
    expect(sanitizeFileName(`a${cp(0x2028)}b${cp(0x2029)}.txt`)).toBe('ab.txt');
    expect(sanitizeFileName(`x${cp(0xe0041, 0xe0042, 0xe007f)}.txt`)).toBe('x.txt');
    expect(sanitizeFileName(`y${cp(0xfe0f)}${cp(0xfe00)}${cp(0xe0100)}${cp(0xe01ef)}.txt`)).toBe(
      'y.txt',
    );
    expect(sanitizeFileName(`.${cp(0xe0020)}ssh`)).toBe('ssh');
    expect(sanitizeFileName(`z${cp(0x180b)}.txt`)).toBe('z.txt');
  });

  it('removes bidi overrides that disguise the extension', () => {
    // "invoice<RLO>fdp.exe" renders as "invoiceexe.pdf"
    expect(sanitizeFileName(`invoice${cp(0x202e)}fdp.exe`)).toBe('invoicefdp.exe');
    expect(sanitizeFileName(`a${cp(0x2066)}b${cp(0x2069)}.txt`)).toBe('ab.txt');
    expect(sanitizeFileName(`x${cp(0x200f)}${cp(0x061c)}.txt`)).toBe('x.txt');
  });

  it('removes zero-width and format characters, also around separators and dots', () => {
    expect(sanitizeFileName(`.${cp(0x200b)}ssh`)).toBe('ssh');
    expect(sanitizeFileName(`${cp(0xfeff)}.env`)).toBe('env');
    expect(sanitizeFileName(`..${cp(0x200b)}/..${cp(0x200d)}/x`)).toBe('x');
    expect(sanitizeFileName(`soft${cp(0xad)}hyphen`)).toBe('softhyphen');
  });

  it('removes C1 controls and lone surrogates', () => {
    expect(sanitizeFileName(`a${cp(0x85)}b${cp(0x9b)}c`)).toBe('abc');
    expect(sanitizeFileName(`a${String.fromCharCode(0xd800)}b`)).toBe('ab');
    expect(sanitizeFileName(`a${String.fromCharCode(0xdc00)}b`)).toBe('ab');
  });

  it('keeps legitimate non-ASCII names and astral characters', () => {
    expect(sanitizeFileName('Poročilo č.1.pdf')).toBe('Poročilo č.1.pdf');
    expect(sanitizeFileName(`smile${cp(0x1f600)}.png`)).toBe(`smile${cp(0x1f600)}.png`);
  });

  it('normalises to NFC', () => {
    expect(sanitizeFileName('c\u030c.txt')).toBe('\u010d.txt');
  });

  it('turns look-alike slashes into underscores', () => {
    expect(sanitizeFileName(`..${cp(0x2215)}..${cp(0x2215)}etc`)).toBe('_.._etc');
    expect(sanitizeFileName(`a${cp(0xff0f)}b${cp(0xff3c)}c`)).toBe('a_b_c');
  });

  it('caps the name at 255 UTF-8 bytes and keeps a short extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const out = sanitizeFileName(long);
    expect(utf8(out)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(out.endsWith('.pdf')).toBe(true);
    const wide = `${'\u010d'.repeat(300)}.txt`;
    const outWide = sanitizeFileName(wide);
    expect(utf8(outWide)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(outWide.endsWith('.txt')).toBe(true);
    const astral = cp(0x1f600).repeat(100);
    const outAstral = sanitizeFileName(astral);
    expect(utf8(outAstral)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect([...outAstral].every((c) => c === cp(0x1f600))).toBe(true);
  });

  it('always yields one segment with no separator, no leading dot and no control character', () => {
    const hostile = [
      '../../.ssh/id_ed25519',
      '..\\..\\.agentlink\\agent.alko',
      `\u0000/.\u0001\\.${cp(0x202e)}gpj.exe`,
      '/./.././.',
      `~/${cp(0x2024)}${cp(0x2024)}/x`,
    ];
    for (const name of hostile) {
      const out = sanitizeFileName(name);
      expect(out).not.toMatch(/[/\\]/);
      expect(out.startsWith('.')).toBe(false);
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
