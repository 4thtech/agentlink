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
    // Read the first copy: bit 0 at (8, 0) up to bit 14 at (0, 8).
    const cells: [number, number][] = [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
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
  it('draws two modules per text line with a quiet zone, using plain block characters only', () => {
    const lines = renderQr(ID);
    // (29 + 2 * 2) modules high, two per line, rounded up.
    expect(lines.length).toBe(17);
    const width = lines[0]?.length ?? 0;
    expect(width).toBe(33);
    expect(lines.every((l) => l.length === width)).toBe(true);
    expect(lines.join('')).toMatch(/^[ ▀▄█]+$/);
    // No escape codes: the sanitizer and a pipe both leave it intact.
    expect(lines.join('')).not.toContain('\u001b');
  });
});
