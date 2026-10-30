// U3-k (S1; USABILITY-WAVE-3 §4, §8; 08 §1, §4; 06 §7; 04 §2.5): usability wave 3 end to end, in the
// built local app in Chromium. See app-world.ts for what is shipped code and what is substituted
// (keychain file, in-memory relay, a CDP virtual authenticator for Touch ID). No Docker, no network,
// no OS keychain; every file is written under a temp folder.
//
// 1. A new person on a fresh home: `agentlink ui` opens Welcome, the person names the agent with one
//    Touch ID, connects Claude Code (the entry is written, with a backup that keeps the file mode),
//    adds a second agent of their own, pairs the two with an invite through the Contacts page, the
//    first says hello (through the AI app's MCP server, which is where messages are written) and the
//    second answers; both are read in the app after a switch.
// 2. The invite-join path: a friend on a fresh home runs `agentlink join`, Welcome, name, Touch ID,
//    "Accept {name}'s invite?", Connected; the inviter sees the new contact.
// 3. The upgrade run: the home as 0.4.3 leaves it (four-key agent configs, no app.json, real message
//    history between two agents). After the update all agents are listed, none lost or renamed,
//    switching shows each one's history, and no terminal picker is asked.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryRelays } from '../src/memory-relay.mjs';
import {
  builtAppFiles,
  fakeClaudeCode,
  launchBrowser,
  newComputer,
  openedLink,
  pageWithTouchId,
  runJoin,
  runUi,
  seedAgent,
  startAiAppMcp,
  until,
  type AiAppMcp,
  type Computer,
} from './app-world.js';

// W4-WIZARD: first run is Get started (journey/helpers-wizard.ts).
const CONNECT_WITH = /^Connect with (Touch ID|Windows Hello|your passkey)$/;
const INVITE_LINK = /https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]+/;
let browser: Browser | undefined;
let launchError: unknown;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  const launched = await launchBrowser();
  browser = launched.browser;
  launchError = launched.error;
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await browser?.close();
});

/** The built app and Chromium, or a skip locally; in CI a missing build or browser fails the run. */
function need(ctx: {
  skip: () => void;
}): { browser: Browser; files: Map<string, Uint8Array> } | undefined {
  const files = builtAppFiles();
  if (browser === undefined && process.env['CI'] !== undefined) throw launchError;
  if (files === undefined && process.env['CI'] !== undefined) throw new Error('pnpm build first');
  if (browser === undefined || files === undefined) {
    ctx.skip();
    return undefined;
  }
  return { browser, files };
}

const sha = (file: string): string => encodeHex(sha256(new Uint8Array(readFileSync(file))));

/** Agents page: the Switch button on the card of the agent named `label`. */
async function switchTo(
  page: Page,
  origin: string,
  label: string,
  openLabel: string = label,
): Promise<void> {
  await page.goto(new URL('/settings/agents', origin).href);
  const card = page
    .getByText(label, { exact: true })
    .first()
    .locator('xpath=ancestor::*[.//button[normalize-space()="Switch"]][1]');
  await card.getByRole('button', { name: 'Switch', exact: true }).click();
  // The header names the agent that is now open (W4-SHELL-V2: the agent chip, top left).
  await page.locator('button.al-chip').filter({ hasText: openLabel }).waitFor();
}

/** Messages page: opens the conversation with `contact` and returns the page text. */
async function readConversation(page: Page, origin: string, contact: string): Promise<string> {
  await page.goto(new URL('/settings/messages', origin).href);
  await page.getByText(contact, { exact: true }).first().click();
  await page.getByText('Copy text').first().waitFor();
  return page.locator('body').innerText();
}

interface FirstHour {
  readonly pc: Computer;
  readonly link: string;
  readonly files: Map<string, Uint8Array>;
  readonly mcps: AiAppMcp[];
  readonly stopUi: () => Promise<void>;
  readonly hello: string;
  readonly answer: string;
}
let firstHour: FirstHour | undefined;

