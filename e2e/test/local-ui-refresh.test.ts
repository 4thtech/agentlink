// UI-REFRESH-q (S1; plan docs/process/proposals/UI-REFRESH.md §7, §8, §9; B-11 §13–§20): the
// refreshed local app, built (apps/local-ui/dist, made by `^build` through @4thtech-io/agentlink),
// in Chromium. Every /api/** call is answered from fixtures; no agent, key store or network.
//
// Gates (fail the run):
//   - axe-core: zero WCAG 2.1 A/AA violations on every page; in CI in dark and light at 1280 and
//     dark at 360; with LOCAL_UI_REFRESH_FULL=1 (or STRICT) also increased contrast, forced
//     colours, reduced motion plus reduced transparency, Under the hood on and light at 360;
//   - no layout-property animation (keyframes, running transitions, Element.animate);
//   - at most four `backdrop-filter` chrome elements, plus the overlay while a Sheet is open, and
//     none on a scrolling or repeated element; all of them solid with reduced transparency,
//     increased contrast and forced colours (§8);
//   - Sheets make the page behind them inert and Escape closes them; Approve is never focused on
//     load; the nav, the Under the hood switch and the Approvals controls are keyboard reachable;
//   - added CSS within 15 KB gzipped against 0.4.0.
// Timing (only with LOCAL_UI_REFRESH_STRICT=1, which gates, or LOCAL_UI_REFRESH_REPORT=<file>, which
// records): route paint within 100 ms, and frame times and long tasks with the CPU throttled 4× (no
// frame over 33 ms, no long task over 50 ms). Shared CI runners are far too slow and noisy for these;
// the owner's 60 fps check on the reference Mac stays manual (plan §7). Also recorded: first render
// and the JS growth against 0.4.0 (it includes features outside the refresh).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from './fixtures/local-ui-refresh.js';
import {
  emulateReducedMotion,
  expectFadesOnly,
  expectStableLayout,
  observeLayoutShift,
} from './helpers/motion.js';

const DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
// axe-core (devDependency of this package) as a script for the page.
const AXE = readFileSync(
  fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)),
  'utf8',
);

/** 0.4.0's local app (tag v0.4.0, `vite build`, gzip -9), measured once for card q. */
const BASELINE_040 = { jsGzip: 131_357, cssGzip: 12_685 } as const;
const BUDGET = { cssGzip: 15 * 1024, jsGzip: 10 * 1024 } as const; // plan §7

// W4-SHELL-V2: the sections (today's pages until their builders replace the bodies), Settings,
// Advanced and Get started.
const PAGES = [
  { path: '/', title: 'Home' },
  { path: '/agents', title: 'Agents' },
  { path: '/activity', title: 'Activity' },
  // Interim: today's Messages and Contacts pages (U3, U4 fold them into Home).
  { path: '/inbox', title: 'Inbox' },
  { path: '/contacts', title: 'Contacts' },
  { path: '/settings/files', title: 'Files' },
  { path: '/settings/proofs', title: 'Proofs & credits' },
  { path: '/settings/rules', title: 'Rules' },
  { path: '/settings', title: 'Settings' },
  { path: '/activity/live', title: 'Live activity stream' },
  { path: '/settings/backup', title: 'Backup & Touch ID' },
  { path: '/settings/notifications', title: 'Notifications' },
  { path: '/settings/appearance', title: 'Appearance' },
  { path: '/advanced/network', title: 'Relays & network' },
  { path: '/advanced/diagnostics', title: 'Diagnostics' },
  // W4-WIRE (U6 low): the Connections map is checked like every Advanced page.
  { path: '/advanced/map', title: 'Connections map' },
  // W4-WIZARD: Get started opens on step 1, the AI app pick.
  { path: '/start/app', title: 'Which AI app do you use?' },
] as const;

interface Mode {
  readonly name: string;
  readonly colorScheme: 'dark' | 'light';
  readonly width: number;
  readonly contrast?: 'more';
  readonly forcedColors?: 'active';
  readonly reduced?: boolean; // reduced motion and reduced transparency (system)
  readonly hood?: boolean;
}

const MODES: readonly Mode[] = [
  { name: 'dark-1280', colorScheme: 'dark', width: 1280 },
  { name: 'light-1280', colorScheme: 'light', width: 1280 },
  { name: 'dark-360', colorScheme: 'dark', width: 360 },
  { name: 'light-360', colorScheme: 'light', width: 360 },
  { name: 'contrast-dark-1280', colorScheme: 'dark', width: 1280, contrast: 'more' },
  { name: 'contrast-light-1280', colorScheme: 'light', width: 1280, contrast: 'more' },
  { name: 'forced-1280', colorScheme: 'dark', width: 1280, forcedColors: 'active' },
  { name: 'reduced-light-1280', colorScheme: 'light', width: 1280, reduced: true },
  { name: 'reduced-dark-360', colorScheme: 'dark', width: 360, reduced: true },
  { name: 'hood-dark-1280', colorScheme: 'dark', width: 1280, hood: true },
];

