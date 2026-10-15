// The pinned UCD 15.0.0 character categories (D-74, 04 §3.4 "Characters") and the runtime check.
//
// The category table is shipped (ucd15.ts, generated), never taken from the runtime, so the refused
// set is the same in every runtime. Only NFC uses the runtime's normalisation, which is why the
// runtime must implement Unicode 15.0 or later (the probe below).
import { UCD15_REFUSED_CATEGORIES, UCD15_REFUSED_RANGES } from './ucd15.js';

export type RefusedCategory = (typeof UCD15_REFUSED_CATEGORIES)[number];

const RANGE_COUNT = UCD15_REFUSED_RANGES.length / 3;

/**
 * The UCD 15.0.0 General_Category of `cp` if it is one the terms rule refuses (Cc, Cf, Zl, Zp, Co,
 * Cs or Cn, unassigned and noncharacters included), else null. Out-of-range input: null.
 */
export function refusedCategory15(cp: number): RefusedCategory | null {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null;
  let lo = 0;
  let hi = RANGE_COUNT - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const first = UCD15_REFUSED_RANGES[mid * 3] as number;
    const last = UCD15_REFUSED_RANGES[mid * 3 + 1] as number;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return UCD15_REFUSED_CATEGORIES[UCD15_REFUSED_RANGES[mid * 3 + 2] as number] ?? null;
  }
  return null;
}

/** True when some code point of `s` has one of `categories` in UCD 15.0.0 (a lone surrogate is Cs). */
export function hasCategory15(s: string, categories: ReadonlySet<RefusedCategory>): boolean {
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    const category = refusedCategory15(cp);
    if (category !== null && categories.has(category)) return true;
  }
  return false;
}

/** The fixed error code for a runtime older than Unicode 15.0 (04 §3.4 "Runtime check"). */
export const UNSUPPORTED_RUNTIME = 'UNSUPPORTED_RUNTIME';

// U+10EFD is new in 15.0 with combining class 220, so NFC reorders it before U+0301 (class 230); an
// older runtime treats it as class 0 and leaves the string unchanged (04 §3.4 "Runtime check").
const probe = (): boolean => {
  try {
    return 'x́\u{10EFD}'.normalize('NFC') === 'x\u{10EFD}́';
  } catch {
    return false;
  }
};
const SUPPORTED = probe();

/**
 * True when this runtime implements Unicode 15.0 or later. When false, every terms string is refused
 * and the core refuses every `terms` body with UNSUPPORTED_RUNTIME; it never falls back.
 */
export const isTermsRuntimeSupported = (): boolean => SUPPORTED;