describe('a new person: Welcome to a reply (U3-k)', () => {
  // U3-g-c: with no agent open the app host gets the CLI's AI apps reader (list only), so Welcome's
  // picker lists the detected apps on a fresh computer (08 §1, b11 §28.2).
  it('the AI app picker lists Claude Code on a computer with no agent yet', async (ctx) => {
    const ready = need(ctx);
    if (ready === undefined) return;
    const pc = await newComputer();
    await fakeClaudeCode(pc.home);
    const run = runUi(pc, ready.files);
    closers.push(async () => {
      run.deps.stop();
      await run.done;
    });
    const { page } = await pageWithTouchId(ready.browser);
    await page.goto(await openedLink(pc));
    // W4-WIZARD: Get started opens on the app pick; Claude Code is found on this computer.
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page.getByRole('button', { name: /^Claude CodeFound on this/ }).waitFor();
    await page.getByRole('button', { name: 'Continue with Claude Code' }).waitFor();
  }, 120_000);

  it('runs the first hour on a fresh home: Welcome, Touch ID, connect, a second agent, hello and reply', async (ctx) => {
    const ready = need(ctx);
    if (ready === undefined) return;
    const pc = await newComputer();
    const claude = await fakeClaudeCode(pc.home);
    const settingsBefore = readFileSync(claude.file, 'utf8');

    // `agentlink ui` on a computer with no agent at all: the app opens on Welcome.
    const run = runUi(pc, ready.files);
    const stopUi = async (): Promise<void> => {
      run.deps.stop();
      await run.done;
    };
    closers.push(stopUi);
    const link = await openedLink(pc);
    expect(new URL(link).pathname).toBe('/first-run');
    expect(readdirSync(pc.home)).not.toContain('.agentlink');

    const { page } = await pageWithTouchId(ready.browser);
    await page.goto(link);
    // W4-WIZARD: Get started opens on the app pick.
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page.getByRole('button', { name: 'Continue with Claude Code' }).click();

    // Name and one Touch ID: the first agent, its owner and its first rules, and (W4-ONE-TOUCH,
    // D-140) the Claude Code entry for the app picked.
    await page.getByRole('heading', { name: "Confirm it's you" }).waitFor();
    await page.getByRole('button', { name: /^Change the agent's name/ }).click();
    await page.getByLabel('Name your agent').fill('Home base');
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    await page.getByRole('heading', { name: 'Your backup code' }).waitFor();
    await page.getByRole('button', { name: 'I saved it' }).click();
    await page.getByRole('heading', { name: 'Connected to Claude Code' }).waitFor();
    await page.getByRole('button', { name: 'Go to Home' }).click();
    await page.waitForURL(/\/settings\/home$|\/$/);
    const first = await pc.directory.read('default');
    expect(first).toMatchObject({ name: 'default', label: 'Home base', available: true });

    // The entry is in the settings, nothing else changed, and the backup keeps the bytes and the mode.
    const settings = JSON.parse(readFileSync(claude.file, 'utf8')) as {
      theme?: string;
      mcpServers: Record<string, unknown>;
    };
    expect(settings.theme).toBe('dark');
    expect(settings.mcpServers['other']).toEqual({ command: 'x' });
    expect(settings.mcpServers['agentlink']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@4thtech-io/agentlink', 'mcp'],
      env: {},
    });
    expect(statSync(claude.file).mode & 0o777).toBe(claude.mode);
    const backups = readdirSync(pc.home).filter((n) =>
      n.startsWith('.claude.json.agentlink-backup-'),
    );
    expect(backups).toHaveLength(1);
    const backup = join(pc.home, backups[0] ?? '');
    expect(readFileSync(backup, 'utf8')).toBe(settingsBefore);
    expect(statSync(backup).mode & 0o777).toBe(claude.mode);

    // A second agent of the person's own, with one Touch ID.
    await page.goto(new URL('/settings/agents', link).href);
    await page.getByRole('button', { name: 'Add agent' }).click();
    await page.getByLabel('Name your agent').fill('Second agent');
    await page.getByRole('button', { name: 'Add with Touch ID' }).click();
    await page.getByRole('button', { name: 'Confirm with your passkey' }).click();
    await page.getByText('Connect an AI app to it?').waitFor();
    await page.getByRole('button', { name: 'Not now' }).click();
    expect((await pc.directory.list()).map((e) => e.name)).toEqual(['default', 'second-agent']);

    // Each agent's AI app runs its own MCP server (what its entry starts); they do the syncing.
    const mcpFirst = await startAiAppMcp(pc, undefined);
    closers.push(() => mcpFirst.close());
    const mcpSecond = await startAiAppMcp(pc, 'second-agent');
    closers.push(() => mcpSecond.close());

    // The first agent invites from Contacts.
    await page.goto(new URL('/settings/contacts', link).href);
    await page.getByRole('button', { name: 'Add contact' }).first().click();
    await page.getByRole('button', { name: 'Create invite' }).click();
    await page.getByText('Invite ready').first().waitFor();
    const inviteUrl = INVITE_LINK.exec(await page.locator('body').innerText())?.[0] ?? '';
    expect(inviteUrl).not.toBe('');
    await page.getByRole('button', { name: 'Done' }).click();

    // Switch (nothing signed), and the second agent accepts it with Touch ID.
    await switchTo(page, link, 'Second agent');
    await page.goto(new URL('/settings/contacts', link).href);
    await page.getByRole('button', { name: 'Add contact' }).first().click();
    await page.getByRole('tab', { name: 'I have an invite' }).click();
    await page.getByLabel('Paste the invite link').fill(inviteUrl);
    await page.getByRole('button', { name: 'Check invite' }).click();
    await page.getByText('Is this who you expected?').waitFor();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm with your passkey' }).click();

    const complete = async (mcp: AiAppMcp): Promise<Record<string, unknown> | undefined> => {
      const listed = await mcp.call('agentlink_list_contacts');
      const [one] = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
      return one?.['pairing'] === 'complete' ? one : undefined;
    };
    const secondSees = await until('the second agent is paired', () => complete(mcpSecond), 60_000);
    const firstSees = await until('the first agent is paired', () => complete(mcpFirst), 60_000);
    // Each side sees the name the owner typed, not the folder (U3-d-b).
    expect(secondSees['name']).toBe('Home base');
    expect(firstSees['name']).toBe('Second agent');
    // Two agents of one owner: the same owner fingerprint on both sides.
    expect(secondSees['ownerFingerprint']).toBe(firstSees['ownerFingerprint']);

    // Hello and the reply.
    const hello = 'Hello from my first agent';
    const answer = 'Hello back from the second agent';
    expect(
      (await mcpFirst.call('agentlink_send', { to: String(firstSees['name']), text: hello }))
        .structured['status'],
    ).toBe('ok');
    await until(
      'hello arrives',
      async () =>
        JSON.stringify((await mcpSecond.call('agentlink_inbox')).structured).includes(hello)
          ? true
          : undefined,
      60_000,
    );
    expect(
      (await mcpSecond.call('agentlink_send', { to: String(secondSees['name']), text: answer }))
        .structured['status'],
    ).toBe('ok');
    await until(
      'the reply arrives',
      async () =>
        JSON.stringify((await mcpFirst.call('agentlink_inbox')).structured).includes(answer)
          ? true
          : undefined,
      60_000,
    );

    // The second agent is open in the app: its Messages page shows the hello.
    const atSecond = await readConversation(page, link, String(secondSees['name']));
    expect(atSecond).toContain(hello);
    // Back to the first agent: the reply is there.
    await switchTo(page, link, 'Home base');
    const atFirst = await readConversation(page, link, String(firstSees['name']));
    expect(atFirst).toContain(answer);

    // Zero access: no relay holds the plaintext or the invite; no server event carries a link.
    const relayDump = JSON.stringify(pc.relays.events());
    for (const secret of [hello, answer, inviteUrl, inviteUrl.split('#')[1] ?? '?']) {
      expect(relayDump).not.toContain(secret);
    }
    const eventDump = JSON.stringify(pc.events);
    expect(eventDump).not.toContain(inviteUrl.split('#')[1] ?? '?');
    expect(eventDump).not.toContain(new URL(link).searchParams.get('t') ?? '?');

    firstHour = {
      pc,
      link,
      files: ready.files,
      mcps: [mcpFirst, mcpSecond],
      stopUi,
      hello,
      answer,
    };
  }, 240_000);
});

describe('a friend joins from an invite link on a fresh home (U3-k)', () => {
  it('join opens Welcome, ends on Accept, and the inviter sees the new contact', async (ctx) => {
    const ready = need(ctx);
    if (ready === undefined) return;
    const relays = memoryRelays();
    const inviterPc = await newComputer(relays);
    await seedAgent(inviterPc, { name: 'default', displayName: 'Ana' });
    const inviter = await startAiAppMcp(inviterPc, undefined);
    closers.push(() => inviter.close());
    const inviteUrl = String(
      (await inviter.call('agentlink_create_invite')).structured['inviteUrl'],
    );
    expect(inviteUrl).toMatch(INVITE_LINK);

    // The friend: a fresh home, no agent. `agentlink join '<link>'`.
    const friendPc = await newComputer(relays);
    const join = runJoin(friendPc, ready.files, inviteUrl);
    closers.push(async () => {
      join.deps.stop();
      await join.done;
    });
    const link = await openedLink(friendPc);
    // The link the OS opener gets is the one-shot session link: the invite is nowhere in it.
    expect(new URL(link).pathname).toBe('/first-run');
    expect(link).not.toContain(inviteUrl.split('#')[1] ?? '?');
    expect(link).not.toContain('#');

    const { page } = await pageWithTouchId(ready.browser);
    await page.goto(link);
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    await page.getByRole('button', { name: /^Change the agent's name/ }).click();
    await page.getByLabel('Name your agent').fill('Friend agent');
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    await page.getByRole('heading', { name: 'Your backup code' }).waitFor();
    await page.getByRole('button', { name: 'I saved it' }).click();

    // First run ends on the invite, named by the inviter (Self-declared) with a short fingerprint.
    await page.getByRole('heading', { name: "Accept Ana's invite?" }).waitFor();
    const text = await page.locator('body').innerText();
    expect(text).toContain('Self-declared');
    expect(text).toContain('After you connect, compare the safety code with Ana.');
    expect(text).not.toContain(inviteUrl.split('#')[1] ?? '?');
    await page
      .getByRole('button', { name: /^Accept with (Touch ID|Windows Hello|your passkey)$/ })
      .click();
    await page.getByText("Waiting for Ana's agent to answer.").waitFor();

    // The friend's AI app starts the agent; its sync brings Ana's answer, then the safety code.
    const friendMcp = await startAiAppMcp(friendPc, undefined);
    closers.push(() => friendMcp.close());
    await page.getByText('Connected with Ana.').first().waitFor({ timeout: 60_000 });
    await page.getByText('Compare the safety code with Ana').waitFor();
    const contacts = await until(
      'the inviter sees the friend',
      async () => {
        const listed = await inviter.call('agentlink_list_contacts');
        const [one] = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
        return one?.['pairing'] === 'complete' ? one : undefined;
      },
      60_000,
    );
    // Contacts see the name the friend typed, not the folder (U3-d-b).
    expect(contacts['name']).toBe('Friend agent');

    // A message goes both ways.
    const sent = await inviter.call('agentlink_send', {
      to: 'Friend agent',
      text: 'Welcome aboard',
    });
    expect(sent.structured['status']).toBe('ok');
    await until(
      'the friend gets it',
      async () =>
        JSON.stringify((await friendMcp.call('agentlink_inbox')).structured).includes(
          'Welcome aboard',
        )
          ? true
          : undefined,
      60_000,
    );
    expect(JSON.stringify(relays.events())).not.toContain('Welcome aboard');
  }, 240_000);
});

describe('the upgrade run: a 0.4.3 home after the update (U3-k)', () => {
  it("lists every agent, none lost or renamed; switching shows each one's history; no terminal picker", async (ctx) => {
    const ready = need(ctx);
    if (ready === undefined) return;
    if (firstHour === undefined) {
      ctx.skip();
      return;
    }
    const { pc, hello, answer } = firstHour;
    // Close the "old" session: the app, the AI apps' MCP servers. Only the home stays.
    await firstHour.stopUi();
    for (const mcp of firstHour.mcps) await mcp.close();

    // The home as 0.4.3 leaves it: four-key agent configs (no label, no `removing`), no app.json,
    // an agent with no contacts, the Claude Code entry from before. The history stays as it is.
    const agentsDir = join(pc.home, '.agentlink', 'agents');
    const fourKeys = async (name: string): Promise<void> => {
      const file = join(agentsDir, name, 'config.json');
      const { v, agentId, keyStore } = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(file, `${JSON.stringify({ v, name, agentId, keyStore })}\n`, { mode: 0o600 });
    };
    await fourKeys('default');
    await fourKeys('second-agent');
    await seedAgent(pc, { name: 'work', displayName: 'Work' });
    await rm(join(pc.home, '.agentlink', 'app.json'), { force: true });
    const names = readdirSync(agentsDir).sort();
    expect(names).toEqual(['default', 'second-agent', 'work']);
    for (const name of names) {
      const config = JSON.parse(
        readFileSync(join(agentsDir, name, 'config.json'), 'utf8'),
      ) as object;
      expect(Object.keys(config).sort()).toEqual(['agentId', 'keyStore', 'name', 'v']);
    }
    const configsBefore = new Map(names.map((n) => [n, sha(join(agentsDir, n, 'config.json'))]));

    // `agentlink ui` after the update: it never asks which agent. Nothing but the open line is printed.
    pc.opened.length = 0;
    const run = runUi(pc, ready.files);
    closers.push(async () => {
      run.deps.stop();
      await run.done;
    });
    const link = await openedLink(pc);
    expect(new URL(link).pathname).toBe('/settings/home');
    const { page } = await pageWithTouchId(ready.browser);
    await page.goto(link);
    // W4-SHELL-V2: `/settings/home` opens Home at `/` (the section marked current).
    await page.waitForURL((url) => url.pathname === '/');
    await page.locator('nav.al-rail a[aria-current="page"][href="/"]').first().waitFor();

    // All agents are listed, by the names they had.
    await page.goto(new URL('/settings/agents', link).href);
    await page.getByText('work', { exact: true }).first().waitFor();
    const listed = await page.locator('body').innerText();
    // The open agent shows the name its owner signed (read from its store); the others, their folder names.
    for (const shown of ['Home base', 'second-agent', 'work']) expect(listed).toContain(shown);
    expect((await pc.directory.list()).map((e) => e.name)).toEqual(names);
    expect(await page.getByRole('button', { name: 'Switch', exact: true }).count()).toBe(2);

    // Switching shows each agent's history.
    await switchTo(page, link, 'second-agent', 'Second agent');
    expect(await readConversation(page, link, 'Home base')).toContain(hello);
    await switchTo(page, link, 'default', 'Home base');
    expect(await readConversation(page, link, 'Second agent')).toContain(answer);
    await switchTo(page, link, 'work');
    await page.goto(new URL('/settings/messages', link).href);
    await page.getByRole('heading', { name: 'Inbox' }).first().waitFor();
    await page.waitForTimeout(1500);
    // `work` has no contacts: none of the other agents' conversations show here.
    const empty = await page.locator('body').innerText();
    expect(empty).not.toContain(hello);
    expect(empty).not.toContain(answer);

    // None lost, none renamed: the configs are byte for byte what 0.4.3 left.
    for (const name of names) {
      expect(sha(join(agentsDir, name, 'config.json'))).toBe(configsBefore.get(name));
    }
    run.deps.stop();
    const ended = await run.done;
    expect(ended.errors).toEqual([]);
    expect(ended.printed).toHaveLength(1);
    expect(ended.code).toBe(0);
  }, 240_000);
});
