// A minimal QR code encoder for the terminal (M1-26-e): byte mode, error level L, version 3 only
// (29 x 29 modules, up to 53 bytes), one block. It exists to show the agent ID (42 bytes) as a code
// the user can scan from their phone, without a dependency (the CLI bundle keeps its small
// allowlisted dependency set). It is not a crypto primitive; it handles public text only.
//
// Version 3-L (ISO/IEC 18004): 70 codewords in total, 55 for data, 15 for error correction, one
// block, one alignment pattern at (22, 22), no version information block, remainder bits 7.

const SIZE = 29;
const DATA_CODEWORDS = 55;
const ECC_CODEWORDS = 15;
const MAX_BYTES = 53;
const QUIET = 4;

// ---- Reed-Solomon over GF(256), polynomial 0x11d --------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}
const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0);

function reedSolomon(data: readonly number[], degree: number): number[] {
  // Generator polynomial: product of (x - 2^i), i = 0..degree-1, highest power first.
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] ?? 0) ^ (gen[j] ?? 0);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(gen[j] ?? 0, EXP[i] ?? 0);
    }
    gen = next;
  }
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rem.shift() ?? 0);
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = (rem[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
  }
  return rem;
}

// ---- Codewords -------------------------------------------------------------------------------------
function codewords(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > MAX_BYTES) throw new RangeError('qr: input too long');
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // character count (8 bits for versions 1-9)
  for (const b of bytes) push(b, 8);
  const capacity = DATA_CODEWORDS * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);
  return [...data, ...reedSolomon(data, ECC_CODEWORDS)];
}

// ---- Matrix ----------------------------------------------------------------------------------------
type Grid = boolean[][];

function emptyGrid(): { modules: Grid; reserved: Grid } {
  const make = (): Grid => Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  return { modules: make(), reserved: make() };
}

function placeFunctionPatterns(modules: Grid, reserved: Grid): void {
  const set = (r: number, c: number, dark: boolean): void => {
    (modules[r] as boolean[])[c] = dark;
    (reserved[r] as boolean[])[c] = true;
  };
  const finder = (top: number, left: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inside &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, SIZE - 7);
  finder(SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment pattern centred at (22, 22).
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      set(22 + r, 22 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    }
  }
  set(4 * 3 + 9, 8, true); // dark module
  // Reserve the format information areas (written per mask later).
  for (let i = 0; i < 9; i++) {
    (reserved[8] as boolean[])[i] = true;
    (reserved[i] as boolean[])[8] = true;
  }
  for (let i = 0; i < 8; i++) {
    (reserved[8] as boolean[])[SIZE - 1 - i] = true;
    (reserved[SIZE - 1 - i] as boolean[])[8] = true;
  }
}

function placeData(modules: Grid, reserved: Grid, words: readonly number[]): void {
  const bits: boolean[] = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push(((w >> i) & 1) === 1);
  let index = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < SIZE; step++) {
      const r = upward ? SIZE - 1 - step : step;
      for (const c of [right, right - 1]) {
        if ((reserved[r] as boolean[])[c]) continue;
        (modules[r] as boolean[])[c] = index < bits.length ? (bits[index] ?? false) : false;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The 15 format bits for error level L (01) and a mask: BCH(15,5) masked with 0x5412. */
function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(modules: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1;
  const m = (r: number, c: number, v: boolean): void => {
    (modules[r] as boolean[])[c] = v;
  };
  // First copy, around the top-left finder: bit 0 (the least significant) at row 0, column 8 (ISO 18004 7.9).
  const first: [number, number][] = [
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
  first.forEach(([r, c], i) => m(r, c, bit(i)));
  // Second copy: bits 0..7 along row 8 from the right edge, bits 8..14 down column 8 below the
  // dark module.
  for (let i = 0; i < 8; i++) m(8, SIZE - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) m(SIZE - 15 + i, 8, bit(i));
}

function penalty(modules: Grid): number {
  let score = 0;
  const line = (get: (i: number) => boolean): void => {
    let run = 1;
    for (let i = 1; i < SIZE; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  };
  for (let i = 0; i < SIZE; i++) {
    line((j) => (modules[i] as boolean[])[j] as boolean);
    line((j) => (modules[j] as boolean[])[i] as boolean);
  }
  for (let r = 0; r < SIZE - 1; r++) {
    for (let c = 0; c < SIZE - 1; c++) {
      const v = (modules[r] as boolean[])[c];
      if (
        v === (modules[r] as boolean[])[c + 1] &&
        v === (modules[r + 1] as boolean[])[c] &&
        v === (modules[r + 1] as boolean[])[c + 1]
      ) {
        score += 3;
      }
    }
  }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (get: (i: number) => boolean, at: number, flip: boolean): boolean =>
    pattern.every((p, k) => get(at + (flip ? pattern.length - 1 - k : k)) === p);
  for (let i = 0; i < SIZE; i++) {
    for (let at = 0; at + pattern.length <= SIZE; at++) {
      for (const flip of [false, true]) {
        if (matches((j) => (modules[i] as boolean[])[j] as boolean, at, flip)) score += 40;
        if (matches((j) => (modules[j] as boolean[])[i] as boolean, at, flip)) score += 40;
      }
    }
  }
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (SIZE * SIZE);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * The QR symbol for `text` (at most 53 bytes) as rows of dark/light modules. `forceMask` (0-7) is
 * for tests; normally the mask with the lowest penalty is used.
 */
export function qrMatrix(text: string, forceMask?: number): boolean[][] {
  const words = codewords(text);
  const { modules: base, reserved } = emptyGrid();
  placeFunctionPatterns(base, reserved);
  placeData(base, reserved, words);
  let best: Grid | undefined;
  let bestScore = Infinity;
  MASKS.forEach((fn, mask) => {
    const modules = base.map((row) => [...row]);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!(reserved[r] as boolean[])[c] && fn(r, c)) {
          (modules[r] as boolean[])[c] = !(modules[r] as boolean[])[c];
        }
      }
    }
    placeFormat(modules, mask);
    const score = forceMask === undefined ? penalty(modules) : mask === forceMask ? 0 : Infinity;
    if (score < bestScore) {
      bestScore = score;
      best = modules;
    }
  });
  return best as Grid;
}

/**
 * The code as text lines, two modules per line (half blocks), with the 4-module quiet zone the
 * standard asks for. Dark modules are the filled blocks and light modules are blanks, so it scans
 * on a light-background terminal; most readers also accept the inverted look on a dark one. Plain
 * characters only: no escape codes.
 */
export function renderQr(text: string): string[] {
  const m = qrMatrix(text);
  const total = SIZE + 2 * QUIET;
  const dark = (r: number, c: number): boolean => {
    const rr = r - QUIET;
    const cc = c - QUIET;
    if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) return false;
    return (m[rr] as boolean[])[cc] as boolean;
  };
  const lines: string[] = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < total ? dark(r + 1, c) : false;
      line += top && bottom ? '\u2588' : top ? '\u2580' : bottom ? '\u2584' : ' ';
    }
    lines.push(line);
  }
  return lines;
}
