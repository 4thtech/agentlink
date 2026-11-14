// FIRSTRUN-MATRIX item 3 (APP-CONTINUITY; 08 §1 "One AgentLink, browser or app"; S1): the browser and
// the desktop app are one AgentLink on one computer. The real host routes (`/api/ui/host/yield`,
// `/api/ui/host/show`), the real record file (`~/.agentlink/app-host.json`, in a temp HOME) and the
// shipped takeover and show code (apps/cli runtime/app-host-record.ts), with the two hosts run
// in-process (app-world.ts `host` seam; the record carries the test runner's parent pid, because the
// takeover code ignores its own pid). What is NOT covered here: the Electron shell itself (see the
// desktop smoke, apps/desktop/test/smoke/smoke.mjs).
//   1. browser first (a plain `agentlink ui` host, owner made with the master code) -> the app's host
//      takes over by yield -> the same owner, Home, no first-run setup.
//   2. app first -> `agentlink ui` shows the running app and starts no second host.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { uiStep, UI_TEXT } from '../../apps/cli/dist/commands/ui.js';
import { takeOverAppHost } from '../../apps/cli/dist/runtime/app-host-record.js';
// eslint-disable-next-line boundaries/no-bypass -- the shipped words and the smoke driver are the thing under test
import { FIRST_RUN, NAME } from '../../apps/local-ui/src/pages/first-run/strings.js';
import { openedLink, runUi, shownCount, uiDepsOf } from './app-world.js';
import { chapter, journeyWorld } from './journey/world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

async function homeShown(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sections' }).first().waitFor({ timeout: 30_000 });
  // The owner is known: no first-run screen of any kind.
  expect(await page.getByRole('heading', { name: 'Which AI app do you use?' }).count()).toBe(0);
  expect(await page.getByRole('button', { name: FIRST_RUN.backupOnly }).count()).toBe(0);
}

describe('FIRSTRUN-MATRIX: one AgentLink, browser or app', () => {
  it('browser first, then the app takes over by yield: same owner, no first-run setup', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const pc = await journeyWorld().computer();
    const terminal = runUi(pc, ready.files, { seams: { host: 'terminal' } });
    ch.closers.push(async () => {
      terminal.deps.stop();
      await terminal.done;
    });
    const context = await ready.browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(await openedLink(pc, 0));
    // First run in the browser with the master code (no authenticator in this browser).
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    await page.getByLabel(NAME.label).fill('Ana');
    await page.getByRole('button', { name: FIRST_RUN.backupOnly }).click();
    await page.getByRole('heading', { name: FIRST_RUN.backupTitle }).waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: FIRST_RUN.savedIt }).click();
    await page.getByRole('button', { name: 'Go to Home' }).click();
    await homeShown(page);
    expect((await pc.directory.list()).map((e) => e.label)).toEqual(['Ana']);

    // The app starts: it asks the browser host to yield, waits until it is gone, then runs its own.
    expect(await takeOverAppHost(pc.home, { waitMs: 15_000 })).toBe('yielded');
    const app = runUi(pc, ready.files, { seams: { host: 'desktop' } });
    ch.closers.push(async () => {
      app.deps.stop();
      await app.done;
    });
    // The terminal run ends with the "moved to the app" line, only once the app's host is there.
    const ended = await terminal.done;
    expect(ended.code).toBe(0);
    expect(ended.printed).toContain(UI_TEXT.movedToApp);

    // The app's window: the same owner and ID, straight to Home.
    const appPage = await (await ready.browser.newContext({ locale: 'en-US' })).newPage();
    await appPage.goto(await openedLink(pc, 1));
    await homeShown(appPage);
    expect((await pc.directory.list()).map((e) => e.label)).toEqual(['Ana']);
  }, 240_000);

  it('app first, then `agentlink ui`: the app is shown, no second host starts', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const pc = await journeyWorld().computer();
    const app = runUi(pc, ready.files, { seams: { host: 'desktop' } });
    ch.closers.push(async () => {
      app.deps.stop();
      await app.done;
    });
    await openedLink(pc, 0);
    const opened = pc.opened.length;

    const deps = uiDepsOf(pc, ready.files, { host: 'terminal' });
    const printed: string[] = [];
    const context = {
      command: 'ui',
      parsed: { values: {}, positionals: [], agent: undefined },
      output: { print: (l: string) => void printed.push(l), printError: () => undefined },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
    };
    const code = await uiStep(context as never, deps, 'agentlink');
    expect(code).toBe(0);
    expect(printed).toContain(UI_TEXT.inApp);
    expect(shownCount.get(pc.home)).toBe(1);
    // Nothing else started: no server, no link opened.
    expect(deps.servers).toHaveLength(0);
    expect(pc.opened.length).toBe(opened);
  }, 120_000);
});
