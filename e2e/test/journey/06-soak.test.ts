// ROBUSTNESS R3: the soak. One owner on computer A does what a person (and their AI apps) do all day
// for ~2 hours, compressed: create an ID (also after removing the last one), rename, pause and
// resume, remove (the open one, another, the last, one with the relay down), restart the app host
// at a fault point, start and end an AI app's MCP session, invite a friend on computer B, send a
// message. A shuffled deck of these steps runs in seeded order on an injected clock (the host's
// `now` advances 6 minutes per cycle; the host's wall-clock cap is off). After EVERY step:
//   1. the host is still up (its run has not settled);
//   2. every non-2xx /api/ui answer has a well-formed status and, if `failed`, a known `reason`
//      (an absent reason is tolerated for now: KNOWN_FAILING.REASONS);
//   3. the page shows none of the generic phrases of DENY;
//   4. the temp home is consistent: no `removing` ID after a finished removal, no AI-app entry that
//      names a missing ID (removal step 5), the Agents page lists the folders;
//   5. the terminal output holds no raw JSON line;
//   6. no secret of the keychain stand-in appears in the home, in what was printed, or in what the
//      page logged.
//
// Smoke (5 cycles) runs by default; the full run (20 cycles) with JOURNEY_SOAK=1.
// Repeat a failure with JOURNEY_SOAK_SEED=<seed>; the seed is printed on failure.
//
// KNOWN_FAILING (helpers-soak.ts) lists the findings whose fix is on another branch, by ID. Delete an
// entry when its fix lands; the matching tolerance below then fails loudly if the bug is still there.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClaudeCode, startAiAppMcp, until, type AiAppMcp } from '../app-world.js';
import { addAgent, agentCard, inMore, labelled, openAgents } from './helpers-agents.js';
import {
  KNOWN_FAILING,
  KNOWN_REASONS,
  STATUS_FORM,
  aiAppEntryAgents,
  canaryFindings,
  deniedIn,
  keychainCanaries,
  known,
  rng,
  seedAiAppEntry,
  soakWorld,
  startSoakRun,
  tolerate,
  virtualClock,
  watchApi,
  type Fault,
  type SoakRun,
} from './helpers-soak.js';
import {
  CONFIRM_PASSKEY,
  chapter,
  createInviteInApp,
  eventually,
  firstRunWithTouchId,
  journeyPage,
  navTo,
  text,
} from './world.js';
import { CONNECT_WITH, skipGetStartedIfShown } from './helpers-wizard.js';
import { ACCEPT_WITH, checkInviteInApp } from './world.js';

const FULL = process.env['JOURNEY_SOAK'] === '1';
const CYCLES = FULL ? 20 : 5;
const STEPS_PER_CYCLE = 3;
const SEED =
  process.env['JOURNEY_SOAK_SEED'] !== undefined
    ? Number(process.env['JOURNEY_SOAK_SEED'])
    : Math.floor(Math.random() * 2 ** 31);
/** Virtual time per cycle: 20 cycles x 6 minutes = 2 hours. */
const CYCLE_SECONDS = 360;

let debugPage: Page | undefined;
let debugPageB: Page | undefined;
const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const ACTIONS = [
  'create',
  'rename',
  'pause-resume',
  'remove-other',
  'remove-open',
  'remove-last',
  'remove-relay-down',
  'restart-fault',
  'restart-clean',
  'mcp-session',
  'invite',
  'invite-stale',
  'send',
] as const;
type Action = (typeof ACTIONS)[number];

/** Labels with accents, CJK and a long one (D-138 labels). */
const LABELS = ['Zoë Ünal', 'テスト', 'Работа', 'Side project', "Ana-Maria O'Neil", 'Ligne 4 été'];