const report: Record<string, unknown> = {};
let site: Server;
let origin: string;
let browser: Browser;

function serve(): Promise<Server> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
  };
  const server = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0] ?? '/';
    const file = p.startsWith('/assets/') && !p.includes('..') ? p.slice(1) : 'index.html';
    try {
      const body = readFileSync(join(DIST, file));
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function open(mode: Mode): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: mode.width, height: 800 },
    colorScheme: mode.colorScheme,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: mode.reduced === true ? 'reduce' : 'no-preference',
    forcedColors: mode.forcedColors ?? 'none',
    contrast: mode.contrast ?? 'no-preference',
  });
  const page = await ctx.newPage();
  if (mode.reduced === true) {
    // Playwright has no option for this media feature; Chromium's emulation has.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: mode.colorScheme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-reduced-transparency', value: 'reduce' },
      ],
    });
  }
  const hood = mode.hood === true;
  await page.addInitScript((on: boolean) => {
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
    if (on) {
      try {
        localStorage.setItem(
          'agentlink.prefs',
          JSON.stringify({ hood: true, motion: 'system', transparency: 'system', theme: 'system' }),
        );
      } catch {
        /* storage blocked: the default (off) */
      }
    }
    // Every Element.animate keyframe property, for the layout-property check.
    const seen: string[] = [];
    (window as unknown as { __alAnimated: string[] }).__alAnimated = seen;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, frames, options) {
      const list = Array.isArray(frames) ? frames : frames ? [frames] : [];
      for (const f of list) for (const k of Object.keys(f ?? {})) seen.push(k);
      if (!Array.isArray(frames) && frames) for (const k of Object.keys(frames)) seen.push(k);
      return original.call(this, frames, options);
    };
  }, hood);
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    // W4-WIZARD: the app opens Get started by itself while no owner exists; these pages are of an
    // owner's app, so only Get started itself reads "no owner yet" (its first step is a page here).
    const onStart = new URL(route.request().frame().url()).pathname.startsWith('/start/');
    const body =
      url.pathname === '/api/ui/first-run' && !onStart ? { owner: 'set_up' } : ROUTES[url.pathname];
    return route.fulfill({
      status: body === undefined ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: 'not_found' }),
    });
  });
  return { ctx, page };
}

async function settle(page: Page, title: string): Promise<void> {
  await page.getByRole('heading', { name: title, level: 1 }).first().waitFor({ timeout: 10_000 });
  await page
    .getByText(/Checking…|Loading…/)
    .first()
    .waitFor({ state: 'detached', timeout: 4_000 })
    .catch(() => {});
  await page.waitForTimeout(150);
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly targets: readonly string[];
}

/**
 * Violations found by this audit on 27 Oct and handed to the owning page card as a follow-up (card q
 * fixes no page code). Each entry is exact: rule, page and element. Delete the entry with the fix;
 * anything not listed here fails.
 */
const KNOWN_AXE: readonly { rule: string; path: string; target: string; followUp: string }[] = [];

const isKnown = (where: string, v: AxeViolation): boolean =>
  KNOWN_AXE.some(
    (k) =>
      k.rule === v.id &&
      where.endsWith(` ${k.path}`) &&
      v.targets.length > 0 &&
      v.targets.every((t) => t === k.target),
  );

/** LOCAL_UI_REFRESH_STRICT=1 turns the 4× frame report into a gate (for a quiet machine). */
/**
 * LOCAL_UI_REFRESH_STRICT=1 turns the timing checks into gates (route paint ≤ 100 ms, no frame over
 * 33 ms, no long task over 50 ms) on a quiet machine; LOCAL_UI_REFRESH_REPORT=<file> records them.
 * Without either, the timing tests are skipped: a shared CI runner measured 347 ms+ per route change
 * (PR #621, first run), so the numbers there say nothing about the app.
 */
const STRICT = process.env['LOCAL_UI_REFRESH_STRICT'] === '1';
const TIMING = STRICT || Boolean(process.env['LOCAL_UI_REFRESH_REPORT']);
/**
 * The axe modes. CI runs three (dark and light at 1280, dark at 360) to keep the unit-test step
 * short; LOCAL_UI_REFRESH_FULL=1 or STRICT runs all ten (contrast, forced colours, reduced, hood).
 */
