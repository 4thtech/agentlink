// W4-MOTION-KIT (S0): the e2e motion helper every wave-4 UI unit uses in its journey chapter (W4 UI
// re-brief, acceptance for every unit: a reduced-motion run with fades only and no pulse, and a
// layout-shift check with CLS ≤ 0.01). Playwright only; no new dependency.
//
//   await observeLayoutShift(page);          // before the interaction under test
//   ...drive the page...
//   await expectStableLayout(page);          // throws with the shifted nodes when CLS > 0.01
//
//   await emulateReducedMotion(page);        // prefers-reduced-motion: reduce
//   ...start the transition or moment...
//   await expectFadesOnly(page);             // throws when anything running moves or loops
//
// Shifts within 500 ms of input do not count (the layout-shift entry's own hadRecentInput), the
// same rule as the CLS metric. Nothing here reads page text into a report beyond node names.
import type { Page } from 'playwright';

/** The layout-shift budget of every wave-4 screen (W4 UX v2: CLS ≈ 0). */
export const CLS_BUDGET = 0.01;

/** Emulate the system reduced-motion setting (on by default; `false` turns it off again). */
export async function emulateReducedMotion(page: Page, reduced = true): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
}

interface ClsState {
  score: number;
  shifts: { value: number; nodes: string[] }[];
  unsupported?: boolean;
}

/** Installed in the page: sums layout-shift entries without recent input into `window.__alCls`. */
function installObserver(): void {
  const w = window as unknown as { __alCls?: ClsState };
  if (w.__alCls !== undefined) return;
  const state: ClsState = { score: 0, shifts: [] };
  w.__alCls = state;
  const name = (n: Node | null | undefined): string => {
    if (n === null || n === undefined) return '?';
    const el = n as Element;
    const cls =
      typeof el.className === 'string' && el.className !== ''
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    return `${n.nodeName.toLowerCase()}${cls}`;
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: { node?: Node | null }[];
        };
        if (e.hadRecentInput) continue;
        state.score += e.value;
        state.shifts.push({ value: e.value, nodes: (e.sources ?? []).map((s) => name(s.node)) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    state.unsupported = true;
  }
}

/** Start counting layout shifts now and after every later navigation of this page. */
export async function observeLayoutShift(page: Page): Promise<void> {
  await page.addInitScript(installObserver);
  await page.evaluate(installObserver);
}

/** Wait two frames so pending layout-shift entries are delivered. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
}

async function clsState(page: Page): Promise<ClsState> {
  await frames(page);
  const state = await page.evaluate(
    () => (window as unknown as { __alCls?: ClsState }).__alCls ?? null,
  );
  if (state === null) throw new Error('observeLayoutShift(page) was not called on this page');
  if (state.unsupported === true) throw new Error('this browser reports no layout-shift entries');
  return state;
}

/** The layout-shift score since observeLayoutShift (shifts after recent input excluded). */
export async function layoutShiftScore(page: Page): Promise<number> {
  return (await clsState(page)).score;
}

/** Throws when the layout shifted more than `max` (default CLS_BUDGET); returns the score. */
export async function expectStableLayout(page: Page, max = CLS_BUDGET): Promise<number> {
  const state = await clsState(page);
  if (state.score > max) {
    const detail = state.shifts
      .map((s) => `${s.value.toFixed(4)} [${s.nodes.join(', ')}]`)
      .join('; ');
    throw new Error(`layout shift ${state.score.toFixed(4)} is over ${max}: ${detail}`);
  }
  return state.score;
}

/** One running animation: its name, target, pseudo-element, the properties it moves, and loops. */
export interface RunningAnimation {
  name: string;
  target: string;
  pseudo: string | null;
  properties: string[];
  infinite: boolean;
}

/** The animations running now (CSS, Web Animations and View Transition pseudo-elements). */
export async function runningAnimations(page: Page): Promise<RunningAnimation[]> {
  return page.evaluate(() => {
    const SKIP = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    return document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const effect = a.effect as KeyframeEffect | null;
        const props = new Set<string>();
        for (const frame of effect?.getKeyframes() ?? []) {
          for (const k of Object.keys(frame)) if (!SKIP.has(k)) props.add(k);
        }
        const el = effect?.target ?? null;
        const timing = effect?.getComputedTiming();
        return {
          name: (a as Animation & { animationName?: string }).animationName ?? a.id ?? '',
          target: el === null ? '?' : el.nodeName.toLowerCase(),
          pseudo: effect?.pseudoElement ?? null,
          properties: [...props].sort(),
          infinite: timing?.iterations === Infinity,
        };
      });
  });
}

/**
 * The reduced-motion check: everything running only fades (opacity) and nothing loops (no pulse,
 * no shimmer, no spinner). Throws with the offending animations.
 */
export async function expectFadesOnly(page: Page): Promise<void> {
  const bad = (await runningAnimations(page)).filter(
    (a) => a.infinite || a.properties.some((p) => p !== 'opacity'),
  );
  if (bad.length > 0) {
    const detail = bad
      .map(
        (a) =>
          `${a.name || '(unnamed)'} on ${a.target}${a.pseudo ?? ''}: ${a.properties.join(', ')}${a.infinite ? ', loops' : ''}`,
      )
      .join('; ');
    throw new Error(`motion under reduced motion is not fades only: ${detail}`);
  }
}