describe('chapter 6b: soak', () => {
  it(
    `${String(CYCLES)} cycles of mixed IDs, restarts, AI-app sessions and invites keep every invariant (seed ${String(SEED)})`,
    async (ctx) => {
      const ready = ch.need(ctx);
      if (ready === undefined) return;
      const trail: string[] = [];
      const tolerated: string[] = [];
      try {
        await soak(ready.browser, ready.files, trail, tolerated);
      } catch (error) {
        const shown = await text(debugPage as Page).catch(() => '');
        trail.push(`PAGE ${debugPage?.url() ?? ''}: ${shown.replace(/\s+/g, ' ').slice(0, 700)}`);
        trail.push(
          `PAGE-B ${debugPageB?.url() ?? ''}: ${(await text(debugPageB as Page).catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)}`,
        );
        const tail = trail.slice(-14).join('\n  ');
        throw new Error(
          `soak failed (seed ${String(SEED)}; repeat with JOURNEY_SOAK_SEED=${String(SEED)}): ${String(
            error instanceof Error ? error.message : error,
          )}\nlast steps:\n  ${tail}`,
          { cause: error },
        );
      } finally {
        const hit = Object.entries(KNOWN_FAILING)
          .filter(([, v]) => v.hits > 0)
          .map(([id, v]) => `${id} x${String(v.hits)}`);
        // eslint-disable-next-line no-console
        console.log(`soak seed ${String(SEED)}; KNOWN_FAILING hit: ${hit.join(', ') || 'none'}`);
        for (const line of tolerated) {
          // eslint-disable-next-line no-console
          console.log(line);
        }
        // A file for the person running it (vitest hides the console of a passing test).
        const report = process.env['JOURNEY_SOAK_REPORT'];
        if (report !== undefined) {
          await writeFile(
            report,
            `${[`seed ${String(SEED)}`, `KNOWN_FAILING hit: ${hit.join(', ') || 'none'}`, ...tolerated, ...trail].join('\n')}\n`,
          );
        }
      }
    },
    FULL ? 3_600_000 : 900_000,
  );
});