const AXE_MODES: readonly Mode[] =
  STRICT || process.env['LOCAL_UI_REFRESH_FULL'] === '1'
    ? MODES
    : MODES.filter((m) => ['dark-1280', 'light-1280', 'dark-360'].includes(m.name));
/** The whole test file took 109 s on a CI runner (PR #621); 3 modes × 80 s = 240 s, over twice that. */
const AXE_MS_PER_MODE = 80_000;

async function axe(page: Page, forced: boolean): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async (disableContrast: boolean) => {
    type AxeRun = (
      ctx: Document,
      opts: unknown,
    ) => Promise<{
      violations: {
        id: string;
        impact: string | null;
        help: string;
        nodes: { target: string[] }[];
      }[];
    }>;
    const run = (window as unknown as { axe: { run: AxeRun } }).axe.run;
    const result = await run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      // Forced colours: the browser picks the system colours; axe reads the author colours.
      rules: disableContrast ? { 'color-contrast': { enabled: false } } : {},
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
    }));
  }, forced);
}

/**
 * The one named layout-transition exception: the Start here card collapses by grid rows when it
 * leaves (UX2-g, B-11 §27.3), the same exception packages/ui/src/motion-lint.test.ts names. Only
 * `grid-template-rows` on a label containing `start-wrap`; nothing else is excused.
 */
const startWrapException = (entry: string): boolean =>
  /^[a-z0-9]+[^:]*start-wrap[^:]*: grid-template-rows$/.test(entry);

/** Computed-style checks: running layout transitions and the backdrop-filter elements. */
async function motionAndDepth(page: Page): Promise<{
  layoutTransitions: string[];
  paintTransitions: string[];
  backdrop: { el: string; position: string; repeated: boolean; inScroller: boolean }[];
  animated: string[];
}> {
  return page.evaluate(() => {
    const LAYOUT =
      /^(width|height|top|left|right|bottom|inset|margin|padding|box-shadow|filter|min-|max-|font-size|border-width|gap|grid-template)/;
    const ALLOWED = /^(opacity|transform|translate|scale|rotate|stroke-dashoffset)$/;
    const label = (el: Element): string =>
      el.tagName.toLowerCase() +
      (el.id ? `#${el.id}` : '') +
      (typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '');
    const layoutTransitions = new Set<string>();
    const paintTransitions = new Set<string>();
    const backdrop: { el: string; position: string; repeated: boolean; inScroller: boolean }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      const props = cs.transitionProperty.split(',').map((s) => s.trim());
      const durs = cs.transitionDuration.split(',').map((s) => parseFloat(s));
      props.forEach((p, i) => {
        const d = durs[i % durs.length] ?? 0;
        if (d <= 0 || p === 'none') return;
        if (p === 'all' || LAYOUT.test(p)) layoutTransitions.add(`${label(el)}: ${p}`);
        else if (!ALLOWED.test(p)) paintTransitions.add(`${label(el)}: ${p}`);
      });
      const bf =
        cs.backdropFilter ||
        (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
      if (bf && bf !== 'none') {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        const repeated = cls ? document.getElementsByClassName(cls).length > 1 : false;
        let inScroller = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const o = getComputedStyle(a).overflowY;
          if ((o === 'auto' || o === 'scroll') && a.scrollHeight > a.clientHeight)
            inScroller = true;
        }
        backdrop.push({ el: label(el), position: cs.position, repeated, inScroller });
      }
    }
    const animated = (window as unknown as { __alAnimated?: string[] }).__alAnimated ?? [];
    return {
      layoutTransitions: [...layoutTransitions],
      paintTransitions: [...paintTransitions],
      backdrop,
      animated: [...new Set(animated)].filter(
        (k) => !['offset', 'easing', 'composite'].includes(k),
      ),
    };
  });
}

/** Keyframes in every stylesheet that animate a layout property (a static scan, page independent). */
async function layoutKeyframes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const LAYOUT =
      /^(width|height|top|left|right|bottom|inset|margin|padding|box-shadow|filter|min-|max-|font-size|border-width)/;
    const bad: string[] = [];
    const walk = (rules: CSSRuleList): void => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSKeyframesRule) {
          for (const k of Array.from(r.cssRules) as CSSKeyframeRule[]) {
            for (let i = 0; i < k.style.length; i++) {
              const p = k.style.item(i);
              if (LAYOUT.test(p)) bad.push(`@keyframes ${r.name}: ${p}`);
            }
          }
        } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const s of Array.from(document.styleSheets)) {
      try {
        walk(s.cssRules);
      } catch {
        /* cross-origin sheet: none here */
      }
    }
    return [...new Set(bad)];
  });
}

