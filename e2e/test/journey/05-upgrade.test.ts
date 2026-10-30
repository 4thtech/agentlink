// W4-JOURNEY-E2E chapter 5, Upgrade (WAVE-4 build plan §1 step 9; 08 §1). The home as 0.4.3 leaves
// it: four-key agent configs (no label, no `removing`), no app.json, real message history with a
// contact on another computer, and a second agent that was never opened in the app. After the update
// `agentlink ui` asks nothing, every agent is there by the name it had, and the history shows.
import { readdirSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runUi, openedLink, seedAgent, until } from '../app-world.js';
import {
  chapter,
  inboxHas,
  journeyPage,
  journeyWorld,
  navTo,
  pairedOwners,
  text,
  type JourneyComputer,
  type JourneyWorld,
} from './world.js';
import { skipGetStartedIfShown } from './helpers-wizard.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const HELLO = 'Hello from before the update';
const REPLY = 'Got it, before the update too';
const sha = (file: string): string => encodeHex(sha256(new Uint8Array(readFileSync(file))));

/**
 * Start state: computer A as 0.4.3 leaves it. Ana (paired with Bo on computer B, one message each
 * way) and "work" (seeded by `agentlink init`, never opened in the app). The app and the AI app on A
 * are quit; the configs are cut back to the four 0.4.3 keys and app.json is removed.
 */
async function oldHome(
  ready: NonNullable<ReturnType<typeof ch.need>>,
  world: JourneyWorld,
): Promise<{ pc: JourneyComputer; configs: Map<string, string>; names: string[] }> {
  const { pcA, mcpA, mcpB, quitA } = await pairedOwners(
    ready.browser,
    ready.files,
    world,
    ch.closers,
  );
  await mcpA.call('agentlink_send', { to: 'Bo', text: HELLO });
  await until('the hello reaches Bo', () => inboxHas(mcpB, HELLO), 30_000);
  await mcpB.call('agentlink_send', { to: 'Ana', text: REPLY });
  await until('the reply reaches Ana', () => inboxHas(mcpA, REPLY), 30_000);
  await quitA();
  await mcpA.close();

  const pc = pcA;
  await seedAgent(pc, { name: 'work', displayName: 'Work' });
  const agentsDir = join(pc.home, '.agentlink', 'agents');
  for (const name of readdirSync(agentsDir)) {
    const file = join(agentsDir, name, 'config.json');
    const { v, agentId, keyStore } = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(file, `${JSON.stringify({ v, name, agentId, keyStore })}\n`, { mode: 0o600 });
  }
  await rm(join(pc.home, '.agentlink', 'app.json'), { force: true });
  const names = readdirSync(agentsDir).sort();
  expect(names).toEqual(['default', 'work']);
  return {
    pc,
    names,
    configs: new Map(names.map((n) => [n, sha(join(agentsDir, n, 'config.json'))])),
  };
}

describe('chapter 5: upgrade', () => {
  // Passes today: the 0.4.3 home opens in the current app (no picker), every agent is listed by the
  // name it had, the history is readable, and the configs stay byte for byte.
  it('a 0.4.3 home opens in the current app: no picker, no lost agents or names, history kept', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pc, names, configs } = await oldHome(ready, world);

    pc.opened.length = 0;
    const run = runUi(pc, ready.files);
    ch.closers.push(async () => {
      run.deps.stop();
      await run.done;
    });
    const jp = await journeyPage(ready.browser);
    await jp.page.goto(await openedLink(pc));
    // W4-WIZARD: no AI app is connected in this home, so Get started opens; skip it.
    await skipGetStartedIfShown(jp.page);
    const probe = await jp.arm();

    // W4-SHELL-V2: the Agents page opens from the agent chip's dropdown, top left; the history is on
    // today's Messages page (Go to), until Home (U3) holds it.
    await jp.page
      .getByRole('button', { name: /^Agent: / })
      .first()
      .click();
    await jp.page.getByRole('menuitem', { name: 'Manage agents' }).click();
    await jp.page.getByText('work', { exact: true }).first().waitFor();
    const listed = await text(jp.page);
    for (const shown of ['Ana', 'work']) expect(listed).toContain(shown);
    expect((await pc.directory.list()).map((e) => e.name)).toEqual(names);

    await navTo(jp.page, 'Inbox');
    await jp.page.getByText('Bo', { exact: true }).first().click();
    await jp.page.getByText(REPLY).first().waitFor({ timeout: 30_000 });

    const agentsDir = join(pc.home, '.agentlink', 'agents');
    for (const name of names)
      expect(sha(join(agentsDir, name, 'config.json'))).toBe(configs.get(name));
    await probe.check();
    run.deps.stop();
    const ended = await run.done;
    expect(ended.errors).toEqual([]);
    // Nothing but the "opened" line: no terminal picker.
    expect(ended.printed).toHaveLength(1);
    expect(ended.code).toBe(0);
  }, 240_000);

  // W4-SHELL-V2 (U1): the shell part is built (lands on Home, the live dropdown lists every agent);
  // the history moves into Home with U3, until then it is on today's Messages page.
  it('a 0.4.3 home lands on Home; the live agent dropdown lists every agent; the history is kept', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pc } = await oldHome(ready, world);
    pc.opened.length = 0;
    const run = runUi(pc, ready.files);
    ch.closers.push(async () => {
      run.deps.stop();
      await run.done;
    });
    const jp = await journeyPage(ready.browser);
    await jp.page.goto(await openedLink(pc));
    // W4-WIZARD: no AI app is connected in this home, so Get started opens; skip it.
    await skipGetStartedIfShown(jp.page);
    const probe = await jp.arm();
    await jp.page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: /^Home/ })
      .and(jp.page.locator('[aria-current="page"]'))
      .first()
      .waitFor();
    expect(new URL(jp.page.url()).pathname).toBe('/');
    await jp.page
      .getByRole('button', { name: /^Agent: / })
      .first()
      .click();
    await jp.page.getByText('Your agents · live').first().waitFor();
    for (const label of ['Ana', 'work']) {
      await jp.page.getByRole('menuitemradio').filter({ hasText: label }).first().waitFor();
    }
    await jp.page.keyboard.press('Escape');
    await navTo(jp.page, 'Inbox');
    await jp.page.getByText('Bo', { exact: true }).first().click();
    await jp.page.getByText(REPLY).first().waitFor({ timeout: 30_000 });
    await probe.check();
  }, 240_000);
});
