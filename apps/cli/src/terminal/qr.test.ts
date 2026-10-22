// The terminal QR renderer (M1-26-e): a small fixed-version QR encoder for the agent ID. Structural
// checks here; the decode check was done once by hand with the platform's QR detector.
import { describe, expect, it } from 'vitest';
import { qrMatrix, renderQr } from './qr.js';

const ID = `0x${'1'.repeat(40)}`;

describe('qrMatrix', () => {
  it('is a 29x29 version 3 symbol for a 42-byte agent ID', () => {
    const m = qrMatrix(ID);
    expect(m.length).toBe(29);
    expect(m.every((row) => row.length === 29)).toBe(true);
  });

  it('has the three finder patterns, the timing lines and the dark module', () => {
    const m = qrMatrix(ID);
    const finder = (r: number, c: number): boolean => {
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          const edge = i === 0 || i === 6 || j === 0 || j === 6;
          const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          if (m[r + i]?.[c + j] !== (edge || core)) return false;
        }
      }
      return true;
    };
    expect(finder(0, 0)).toBe(true);
    expect(finder(0, 22)).toBe(true);
    expect(finder(22, 0)).toBe(true);
    for (let i = 8; i < 21; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0);
      expect(m[i]?.[6]).toBe(i % 2 === 0);
    }
    // Dark module at (4 * version + 9, 8).
    expect(m[21]?.[8]).toBe(true);
    // The version 3 alignment pattern is centred at (22, 22).
    expect(m[22]?.[22]).toBe(true);
    expect(m[22]?.[21]).toBe(false);
    expect(m[20]?.[20]).toBe(true);
  });

  it('carries valid format information for error level L (BCH 15,5)', () => {
    const m = qrMatrix(ID);
    // Read the first copy: bit 0 at row 0, column 8 up to bit 14 at row 8, column 0 (ISO 18004).
    const cells: [number, number][] = [
      [0, 8],
      [1, 8],
      [2, 8],
      [3, 8],
      [4, 8],
      [5, 8],
      [7, 8],
      [8, 8],
      [8, 7],
      [8, 5],
      [8, 4],
      [8, 3],
      [8, 2],
      [8, 1],
      [8, 0],
    ];
    let value = 0;
    cells.forEach(([r, c], k) => {
      value |= (m[r]?.[c] ? 1 : 0) << k;
    });
    const data = (value ^ 0x5412) >> 10;
    // Error level L is 01; the mask pattern is the low three bits.
    expect(data >> 3).toBe(1);
    // BCH check: the unmasked 15-bit word is divisible by the generator 0x537.
    let rem = value ^ 0x5412;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    expect(rem).toBe(0);
    // The second copy holds the same bits.
    let second = 0;
    for (let i = 0; i < 8; i++) second |= (m[8]?.[28 - i] ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) second |= (m[14 + i]?.[8] ? 1 : 0) << i;
    expect(second).toBe(value);
  });

  it('is deterministic and depends on the input', () => {
    expect(qrMatrix(ID)).toEqual(qrMatrix(ID));
    expect(qrMatrix(ID)).not.toEqual(qrMatrix(`0x${'2'.repeat(40)}`));
  });

  it('refuses input that does not fit one symbol (more than 53 bytes)', () => {
    expect(() => qrMatrix('x'.repeat(54))).toThrow();
    expect(() => qrMatrix('x'.repeat(53))).not.toThrow();
  });
});

describe('renderQr', () => {
  it('draws two modules per text line with a 4-module quiet zone, using plain block characters only', () => {
    const lines = renderQr(ID);
    // (29 + 2 * 4) modules high, two per line, rounded up.
    expect(lines.length).toBe(19);
    const width = lines[0]?.length ?? 0;
    expect(width).toBe(37);
    expect(lines.every((l) => l.length === width)).toBe(true);
    expect(lines.join('')).toMatch(/^[ \u2580\u2584\u2588]+$/);
    // No escape codes: the sanitizer and a pipe both leave it intact.
    expect(lines.join('')).not.toContain('\u001b');
  });

  it('dark modules are filled and the quiet zone is blank (scans on a light background)', () => {
    const lines = renderQr(ID);
    // The first four module rows are the quiet zone: two blank lines, and every line starts blank.
    expect(lines[0]).toBe(' '.repeat(37));
    expect(lines[1]).toBe(' '.repeat(37));
    expect(lines.every((l) => l.startsWith('    ') && l.endsWith('    '))).toBe(true);
    // Module rows 4 and 5 are the top two rows of a finder pattern: all dark over edge-only dark.
    expect(lines[2]?.slice(4, 11)).toBe('\u2588\u2580\u2580\u2580\u2580\u2580\u2588');
  });
});

describe('known answer', () => {
  // The full 29 x 29 matrix for this input as produced by a reference encoder (Apple's
  // CIQRCodeGenerator, error level L, border removed). '1' is a dark module. The input is plain
  // lowercase text so every encoder uses byte mode for it. The reference chose mask 3.
  const INPUT = 'the quick brown fox jumps over a lazy dog';
  const REFERENCE = [
    '11111110110001101111101111111',
    '10000010000000100110001000001',
    '10111010100111111011101011101',
    '10111010110101001100101011101',
    '10111010111100111111001011101',
    '10000010010011000001001000001',
    '11111110101010101010101111111',
    '00000000010100100101100000000',
    '11110010100000101110010011101',
    '00010000110000001001111110011',
    '01111010100000000000111110100',
    '01011001100111000011010000011',
    '11110011110101100110000101100',
    '01100100101101111101111000101',
    '00000111011010101001011010011',
    '10110001100010110010001011010',
    '11000011001101000011010111001',
    '01110001010011011100100100000',
    '10010111001111111100101011000',
    '00011001001010000111001101100',
    '01001111101111001110111111111',
    '00000000111011001000100010101',
    '11111110010111000011101011110',
    '10000010001000001000100010011',
    '10111010011010110100111110111',
    '10111010101110110100000110101',
    '10111010100101001010000000101',
    '10000010101100100000110101010',
    '11111110101010101011100110010',
  ];
  const text = (m: boolean[][]): string[] =>
    m.map((row) => row.map((v) => (v ? '1' : '0')).join(''));

  it('matches the reference encoder module for module', () => {
    expect(text(qrMatrix(INPUT))).toEqual(REFERENCE);
  });

  it('the mask the encoder picks is the reference mask, and the others differ', () => {
    expect(text(qrMatrix(INPUT, 3))).toEqual(REFERENCE);
    expect(text(qrMatrix(INPUT, 2))).not.toEqual(REFERENCE);
  });
});