/** Installs the in-page frame and long-task recorders (rAF deltas, longtask, LoAF). */
async function startRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __rec: { frames: number[]; long: number[]; loaf: unknown[]; on: boolean; obs: unknown[] };
    };
    const rec = {
      frames: [] as number[],
      long: [] as number[],
      loaf: [] as unknown[],
      on: true,
      obs: [] as unknown[],
    };
    w.__rec = rec;
    let last: number | undefined;
    const tick = (t: number): void => {
      if (last !== undefined) rec.frames.push(t - last);
      last = t;
      if (rec.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      const lt = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) rec.long.push(e.duration);
      });
      lt.observe({ type: 'longtask' });
      rec.obs.push(lt);
    } catch {
      /* unsupported */
    }
    try {
      const lo = new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as {
          duration: number;
          blockingDuration: number;
          scripts: { invoker: string; sourceFunctionName: string; duration: number }[];
        }[]) {
          if (e.duration > 50)
            rec.loaf.push({
              duration: Math.round(e.duration),
              blocking: Math.round(e.blockingDuration),
              scripts: e.scripts
                .slice(0, 3)
                .map(
                  (s) =>
                    `${s.invoker}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ''} ${Math.round(s.duration)}ms`,
                ),
            });
        }
      });
      lo.observe({ type: 'long-animation-frame' });
      rec.obs.push(lo);
    } catch {
      /* unsupported */
    }
  });
}

interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over33: number;
  over50: number;
  longTasks: number;
  longestTask: number;
  loaf: unknown[];
}

async function stopRecorder(page: Page): Promise<FrameStats> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as {
      __rec: {
        frames: number[];
        long: number[];
        loaf: unknown[];
        on: boolean;
        obs: { disconnect(): void }[];
      };
    };
    w.__rec.on = false;
    for (const o of w.__rec.obs) o.disconnect();
    return { frames: w.__rec.frames, long: w.__rec.long, loaf: w.__rec.loaf };
  });
  const f = [...raw.frames].sort((a, b) => a - b);
  const pct = (q: number): number =>
    Math.round(f[Math.min(f.length - 1, Math.floor(q * f.length))] ?? 0);
  return {
    frames: f.length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: Math.round(f[f.length - 1] ?? 0),
    over33: f.filter((x) => x > 33.4).length,
    over50: f.filter((x) => x > 50).length,
    longTasks: raw.long.length,
    longestTask: Math.round(Math.max(0, ...raw.long)),
    loaf: raw.loaf.slice(0, 5),
  };
}

