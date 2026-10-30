// W4-MOTION-KIT (S0): the e2e motion helper (helpers/motion.ts) against the real kit stylesheets
// (packages/ui tokens.css and motion.css) in Chromium. It proves the helper itself: the layout-shift
// observer measures a real shift and stays at 0 on a still page; the reduced-motion emulation reaches
// matchMedia; the live-dot pulse loops normally and is gone under reduced motion; a page change with
// a View Transition moves (transform) normally and only fades under reduced motion. Every UI unit of
// wave 4 calls the same helper from its journey chapter.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLS_BUDGET,
  emulateReducedMotion,
  expectFadesOnly,
  expectStableLayout,
  layoutShiftScore,
  observeLayoutShift,
  runningAnimations,
} from './motion.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../packages/ui/src/${rel}`, import.meta.url)), 'utf8');
const KIT_CSS = `${read('tokens/tokens.css')}\n${read('components/motion.css')}`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<header class="al-vt-top">AgentLink</header>
<main class="al-vt-main"><h1>Home</h1><p>Two people</p></main>
<span class="al-pulse" data-tone="success" aria-hidden="true"><span class="al-pulse-dot"></span><span class="al-pulse-ring"></span></span>
</body></html>`;

let browser: Browser | undefined;
let launchError: unknown;
let page: Page;

beforeAll(async () => {
  // The same launch as app-world.ts, without its built-package imports (this test needs none).
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(async (ctx) => {
  if (browser === undefined) {
    if (process.env['CI'] !== undefined) throw launchError;
    ctx.skip();
    return;
  }
  page = await browser.newPage();
  // A real navigation: setContent marks the next layout shifts as after input (hadRecentInput).
  await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
  await page.addStyleTag({ content: KIT_CSS });
});
afterEach(async () => {
  await page?.close();
});

/** Start a page change and return once its pseudo-elements are animating. */
async function startPageChange(p: Page): Promise<void> {
  await p.evaluate(async () => {
    const main = document.querySelector('.al-vt-main') as HTMLElement;
    const t = document.startViewTransition(() => {
      main.innerHTML = '<h1>People</h1><p>Ana, Denis</p>';
    });
    await t.ready;
  });
}

describe('layout shift', () => {
  it('reads 0 on a page that holds still, and expectStableLayout passes', async () => {
    await observeLayoutShift(page);
    await page.evaluate(() => {
      (document.querySelector('main p') as HTMLElement).textContent = 'Three people';
    });
    expect(await layoutShiftScore(page)).toBeLessThanOrEqual(CLS_BUDGET);
    await expect(expectStableLayout(page)).resolves.toBeLessThanOrEqual(CLS_BUDGET);
  });

  it('measures content pushed down by a late banner, and expectStableLayout fails', async () => {
    await observeLayoutShift(page);
    await page.evaluate(async () => {
      // Let the first layout paint, so the content has a place to shift from.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // A tall block arriving above the content, the way an unreserved notice would.
      const banner = document.createElement('div');
      banner.textContent = 'Late banner';
      banner.style.setProperty('height', '300px');
      document.body.prepend(banner);
    });
    expect(await layoutShiftScore(page)).toBeGreaterThan(CLS_BUDGET);
    await expect(expectStableLayout(page)).rejects.toThrow(/layout shift/i);
  });
});

describe('reduced motion', () => {
  it('reaches matchMedia', async () => {
    await emulateReducedMotion(page);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    await emulateReducedMotion(page, false);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      false,
    );
  });

  it('the pulse loops by transform normally, and expectFadesOnly fails on it', async () => {
    const running = await runningAnimations(page);
    expect(running.some((a) => a.infinite && a.properties.includes('transform'))).toBe(true);
    await expect(expectFadesOnly(page)).rejects.toThrow(/al-pulse-ping/);
  });

  it('the pulse is gone under reduced motion, and expectFadesOnly passes', async () => {
    await emulateReducedMotion(page);
    expect(await runningAnimations(page)).toEqual([]);
    await expect(expectFadesOnly(page)).resolves.toBeUndefined();
  });

  it("the app's own setting (data-motion) stops the pulse too", async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await expect(expectFadesOnly(page)).resolves.toBeUndefined();
  });

  it('a page change moves normally and only fades under reduced motion', async () => {
    await emulateReducedMotion(page);
    await startPageChange(page);
    const reduced = await runningAnimations(page);
    expect(reduced.length).toBeGreaterThan(0);
    await expect(expectFadesOnly(page)).resolves.toBeUndefined();

    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    await emulateReducedMotion(page, false);
    await startPageChange(page);
    const normal = await runningAnimations(page);
    expect(normal.some((a) => a.pseudo?.includes('view-transition') && a.properties.includes('transform'))).toBe(
      true,
    );
  });
});