/** The "You and X are connected" sheet (and any other sheet) is closed the way a person closes it. */
async function dismissSheets(page: Page): Promise<void> {
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (
    await done
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await done
      .first()
      .click()
      .catch(() => undefined);
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await navTo(page, 'Home').catch(() => undefined);
}

async function soak(
  browser: Browser,
  files: Map<string, Uint8Array>,
  trail: string[],
  tolerated: string[],
): Promise<void> {
  const random = rng(SEED);
  const clock = virtualClock();
  const world = soakWorld();
  let pcA = await world.computer();
  const pcB = await world.computer();
  await fakeClaudeCode(pcA.home);
  const fault: Fault = { armed: false };
  const faultB: Fault = { armed: false };
  let a = await journeyPage(browser);
  debugPage = a.page;
  const b = await journeyPage(browser);
  debugPageB = b.page;
  const logsDir = await mkdtemp(join(tmpdir(), 'agentlink-soak-logs-'));
  const consoleLog: string[] = [];
  for (const jp of [a, b]) {
    jp.page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    jp.page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
  }
  let apiA = watchApi(a.page);
  const apiB = watchApi(b.page);
  const secrets = new Map<string, Uint8Array>();
  const closers = ch.closers;
  closers.push(() => rm(logsDir, { recursive: true, force: true }));

  // ---- start both computers: A with "Ana" (Claude Code on this computer), B with "Bo".
  let runA: SoakRun = await startSoakRun(pcA, files, closers, clock, fault);
  const runB = await startSoakRun(pcB, files, closers, clock, faultB);
  await firstRunWithTouchId(a, runA.link, 'Ana');
  await firstRunWithTouchId(b, runB.link, 'Bo');
  const mcpB = await startAiAppMcp(pcB, undefined);
  closers.push(() => mcpB.close());

  let mcpA: AiAppMcp | undefined;
  let labelN = 0;
  const usedLabels = new Set<string>(['Ana']);
  let renameN = 0;
  let firstRunHost = true;
  let expectUnfinished = false;
  const staleLinks: string[] = [];
  const goneLabels = new Set<string>();

  const entries = async () => (await pcA.directory.list()).filter((e) => !e.removing);
  /** The cards of the Agents page: the name on each (what a person reads) and which one is Open. */
  const cards = async (): Promise<{ label: string; open: boolean }[]> => {
    await openAgents(a.page);
    await a.page
      .getByRole('main')
      .getByRole('region')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    // Settle: the cards read their own state; the Open mark comes with it.
    await a.page.waitForTimeout(150);
    const lines = (await a.page.locator('body').ariaSnapshot()).split('\n');
    const found: { label: string; open: boolean }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(\s*)- region "([^"]+)"/.exec(lines[i] ?? '');
      if (m === null) continue;
      const indent = (m[1] ?? '').length;
      let open = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j] ?? '';
        if (line.length - line.trimStart().length <= indent) break;
        if (/- text: Open\s*$/.test(line)) open = true;
      }
      found.push({ label: (m[2] ?? '').replace(/[\u2066-\u2069]/g, ''), open });
    }
    return found;
  };
  const labels = async (): Promise<string[]> => (await cards()).map((c) => c.label);
  /** The open ID, by the card marked Open. */
  const openLabel = async (): Promise<string | undefined> => {
    const all = await cards();
    return (all.find((c) => c.open) ?? all[0])?.label;
  };
  const nextLabel = async (): Promise<string> => {
    const base = LABELS[labelN % LABELS.length] ?? 'ID';
    labelN += 1;
    const have = usedLabels;
    const label = have.has(base) ? `${base} ${String(labelN)}` : base;
    usedLabels.add(label);
    return label;
  };

  const closeMcp = async (): Promise<void> => {
    const m = mcpA;
    mcpA = undefined;
    await m?.close().catch(() => undefined);
  };

  /** The page is the app (an ID is open); else restart the host and open it again. */
  const settle = async (): Promise<void> => {
    await a.page
      .getByRole('button', { name: /^ID: / })
      .first()
      .waitFor({ timeout: 8_000 })
      .catch(async () => {
        trail.push('  settle: no ID chip; restarting the host');
        await restartHost();
      });
  };

  async function restartHost(): Promise<void> {
    await closeMcp();
    const code = await runA.stop();
    expect(code, 'the host exits 0 after a clean quit').toBe(0);
    expect(
      existsSync(join(pcA.home, '.agentlink', 'app-host.json')),
      'app-host.json left behind',
    ).toBe(false);
    runA = await startSoakRun(pcA, files, closers, clock, fault);
    firstRunHost = false;
    await a.page.goto(runA.link);
    await landOn(a.page);
  }

  /**
   * Recovery from F4 only: the person starts over on a new computer (a new home), as they must until the
   * app can make an ID when none is left. The old home keeps being scanned for secrets (they stay in
   * `secrets`); the new one is the one the checks look at from here on.
   */
  async function reinstall(): Promise<void> {
    await closeMcp();
    await runA.stop();
    pcA = await world.computer();
    await fakeClaudeCode(pcA.home);
    runA = await startSoakRun(pcA, files, closers, clock, fault);
    firstRunHost = true;
    // A new computer is a new browser window (its own passkey store), as it is for a person.
    await a.context.close().catch(() => undefined);
    a = await journeyPage(browser);
    debugPage = a.page;
    a.page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    a.page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
    apiA = watchApi(a.page);
    // First run, from whichever step Get started opens on (the app may already be picked).
    const label = await nextLabel();
    await a.page.goto(runA.link);
    const apps = a.page.getByRole('heading', { name: 'Which AI app do you use?' });
    const confirm = a.page.getByRole('heading', { name: "Confirm it's you" });
    await apps.or(confirm).first().waitFor({ timeout: 30_000 });
    if (await apps.isVisible()) {
      await a.page
        .getByRole('button', { name: /^Continue with / })
        .first()
        .click();
      await confirm.waitFor({ timeout: 30_000 });
    }
    await a.page.getByLabel('Name people see').fill(label);
    await a.page.getByRole('button', { name: CONNECT_WITH }).click();
    await a.page.getByRole('button', { name: 'I saved it' }).click();
    await a.page.getByRole('button', { name: 'Go to Home' }).click();
    await a.page.waitForURL((url) => url.pathname === '/');
    trail.push('  reinstall: new computer A after F4');
  }

  /**
   * From "Name this ID" (or the AI-app step) to the app's Home: the name, the AI app ("Not found
   * yet": the ID alone), one Touch ID, Go to Home. As addAgent, from any step of Get started.
   */
  async function nameAndConnect(page: Page, label: string, wait: number): Promise<void> {
    const name = page.getByRole('heading', { name: 'Name this ID', level: 1 });
    const apps = page.getByRole('heading', { name: 'Which AI app do you use?' });
    await name.or(apps).first().waitFor({ timeout: wait });
    if (await name.isVisible()) {
      await page.getByLabel('Name people see').fill(label);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await apps.waitFor({ timeout: wait });
    }
    await page.getByRole('button').filter({ hasText: 'Not found yet' }).first().click();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    const field = page.getByLabel('Name people see');
    if ((await field.count()) > 0 && (await field.first().inputValue()) === '') {
      await field.first().fill(label);
    }
    if (
      await page
        .getByText(/No ID is left on this computer/)
        .first()
        .isVisible()
    ) {
      throw new Error('the app cannot make an ID here: "No ID is left on this computer"');
    }
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    const saved = page.getByRole('button', { name: 'I saved it' });
    await saved
      .waitFor({ timeout: 3_000 })
      .then(() => saved.click())
      .catch(() => undefined);
    await page.getByRole('button', { name: 'Go to Home', exact: true }).click({ timeout: wait });
    await page.getByRole('navigation', { name: 'Sections' }).first().waitFor({ timeout: wait });
  }

  /** After a launch: Get started (no ID, or none connected) is skipped or completed; else Home. */
  async function landOn(page: Page): Promise<void> {
    const wizard = page.getByRole('heading', { name: 'Which AI app do you use?' });
    const chip = page.getByRole('button', { name: /^ID: / }).first();
    await wizard
      .or(chip)
      .or(page.getByRole('link', { name: 'Skip to Home' }))
      .first()
      .waitFor({ timeout: 20_000 });
    trail.push(`  landOn: ${new URL(page.url()).pathname}`);
    if ((await entries()).length === 0) {
      const newLabel = await nextLabel();
      // Zero IDs: the host offers Get started ("Name this ID" first, then the AI app); finish it.
      const ok = await tolerate(
        'F4',
        'Get started cannot make an ID after a restart with zero IDs',
        tolerated,
        () => nameAndConnect(page, newLabel, 15_000).then(() => undefined),
      );
      if (!ok) await reinstall();
      return;
    }
    await skipGetStartedIfShown(page);
  }

  // ------------------------------------------------------------------------------- invariants
  const verify = async (step: string): Promise<void> => {
    // 1. host up
    expect(runA.up(), `${step}: host A is still up`).toBe(true);
    expect(runB.up(), `${step}: host B is still up`).toBe(true);
    expect(a.page.isClosed(), `${step}: page A is open`).toBe(false);

    // 2. API answers
    for (const err of [...apiA.drain(), ...apiB.drain()]) {
      trail.push(`    api ${err.code} ${err.path} ${err.status ?? '-'}/${err.reason ?? '-'}`);
      // The live stream (server-sent events) has no JSON body: its 409 is "no ID is open yet".
      if (err.path === '/api/ui/events' && err.code === 409) continue;
      if (err.status === undefined || !STATUS_FORM.test(err.status)) {
        if (err.code >= 500 || err.status === undefined) {
          // A non-JSON or status-less error answer is a bug unless it is the router's plain 404.
          expect(
            err.code,
            `${step}: ${err.path} answered ${String(err.code)} with no status: ${err.raw}`,
          ).toBe(404);
        }
        continue;
      }
      if (err.status === 'failed') {
        if (err.reason === undefined)
          known('REASONS', `${err.path} failed without a reason`, tolerated);
        else
          expect(
            KNOWN_REASONS.has(err.reason),
            `${step}: unknown reason ${err.reason} at ${err.path}`,
          ).toBe(true);
      }
    }

    // 3. generic phrases
    for (const jp of [a, b]) {
      const body = await text(jp.page).catch(() => '');
      expect(deniedIn(body), `${step}: generic phrase on a page`).toEqual([]);
    }

    // 4. home invariants
    const all = await pcA.directory.list();
    if (!expectUnfinished) {
      expect(
        all.filter((e) => e.removing === true).map((e) => e.name),
        `${step}: an ID is stuck in "removing"`,
      ).toEqual([]);
    }
    const names = new Set(all.map((e) => e.name));
    const dirs = await readdir(join(pcA.home, '.agentlink', 'agents')).catch(() => [] as string[]);
    expect(dirs.sort(), `${step}: folders == directory listing`).toEqual([...names].sort());
    const dangling = aiAppEntryAgents(pcA.home).filter((n) => !names.has(n));
    expect(dangling, `${step}: an AI-app entry names a removed ID`).toEqual([]);

    // 5. terminal output
    for (const [who, run] of [
      ['A', runA],
      ['B', runB],
    ] as const) {
      for (const line of [...run.printed, ...run.errors]) {
        expect(
          line.trimStart().startsWith('{'),
          `${step}: raw JSON in ${who}'s terminal output`,
        ).toBe(false);
      }
    }

    // 6. canary scan (keychain values of both computers, past and present)
    await keychainCanaries(pcA, secrets);
    await keychainCanaries(pcB, secrets);
    await writeFile(
      join(logsDir, 'terminal.log'),
      [...runA.printed, ...runA.errors, ...runB.printed, ...runB.errors, ...consoleLog].join('\n'),
    );
    const leaks = await canaryFindings([pcA.home, pcB.home, logsDir], secrets);
    expect(leaks, `${step}: a secret reached the home, the output or a log`).toEqual([]);
  };

  /**
   * Agents -> Remove -> type the name -> Remove with Touch ID, then whatever the app asks (the
   * passkey, "Remove anyway"). Done when the home no longer lists the ID: the page's own "was
   * removed" line is not shown when the removed ID was the last one.
   */
  const removeId = async (label: string, mustBeUndeliverable = false): Promise<void> => {
    const namesBefore = (await pcA.directory.list()).map((e) => e.name);
    // F16: an AI app runs this ID, so removal step 5 has an entry to take out.
    await seedAiAppEntry(pcA.home, label);
    await openAgents(a.page);
    await (await inMore(a.page, label, 'Remove')).click();
    await driveRemoval(label, namesBefore, mustBeUndeliverable);
  };

  /** The Remove sheet is open: type the name, Touch ID, then whatever the app asks, until it is gone. */
  const driveRemoval = async (
    label: string,
    namesBefore: string[],
    mustBeUndeliverable = false,
    finishing = false,
  ): Promise<void> => {
    // Finishing a half-done removal asks for presence only, never the typed name (04 §2.5).
    if (!finishing) await a.page.getByLabel(labelled('Type ', label, ' to confirm')).fill(label);
    await a.page
      .getByRole('button', { name: finishing ? 'Finish with Touch ID' : 'Remove with Touch ID' })
      .click();
    const confirm = a.page.getByRole('button', { name: CONFIRM_PASSKEY });
    const anyway = a.page.getByRole('button', { name: 'Remove anyway' });
    let sawAnyway = false;
    const deadline = Date.now() + 90_000;
    for (;;) {
      const now = (await pcA.directory.list()).map((e) => e.name);
      if (now.length < namesBefore.length) break;
      if (Date.now() > deadline) throw new Error('timed out waiting for the removal to finish');
      if (await confirm.isVisible().catch(() => false))
        await confirm.click().catch(() => undefined);
      else if (await anyway.isVisible().catch(() => false)) {
        sawAnyway = true;
        expectUnfinished = true;
        await verify('remove (undeliverable)');
        expectUnfinished = false;
        await anyway.click().catch(() => undefined);
      }
      await a.page.waitForTimeout(200);
    }
    if (mustBeUndeliverable)
      expect(sawAnyway, 'relay down: the app offers "Remove anyway"').toBe(true);
    goneLabels.add(label);
  };

  // --------------------------------------------------------------------------------- the actions
  const act: Record<Action, { can: () => Promise<boolean>; run: () => Promise<void> }> = {
    create: {
      can: async () => (await entries()).length < 4,
      run: async () => {
        await settle();
        await addAgent(a.page, await nextLabel());
      },
    },
    rename: {
      can: async () => (await entries()).length >= 1,
      run: async () => {
        await settle();
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        renameN += 1;
        // Same script as the old name (a name that mixes scripts is refused), made new by a number.
        const to = `${cur.replace(/ \d+$/, '').slice(0, 24)} ${String(renameN)}`;
        await openAgents(a.page);
        await agentCard(a.page, cur).getByRole('button', { name: 'Rename', exact: true }).click();
        await agentCard(a.page, cur).getByLabel('Name', { exact: true }).fill(to);
        await a.page.getByRole('button', { name: 'Rename with Touch ID' }).click();
        await a.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
        // Done: the card carries the new name; limited (3 a day); or "Couldn't rename it" (F23: the
        // fan-out to contacts counts a partly failed set as failure).
        const renamed = agentCard(a.page, to);
        const limited = a.page.getByText(/You can rename .* again at/).first();
        const failed = a.page.getByText(/Couldn't rename it|Not renamed yet/).first();
        await renamed.or(limited).or(failed).first().waitFor({ timeout: 30_000 });
        if (await failed.isVisible()) {
          known('F23', 'rename answered "Couldn\'t rename it"', tolerated);
          await a.page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
        } else if (await limited.isVisible()) {
          await a.page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
        }
      },
    },
    'pause-resume': {
      can: async () => (await entries()).length >= 1,
      run: async () => {
        await settle();
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        await closeMcp();
        await openAgents(a.page);
        await agentCard(a.page, cur).getByRole('button', { name: 'Pause', exact: true }).click();
        const sheet = a.page.getByRole('dialog', { name: labelled('Pause ', cur, '?') });
        await sheet.getByRole('button', { name: 'Pause', exact: true }).click();
        await agentCard(a.page, cur).getByText('Paused', { exact: true }).first().waitFor();
        await verify('pause');
        clock.advance(120);
        await a.page.getByRole('button', { name: 'Resume with Touch ID' }).first().click();
        await a.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
        await eventually(
          'resumed',
          async () => !(await text(a.page)).includes(' is paused'),
          30_000,
        );
      },
    },
    'remove-other': {
      can: async () => (await entries()).length >= 2,
      run: async () => {
        await settle();
        await closeMcp();
        const cur = await openLabel();
        const other = (await labels()).find((l) => l !== cur);
        if (other === undefined) throw new Error('nothing to act on: no other');
        await removeId(other);
      },
    },
    'remove-open': {
      can: async () => (await entries()).length >= 2,
      run: async () => {
        await settle();
        await closeMcp();
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        await removeId(cur);
        await settle();
      },
    },
    'remove-last': {
      can: async () => (await entries()).length === 1,
      run: async () => {
        await settle();
        await closeMcp();
        // The host after a restart (the usual one) has no create path for zero IDs (F4); the host a
        // first run started has one. Test the usual one.
        if (firstRunHost) await restartHost();
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        // Four variants in turn: with or without a contact, then a restart or a new ID in the same host.
        const variant = Math.floor(random() * 4);

        if ((variant & 1) === 0) {
          await befriend(await inviteLink());
          await closeMcp();
        }
        await removeId(cur);
        await verify('remove-last');
        // Half the time the person restarts the app with no ID left (Get started must offer to make one;
        // F4: it cannot yet); the other half they add one in the same host.
        if ((variant & 2) !== 0) {
          await restartHost();
          if ((await entries()).length === 0) throw new Error('still no ID after recovery');
          return;
        }
        const label = await nextLabel();
        const ok = await tolerate(
          'F4',
          'create after the last ID was removed',
          tolerated,
          async () => {
            await a.page
              .getByRole('main')
              .getByRole('button', { name: 'New ID', exact: true })
              .first()
              .click({ timeout: 8_000 });
            await nameAndConnect(a.page, label, 20_000);
          },
        );
        if (!ok) {
          await verify('remove-last (after tolerated F4)');
          await restartHost();
        }
        if ((await entries()).length === 0) throw new Error('still no ID after recovery');
      },
    },
    'remove-relay-down': {
      can: async () => (await entries()).length >= 2,
      run: async () => {
        await settle();
        await closeMcp();
        // The open ID needs a contact so "tell" has someone to tell: pair it with Bo first.
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        await befriend(await inviteLink());
        await closeMcp();
        world.switches.relayDown = true;
        try {
          await removeId(cur, true);
        } finally {
          world.switches.relayDown = false;
        }
        await settle();
      },
    },
    'restart-fault': {
      can: async () => (await entries()).length >= 2,
      run: async () => {
        await settle();
        await closeMcp();
        const cur = await openLabel();
        const other = (await labels()).find((l) => l !== cur);
        if (other === undefined) throw new Error('nothing to act on: no other');
        fault.armed = true;
        expectUnfinished = true;
        await openAgents(a.page);
        await (await inMore(a.page, other, 'Remove')).click();
        await a.page.getByLabel(labelled('Type ', other, ' to confirm')).fill(other);
        await a.page.getByRole('button', { name: 'Remove with Touch ID' }).click();
        const confirm = a.page.getByRole('button', { name: CONFIRM_PASSKEY });
        await confirm
          .waitFor({ timeout: 15_000 })
          .then(() => confirm.click())
          .catch(() => undefined);
        // The apps step failed after the mark: the ID stays, "Removal not finished" or a failure note.
        await a.page
          .getByText(/Couldn't finish removing|Removal not finished|Not removed/)
          .first()
          .waitFor({ timeout: 30_000 });
        await verify('restart-fault (failed step)');
        // Host restart mid-flow.
        await restartHost();
        await openAgents(a.page);
        const namesBeforeFinish = (await pcA.directory.list()).map((e) => e.name);
        const card = agentCard(a.page, other);
        await card.getByText('Removal not finished').first().waitFor({ timeout: 20_000 });
        await card.getByRole('button', { name: 'Try again', exact: true }).click();
        await driveRemoval(other, namesBeforeFinish, false, true);
        goneLabels.add(other);
        expectUnfinished = false;
      },
    },
    'restart-clean': {
      can: async () => true,
      run: async () => {
        await restartHost();
      },
    },
    'mcp-session': {
      can: async () => (await entries()).length >= 1,
      run: async () => {
        await settle();
        await closeMcp();
        const m = await startAiAppMcp(pcA, undefined);
        mcpA = m;
        const r = await m.call('agentlink_status');
        expect(typeof r.structured['status'], 'agentlink_status answers a status').toBe('string');
        clock.advance(30);
        if (random() < 0.5) await closeMcp();
      },
    },
    invite: {
      can: async () => (await entries()).length >= 1,
      run: async () => {
        await settle();
        const cur = await openLabel();
        if (cur === undefined) throw new Error('nothing to act on: no cur');
        const link = await inviteLink();
        staleLinks.push(`${cur}\u0000${link}`);
        await befriend(link);
      },
    },
    'invite-stale': {
      can: async () => staleLinks.some((s) => goneLabels.has(s.split('\u0000')[0] ?? '')),
      run: async () => {
        const stale = staleLinks.find((s) => goneLabels.has(s.split('\u0000')[0] ?? ''));
        if (stale === undefined) throw new Error('nothing to act on: no stale');
        await dismissSheets(b.page);
        await checkInviteInApp(b, stale.split('\u0000')[1] ?? '');
        await b.page.waitForTimeout(2_500);
        // Whatever the card says, it is not a generic failure (checked by the invariants).
      },
    },
    send: {
      can: async () => (await entries()).length >= 1,
      run: async () => {
        await settle();
        if (mcpA === undefined) mcpA = await startAiAppMcp(pcA, undefined);
        const sent = await mcpA.call('agentlink_send', {
          to: 'Bo',
          text: `soak ${String(clock.elapsed)}`,
        });
        expect(typeof sent.structured['status'], 'agentlink_send answers a status').toBe('string');
      },
    },
  };

  /**
   * A new invite link from the open ID. The AI app runs the ID's sync all day (that is what finishes
   * an accept), so A's AI app session is started first, as it would be running on a real computer.
   */
  async function inviteLink(): Promise<string> {
    await settle();
    if (mcpA === undefined) mcpA = await startAiAppMcp(pcA, undefined);
    await dismissSheets(a.page);
    return createInviteInApp(a);
  }

  async function completeCount(): Promise<number> {
    const listed = await mcpB.call('agentlink_list_contacts');
    const contacts = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
    return contacts.filter((c) => c['pairing'] === 'complete').length;
  }

  /**
   * Bo pastes the link and accepts with one Touch ID; waits for one more complete pairing. The card
   * names a sender whose name is not plain Latin as "Contact XXXX" (the app's safe display), so the
   * inviter's name is not asserted here.
   */
  async function befriend(link: string): Promise<void> {
    await dismissSheets(b.page);
    const before = await completeCount();
    await checkInviteInApp(b, link);
    await b.page
      .getByText(/invites you to connect your AIs$/)
      .first()
      .waitFor();
    await b.page.getByRole('button', { name: ACCEPT_WITH }).click();
    // A new pairing, or the same person again ("Connected again with ..."): either way Bo says so.
    const connected = (): Promise<true | undefined> =>
      (async () =>
        (await completeCount()) > before ||
        /are connected|Connected again with/.test(await text(b.page))
          ? true
          : undefined)();
    // NEW-INVITE-STUCK: after an ID was renamed, an accepted invite can stay at "Connecting to ..." on
    // both sides for good. Tolerated (and counted) here only; everything else about the step is checked.
    const ok = await tolerate(
      'NEW-INVITE-STUCK',
      'accepted invite never completed',
      tolerated,
      async () => {
        await until('Bo is connected', connected, 20_000);
      },
    );
    if (!ok) await dismissSheets(b.page);
  }

  // ----------------------------------------------------------------------------------- the loop
  await skipGetStartedIfShown(a.page).catch(() => undefined);
  await verify('start');
  let deck: Action[] = [];
  // JOURNEY_SOAK_ACTIONS="create,rename,..." plays those steps first (to repeat a failure), then the deck.
  const scripted = (process.env['JOURNEY_SOAK_ACTIONS'] ?? '')
    .split(',')
    .filter((x): x is Action => (ACTIONS as readonly string[]).includes(x));
  const draw = async (): Promise<Action> => {
    const first = scripted.shift();
    if (first !== undefined && !(await act[first].can())) return draw();
    if (first !== undefined) return first;
    for (let guard = 0; guard < 100; guard += 1) {
      if (deck.length === 0) {
        deck = [...ACTIONS];
        for (let i = deck.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [deck[i], deck[j]] = [deck[j] as Action, deck[i] as Action];
        }
      }
      const next = deck.pop() as Action;
      if (await act[next].can()) return next;
    }
    return 'restart-clean';
  };
  const started = Date.now();
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    for (let s = 0; s < STEPS_PER_CYCLE; s += 1) {
      const action = await draw();
      const label = `cycle ${String(cycle)} step ${String(s + 1)}: ${action} (IDs: ${String((await entries()).length)})`;
      trail.push(label);
      await act[action].run();
      await verify(label);
      clock.advance(60);
    }
    clock.advance(CYCLE_SECONDS - 60 * STEPS_PER_CYCLE);
    trail.push(
      `cycle ${String(cycle)} done; virtual ${String(Math.round(clock.elapsed / 60))} min`,
    );
  }
  await closeMcp();
  // Finish: clean quit, the record is gone, exit 0.
  expect(await runA.stop()).toBe(0);
  expect(existsSync(join(pcA.home, '.agentlink', 'app-host.json'))).toBe(false);
  trail.push(
    `soak: ${String(CYCLES)} cycles, virtual ${String(Math.round(clock.elapsed / 60))} min, real ${String(
      Math.round((Date.now() - started) / 1000),
    )} s`,
  );
}