/** Click a nav link and time until the frame after the new page's heading is in the DOM. */
async function timedNav(page: Page, label: string, title: string): Promise<number> {
  await page.evaluate((t: string) => {
    const w = window as unknown as { __nav?: Promise<number> };
    w.__nav = new Promise<number>((resolve) => {
      document.addEventListener(
        'click',
        () => {
          const t0 = performance.now();
          const done = (): void => {
            requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
          };
          const has = (): boolean =>
            Array.from(document.querySelectorAll('h1')).some((h) => h.textContent?.trim() === t);
          if (has()) return done();
          const mo = new MutationObserver(() => {
            if (has()) {
              mo.disconnect();
              done();
            }
          });
          mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        },
        { capture: true, once: true },
      );
    });
  }, title);
  await page
    .getByRole('navigation')
    .first()
    .getByRole('link', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
    .click();
  return page.evaluate(() => (window as unknown as { __nav: Promise<number> }).__nav);
}

/**
 * The order a route-change pass walks in the section menu (W4-SHELL-V2, Decision 48): Agents and
 * Activity, there and back again.
 */
const NAV_WALK: readonly (readonly [string, string])[] = [
  ['Agents', 'Agents'],
  ['Activity', 'Activity'],
  ['Agents', 'Agents'],
];

beforeAll(async () => {
  site = await serve();
  origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
  const out = process.env['LOCAL_UI_REFRESH_REPORT'];
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
});

describe('UI-REFRESH-q: the refreshed local app, performance and accessibility', () => {
  it('bundle: added CSS within 15 KB gzipped against 0.4.0 (JS growth reported)', () => {
    const sizes = { js: 0, css: 0 };
    const dir = join(DIST, 'assets');
    for (const f of readdirSync(dir)) {
      const ext = extname(f).slice(1);
      if (ext !== 'js' && ext !== 'css') continue;
      sizes[ext] += gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
    }
    const growth = { css: sizes.css - BASELINE_040.cssGzip, js: sizes.js - BASELINE_040.jsGzip };
    // UI-REFRESH-u: the Settings pages and the Under the hood panel load on first use, so the JS a
    // visitor downloads at start is only what index.html lists (scripts and preloads). Reported next
    // to the total; the JS budget is a report here, as before.
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const initialFiles = new Set(
      [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] as string),
    );
    let initialJs = 0;
    for (const f of initialFiles) {
      initialJs += gzipSync(readFileSync(join(DIST, f)), { level: 9 }).length;
    }
    const initialJsGrowth = initialJs - BASELINE_040.jsGzip;
    report['bundle'] = {
      gzip: sizes,
      baseline040: BASELINE_040,
      growth,
      initialJsGzip: initialJs,
      initialJsGrowth,
      budget: BUDGET,
    };
    expect(growth.css).toBeLessThanOrEqual(BUDGET.cssGzip);
  });

  it(
    'axe: zero WCAG 2.1 A/AA violations on every page (3 modes in CI; all 10 with LOCAL_UI_REFRESH_FULL)',
    async () => {
      const found: Record<string, AxeViolation[]> = {};
      for (const mode of AXE_MODES) {
        const { ctx, page } = await open(mode);
        try {
          for (const p of PAGES) {
            await page.goto(origin + p.path);
            await settle(page, p.title);
            const v = await axe(page, mode.forcedColors === 'active');
            if (v.length > 0) found[`${mode.name} ${p.path}`] = v;
          }
        } finally {
          await ctx.close();
        }
      }
      report['axe'] = found;
      const unknown = Object.entries(found)
        .map(([where, list]) => [where, list.filter((v) => !isKnown(where, v))] as const)
        .filter(([, list]) => list.length > 0);
      expect(Object.fromEntries(unknown)).toEqual({});
    },
    AXE_MS_PER_MODE * AXE_MODES.length,
  );

  it('the Start here exception covers only grid-template-rows on start-wrap', () => {
    expect(startWrapException('div.hm-start-wrap: grid-template-rows')).toBe(true);
    expect(startWrapException('div.hm-start-wrap: height')).toBe(false);
    expect(startWrapException('div.hm-start-wrap: all')).toBe(false);
    expect(startWrapException('div.hm-tile: grid-template-rows')).toBe(false);
    expect(startWrapException('div.hm-start-wrap: grid-template-rows, height')).toBe(false);
  });

  it('motion: no layout-property animation; backdrop-filter on at most four chrome elements', async () => {
    const { ctx, page } = await open(MODES[0] as Mode);
    const perPage: Record<string, unknown> = {};
    const layout: string[] = [];
    const tooMany: string[] = [];
    const misplaced: string[] = [];
    try {
      await page.goto(`${origin}/activity`);
      await settle(page, 'Activity');
      layout.push(...(await layoutKeyframes(page)));
      for (const p of PAGES) {
        await page.goto(origin + p.path);
        await settle(page, p.title);
        // Hover the first card or row so hover transitions are live.
        await page
          .locator('main button, main a')
          .first()
          .hover({ timeout: 2_000 })
          .catch(() => {});
        await page.waitForTimeout(100);
        const m = await motionAndDepth(page);
        perPage[p.path] = m;
        layout.push(
          ...m.layoutTransitions
            .filter((s) => !startWrapException(s))
            .map((s) => `${p.path} transition ${s}`),
        );
        layout.push(
          ...m.animated
            .filter((k) => !/^(opacity|transform|translate|scale|rotate|strokeDashoffset)$/.test(k))
            .map((k) => `${p.path} animate() ${k}`),
        );
        if (m.backdrop.length > 4) tooMany.push(`${p.path}: ${String(m.backdrop.length)}`);
        for (const b of m.backdrop) {
          // A sticky header inside the scroller is chrome (plan §7); anything else is not.
          const chrome = b.position === 'sticky' || b.position === 'fixed';
          if (b.repeated || (b.inScroller && !chrome)) misplaced.push(`${p.path}: ${b.el}`);
        }
      }
      // With a Sheet open: the chrome plus the overlay, never more than five.
      await page.goto(`${origin}/contacts`);
      await settle(page, 'Contacts');
      await page.getByRole('button', { name: /Ana/ }).first().click();
      await page.getByRole('dialog').first().waitFor();
      await page.waitForTimeout(400);
      const sheet = await motionAndDepth(page);
      perPage['contacts+sheet'] = sheet;
      if (sheet.backdrop.length > 5)
        tooMany.push(`contacts+sheet: ${String(sheet.backdrop.length)}`);
    } finally {
      await ctx.close();
    }
    report['motion'] = { layout, tooMany, misplaced, perPage };
    expect(layout).toEqual([]);
    expect(tooMany).toEqual([]);
    expect(misplaced).toEqual([]);
  }, 120_000);

  it('fallbacks: reduced transparency, increased contrast and forced colours give solid chrome', async () => {
    const solid: Record<string, number> = {};
    for (const mode of MODES.filter((m) => m.reduced || m.contrast || m.forcedColors)) {
      const { ctx, page } = await open(mode);
      try {
        await page.goto(`${origin}/activity`);
        await settle(page, 'Activity');
        solid[mode.name] = (await motionAndDepth(page)).backdrop.length;
      } finally {
        await ctx.close();
      }
    }
    report['fallbacks'] = solid;
    expect(
      Object.values(solid).every((n) => n === 0),
      JSON.stringify(solid),
    ).toBe(true);
  }, 90_000);

  it.runIf(TIMING)(
    'route change paints the new page within 100 ms (unthrottled; 4× throttled reported)',
    async () => {
      const { ctx, page } = await open(MODES[0] as Mode);
      const plain: Record<string, number> = {};
      const throttled: Record<string, number> = {};
      try {
        await page.goto(`${origin}/activity`);
        await settle(page, 'Activity');
        // One warm-up pass: the first visit of a page loads its fonts.
        for (const [label, title] of NAV_WALK) await timedNav(page, label, title);
        // Three passes; the median per page (one GC pause on a shared runner is not the app).
        const runs: Record<string, number[]> = {};
        for (let pass = 0; pass < 3; pass++) {
          for (const [label, title] of NAV_WALK) {
            (runs[title] ??= []).push(await timedNav(page, label, title));
            await page.waitForTimeout(250);
          }
        }
        for (const [title, ms] of Object.entries(runs)) {
          plain[title] = Math.round([...ms].sort((a, b) => a - b)[1] ?? Infinity);
        }
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        for (const [label, title] of NAV_WALK) {
          throttled[title] = Math.round(await timedNav(page, label, title));
          await page.waitForTimeout(400);
        }
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      } finally {
        await ctx.close();
      }
      report['routePaint'] = { plainMs: plain, throttled4xMs: throttled };
      const slow = Object.entries(plain).filter(([, ms]) => ms > 100);
      if (STRICT) expect(slow).toEqual([]);
    },
    120_000,
  );

  it.runIf(TIMING)(
    'frames: first render, route changes, scrolling, Sheet open/close at 4× CPU throttle',
    async () => {
      const { ctx, page } = await open(MODES[0] as Mode);
      const out: Record<string, unknown> = {};
      try {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        // First render per page: navigation start to first contentful paint, and to the heading.
        const first: Record<string, unknown> = {};
        for (const p of PAGES) {
          const t0 = Date.now();
          await page.goto(origin + p.path);
          await page
            .getByRole('heading', { name: p.title, level: 1 })
            .first()
            .waitFor({ timeout: 15_000 });
          const headingMs = Date.now() - t0;
          const fcp = await page.evaluate(
            () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1,
          );
          first[p.path] = { fcpMs: Math.round(fcp), headingMs };
        }
        out['firstRender'] = first;

        // Route changes.
        await page.goto(`${origin}/activity`);
        await settle(page, 'Activity');
        await startRecorder(page);
        for (const [label, title] of NAV_WALK) {
          await timedNav(page, label, title);
          await page.waitForTimeout(500);
        }
        out['routeChanges'] = await stopRecorder(page);

        // Scrolling Activity (200 rows) and Messages (60 conversations, 200 messages).
        for (const [path, title, open200] of [
          ['/activity', 'Activity', false],
          ['/inbox', 'Inbox', true],
        ] as const) {
          await page.goto(origin + path);
          await settle(page, title);
          if (open200) {
            await page.getByRole('button', { name: /Marko/ }).first().click();
            await page.waitForTimeout(800);
          }
          await page.mouse.move(700, 450);
          await startRecorder(page);
          for (let i = 0; i < 30; i++) {
            await page.mouse.wheel(0, 140);
            await page.waitForTimeout(32);
          }
          for (let i = 0; i < 30; i++) {
            await page.mouse.wheel(0, -140);
            await page.waitForTimeout(32);
          }
          await page.waitForTimeout(300);
          out[`scroll ${title}`] = await stopRecorder(page);
        }

        // Sheet open and close (Contacts detail).
        await page.goto(`${origin}/contacts`);
        await settle(page, 'Contacts');
        await startRecorder(page);
        for (let i = 0; i < 3; i++) {
          await page.getByRole('button', { name: /Ana/ }).first().click();
          await page.getByRole('dialog').first().waitFor();
          await page.waitForTimeout(500);
          await page.keyboard.press('Escape');
          await page
            .getByRole('dialog')
            .first()
            .waitFor({ state: 'detached', timeout: 3_000 })
            .catch(() => {});
          await page.waitForTimeout(500);
        }
        out['sheet open/close'] = await stopRecorder(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      } finally {
        await ctx.close();
      }
      report['frames4x'] = out;
      expect(Object.keys(out).length).toBeGreaterThan(0);
      if (STRICT) {
        // Plan §7: no frame over 33 ms, no long task over 50 ms (a frame of two vsyncs, 33.3 ms, is
        // one dropped frame and counts).
        const over = Object.entries(out)
          .filter(([k]) => k !== 'firstRender')
          .filter(([, s]) => (s as FrameStats).over33 > 0 || (s as FrameStats).longestTask > 50)
          .map(([k, s]) => `${k}: max ${String((s as FrameStats).max)} ms`);
        expect(over).toEqual([]);
      }
    },
    240_000,
  );

  // W4-SHELL-V2 (W4 UI re-brief, acceptance of every UI unit): the shell keeps its layout still
  // (CLS ≤ 0.01) while it loads and settles, and under reduced motion every shell move is a fade
  // (the agent menu, Help, the rail expanding, the Under the hood morph): no pulse, nothing moves.
  it('shell motion: CLS ≤ 0.01 on load; reduced motion fades only (menu, Help, rail, morph)', async () => {
    const { ctx, page } = await open(MODES[0] as Mode);
    try {
      await observeLayoutShift(page);
      await page.goto(`${origin}/agents`);
      await settle(page, 'Agents');
      await page.waitForTimeout(600);
      report['shellCls'] = await expectStableLayout(page);

      await emulateReducedMotion(page);
      await page.locator('button.al-chip').first().click();
      await expectFadesOnly(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Help' }).first().click();
      await expectFadesOnly(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Expand menu' }).first().click();
      await expectFadesOnly(page);
      await page
        .getByRole('switch', { name: /Under the hood/ })
        .first()
        .click();
      await expectFadesOnly(page);
      await page.locator('[aria-label="Live status"]').first().waitFor();
    } finally {
      await ctx.close();
    }
  }, 60_000);

  // W4-SHELL-LIVE (U1-b; follow-up of W4-SHELL-V2: the top bar shifted ~0.023 when Under the hood
  // turned on): the app's own Under the hood value turns it on after load (this browser had it off),
  // and the live status of the AI apps changes while nobody touches the page (Claude Code quits).
  // Neither moves the page: the strip, the chip and the menu keep their places (CLS ≤ 0.01).
  for (const width of [1280, 360]) {
    it(`shell live: Under the hood from the app and an AI app quitting keep CLS ≤ 0.01 (${width})`, async () => {
      const { ctx, page } = await open({ ...(MODES[0] as Mode), width });
      try {
        let reads = 0;
        const agents = (): unknown => {
          reads += 1;
          const running = reads <= 1;
          return {
            switchable: true,
            generation: 1,
            current: 'default',
            label: "Tali's agent",
            agents: [
              {
                name: 'default',
                label: "Tali's agent",
                labelled: true,
                current: true,
                available: true,
                removing: false,
                contacts: 2,
                running,
                state: running ? 'ready' : 'offline',
                ...(running ? {} : { lastSeenAt: Math.floor(Date.now() / 1000) - 180 }),
                apps: [
                  running
                    ? { app: 'claude-code', state: 'ready', since: 1_800_000_000 }
                    : {
                        app: 'claude-code',
                        state: 'not_running',
                        lastSeenAt: Math.floor(Date.now() / 1000) - 180,
                      },
                ],
              },
            ],
          };
        };
        const json = (body: unknown, status = 200) => ({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
        await page.route('**/api/ui/agents', (route) => route.fulfill(json(agents())));
        await page.route('**/api/ui/ui-settings', (route) =>
          route.fulfill(json({ underTheHood: true })),
        );
        // No stream here: the live store falls back to its 5 s read, a change with no input.
        await page.route('**/api/ui/events', (route) => route.fulfill(json({ error: 'x' }, 404)));
        await observeLayoutShift(page);
        await page.goto(`${origin}/agents`);
        await settle(page, 'Agents');
        await page.locator('[aria-label="Live status"] li').first().waitFor();
        await page.waitForFunction(
          () => {
            const status = document.querySelector('button.al-chip .al-chip-status')?.textContent;
            return status !== undefined && status !== '' && !status.includes('Ready');
          },
          undefined,
          { timeout: 15_000 },
        );
        await page.waitForTimeout(300);
        report[`shellLiveCls${width}`] = await expectStableLayout(page);
      } finally {
        await ctx.close();
      }
    }, 60_000);
  }

  it('keyboard: nav, Under the hood switch, Sheets (inert background), Approvals', async () => {
    const { ctx, page } = await open(MODES[0] as Mode);
    const kb: Record<string, unknown> = {};
    try {
      // Approvals: nothing autofocused on an Approve; the controls are reachable by Tab.
      await page.goto(`${origin}/`);
      await settle(page, 'Home');
      kb['approvalsFocusOnLoad'] = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body || a === document.documentElement) return '(body)';
        if (a.tagName !== 'BUTTON' && a.tagName !== 'A' && a.tagName !== 'INPUT') {
          return `(${a.tagName.toLowerCase()})`;
        }
        return a.textContent?.trim().slice(0, 40) ?? '';
      });
      const stops: string[] = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        stops.push(
          await page.evaluate(() => {
            const a = document.activeElement;
            if (!a || a === document.body) return '(body)';
            const name = a.getAttribute('aria-label') ?? a.textContent?.trim().slice(0, 30) ?? '';
            return `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role') ?? ''}]` : ''} ${name}`;
          }),
        );
      }
      kb['approvalsTabStops'] = stops;
      const visible = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a) return true;
        const cs = getComputedStyle(a);
        return cs.outlineStyle !== 'none' || cs.boxShadow !== 'none';
      });
      kb['focusVisible'] = visible;

      // The sidebar: every item reachable by Tab.
      const navNames = NAV_WALK.map(([l]) => l);
      const reached = navNames.filter((n) => stops.some((s) => s.includes(n)));
      kb['navReached'] = reached;

      // Under the hood (W4-SHELL-V2: the switch top right): reachable by Tab, toggles with Space.
      await page.goto(`${origin}/activity`);
      await settle(page, 'Activity');
      const sw = page.getByRole('switch', { name: /Under the hood/i }).first();
      const hasSwitch = (await sw.count()) > 0;
      let toggled = false;
      if (hasSwitch) {
        let found = false;
        for (let i = 0; i < 60 && !found; i++) {
          await page.keyboard.press('Tab');
          found = await sw.evaluate((el) => el === document.activeElement);
        }
        if (found) {
          const before = await sw.getAttribute('aria-checked');
          await page.keyboard.press('Space');
          await page.waitForTimeout(100);
          toggled = (await sw.getAttribute('aria-checked')) !== before;
          await page.keyboard.press('Space');
        }
        kb['hoodSwitchByTab'] = found;
      }
      kb['hoodSwitch'] = { present: hasSwitch, toggledBySpace: toggled };

      // Sheet: focus moves in, background inert, Escape closes and focus returns.
      await page.goto(`${origin}/contacts`);
      await settle(page, 'Contacts');
      const row = page.getByRole('button', { name: /Ana/ }).first();
      await row.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').first().waitFor();
      await page.waitForTimeout(400);
      kb['sheet'] = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        // The page behind: its heading and rows (the Sheet may live inside <main>, so <main> itself
        // is not the test), and the sidebar.
        const h1 = document.querySelector('h1');
        const nav = document.querySelector('nav');
        return {
          focusInside: !!d && d.contains(document.activeElement),
          mainInert: !!h1?.closest('[inert]'),
          navInert: !!nav?.closest('[inert]'),
        };
      });
      let escaped = true;
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return !!d && d.contains(document.activeElement);
        });
        if (!inside) escaped = false;
      }
      kb['sheetFocusTrapped'] = escaped;
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog')
        .first()
        .waitFor({ state: 'detached', timeout: 3_000 })
        .catch(() => {});
      kb['sheetClosedByEscape'] = (await page.getByRole('dialog').count()) === 0;
      kb['focusReturned'] = await row.evaluate((el) => el === document.activeElement);
    } finally {
      await ctx.close();
    }
    report['keyboard'] = kb;
    expect(String(kb['approvalsFocusOnLoad'])).not.toMatch(/^Approve/);
    expect(kb['navReached']).toEqual(NAV_WALK.map(([l]) => l));
    expect(kb['hoodSwitch']).toEqual({ present: true, toggledBySpace: true });
    expect(kb['sheet']).toEqual({ focusInside: true, mainInert: true, navInert: true });
    expect(kb['sheetFocusTrapped']).toBe(true);
    expect(kb['sheetClosedByEscape']).toBe(true);
    expect(kb['focusReturned']).toBe(true);
  }, 120_000);
});
