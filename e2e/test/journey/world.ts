// W4-JOURNEY-E2E: the harness of the wave-4 journey test (WAVE-4 build plan §1; Decisions 40–45).
// It extends app-world.ts (one "computer" = a temp home, the built CLI's own `ui` code and the built
// local app in Chromium) with what the journey needs on top:
//   - two computers that share ONE in-memory relay and ONE fake encrypted drop (src/fake-drop.mjs), so
//     invites, messages and files really travel between two app hosts;
//   - a gesture counter: a pass-through wrapper on `navigator.credentials.create/get` (installed with
//     addInitScript before the page loads) that counts each Touch ID prompt and never changes its
//     arguments or result. The passkey is the CDP virtual authenticator with PRF of app-world.ts, so
//     the server runs its real WebAuthn checks and signs real owner actions; nothing fakes signing;
//   - a no-reload probe: a random marker on `window` after the first load, and a count of new
//     documents (main-frame `load`) after it. A reload or a full navigation loses the marker and
//     counts a document; an in-app navigation (history API) does neither.
// Nothing here prints a key, a link or a path. Every file is written under a temp folder.
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { expect } from 'vitest';
import { createFakeDrop } from '../../src/fake-drop.mjs';
import { memoryRelays } from '../../src/memory-relay.mjs';
import {
  builtAppFiles,
  launchBrowser,
  newComputer,
  openedLink,
  pageWithTouchId,
  runUi,
  startAiAppMcp,
  until,
  type AiAppMcp,
  type Computer,
} from '../app-world.js';
import { getStartedWithTouchId } from './helpers-wizard.js';

export type FakeDrop = ReturnType<typeof createFakeDrop>;
export type Relays = ReturnType<typeof memoryRelays>;

/**
 * Wave-4 chapters that are not built yet run only with JOURNEY_WAVE4=1 (off in CI). The card that
 * builds a chapter turns its gate off in its own PR (the gate line names the card), so CI never
 * carries a failing test and nothing relies on `it.fails` across PRs.
 */
export const WAVE4 = process.env['JOURNEY_WAVE4'] === '1';

export const TOUCH_ID = /^Use (Touch ID|Windows Hello|a passkey)$/;
export const CONFIRM_PASSKEY = 'Confirm with your passkey';
/** Format 1 (D-69) links: the whole card in the fragment. */
export const LONG_INVITE = /https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_.-]+/;
/** Format 2 (D-139): `https://<invite-host>/i#2.<43 characters>`. */
export const SHORT_INVITE = /https:\/\/[a-z0-9.-]+\/i#2\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

/** One computer of the journey: its home, its `agentlink ui` run, and the shared relay and drop. */
export interface JourneyComputer extends Computer {
  readonly drop: FakeDrop;
}

/** Two computers on one relay and one drop. */
export interface JourneyWorld {
  readonly relays: Relays;
  readonly drop: FakeDrop;
  computer(): Promise<JourneyComputer>;
}

export function journeyWorld(): JourneyWorld {
  const relays = memoryRelays();
  const drop = createFakeDrop();
  return {
    relays,
    drop,
    computer: async () => {
      const pc = await newComputer(relays);
      const base = pc.runtime;
      // The agents' real drop adapter talks to the shared fake drop (as world.ts does for the CLI).
      const runtime = {
        ...base,
        createClient: (options: Parameters<typeof base.createClient>[0]) =>
          base.createClient({
            ...options,
            ...(options.files === undefined
              ? {}
              : {
                  files: {
                    ...options.files,
                    drop: { endpoint: drop.origin, fetch: drop.fetch },
                    download: drop.download,
                  },
                }),
          }),
      } as typeof base;
      return { ...pc, runtime, drop };
    },
  };
}

/** Touch ID prompts the page asked for (create = a new passkey, get = a confirmation). */
export interface Gestures {
  readonly create: number;
  readonly get: number;
  total(): number;
}

/** The marker and document count of one page, armed after its first load. */
export interface NoReload {
  /** Asserts the marker survived and no new document loaded since `arm`. */
  check(): Promise<void>;
  readonly documents: number;
}

export interface JourneyPage {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly gestures: Gestures;
  /** Arms the no-reload probe; call after the first `goto` has loaded. */
  arm(): Promise<NoReload>;
}

const COUNTER_SCRIPT = `(() => {
  const c = globalThis.navigator && globalThis.navigator.credentials;
  if (!c || globalThis.__journeyWrapped) return;
  globalThis.__journeyWrapped = true;
  for (const name of ['create', 'get']) {
    const original = c[name].bind(c);
    c[name] = (options) => {
      if (options && options.publicKey) globalThis.__journeyGesture(name);
      return original(options);
    };
  }
})();`;

/** Chromium page with the virtual authenticator, the gesture counter and the no-reload probe. */
export async function journeyPage(browser: Browser): Promise<JourneyPage> {
  const { page, context } = await pageWithTouchId(browser);
  const counts = { create: 0, get: 0 };
  await context.exposeBinding('__journeyGesture', (_source, name: unknown) => {
    if (name === 'create') counts.create += 1;
    else if (name === 'get') counts.get += 1;
  });
  await context.addInitScript(COUNTER_SCRIPT);
  const gestures: Gestures = {
    get create() {
      return counts.create;
    },
    get get() {
      return counts.get;
    },
    total: () => counts.create + counts.get,
  };
  const arm = async (): Promise<NoReload> => {
    const marker = encodeHex(randomBytes(12));
    await page.evaluate((m) => {
      (globalThis as { __journey?: string }).__journey = m;
    }, marker);
    let documents = 0;
    page.on('load', () => {
      documents += 1;
    });
    return {
      get documents() {
        return documents;
      },
      check: async () => {
        const seen = await page.evaluate(() => (globalThis as { __journey?: string }).__journey);
        expect(seen, 'the page was reloaded or left').toBe(marker);
        expect(documents, 'a new document loaded').toBe(0);
      },
    };
  };
  return { page, context, gestures, arm };
}

/**
 * W4-SHELL-V2: until Home (U3) and People (U4) hold them, today's Messages and Contacts pages are
 * reached from Go to (Cmd+K) by these names; they are no sections of the menu.
 */
const INTERIM: Readonly<Record<string, string>> = {
  Inbox: 'Messages',
  Messages: 'Messages',
  Contacts: 'People',
  // Files is no section of the menu; the Files page (Received, Sent, Send folders) is Settings, Files folder.
  Files: 'Files folder',
};

/** Go to (Cmd+K): type a name and press Enter (an in-app move, never `goto`). */
export async function goTo(page: Page, name: string): Promise<void> {
  await page
    .getByRole('button', { name: /^Go to/ })
    .first()
    .click();
  const field = page.getByRole('combobox');
  await field.fill(name);
  await page
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .first()
    .click();
}

/**
 * In-app navigation: a click on the section menu item (never `goto`, which would load a new
 * document). W4-SHELL-V2: "Inbox" and "Contacts" go through Go to (INTERIM).
 */
export async function navTo(page: Page, label: string): Promise<void> {
  const interim = INTERIM[label];
  if (interim !== undefined) {
    await goTo(page, interim);
    return;
  }
  // The item's name may carry a count after the label ("Home, 2 waiting for you").
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|\\s|$)`);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name })
    .first()
    .click();
}

/** Polls `check` until it is true. */
export async function eventually(what: string, check: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The body text of the page. */
export const text = (page: Page): Promise<string> => page.locator('body').innerText();

/** Shared browser and closers for one chapter file. */
export interface Chapter {
  need(ctx: { skip: () => void }): { browser: Browser; files: Map<string, Uint8Array> } | undefined;
  readonly closers: (() => Promise<unknown>)[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The built app and Chromium, or a skip locally; in CI a missing build or browser fails the run. */
export function chapter(): Chapter {
  let browser: Browser | undefined;
  let launchError: unknown;
  const closers: (() => Promise<unknown>)[] = [];
  return {
    closers,
    start: async () => {
      const launched = await launchBrowser();
      browser = launched.browser;
      launchError = launched.error;
    },
    stop: async () => {
      for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
      await browser?.close();
    },
    need: (ctx) => {
      const files = builtAppFiles();
      if (browser === undefined && process.env['CI'] !== undefined) throw launchError;
      if (files === undefined && process.env['CI'] !== undefined)
        throw new Error('pnpm build first');
      if (browser === undefined || files === undefined) {
        ctx.skip();
        return undefined;
      }
      return { browser, files };
    },
  };
}

/**
 * `agentlink ui` on a computer: the run, and a stop for the closers. The first link the app hands the
 * OS opener is returned (the one-shot session link).
 */
export async function startUi(
  pc: Computer,
  files: Map<string, Uint8Array>,
  closers: (() => Promise<unknown>)[],
): Promise<string> {
  return (await startUiRun(pc, files, closers)).link;
}

/** As `startUi`, with a stop (the person quits the app; `agentlink ui` exits). */
export async function startUiRun(
  pc: Computer,
  files: Map<string, Uint8Array>,
  closers: (() => Promise<unknown>)[],
): Promise<{ link: string; stop: () => Promise<void> }> {
  const before = pc.opened.length;
  const run = runUi(pc, files);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    run.deps.stop();
    await run.done;
  };
  closers.push(stop);
  return { link: await openedLink(pc, before), stop };
}

/**
 * First run, the seed of the chapters that need an owner with a real passkey on this computer.
 * W4-WIZARD: Get started (helpers-wizard.ts): the first app tile, the name, Touch ID (one `create`),
 * the backup code; no AI app is on these computers, so step 3 says "{label} is ready" and "Go to
 * Home" ends on the app's Home.
 */
export async function firstRunWithTouchId(
  jp: JourneyPage,
  link: string,
  label: string,
): Promise<void> {
  const { page } = jp;
  await page.goto(link);
  await getStartedWithTouchId(page, label);
  await page.getByRole('button', { name: 'Go to Home' }).click();
  // W4-SHELL-V2: first run ends on Home (`/`; the old `/settings/home` redirects there).
  await page.waitForURL((url) => url.pathname === '/');
}

export const ANY_INVITE = new RegExp(`${SHORT_INVITE.source}|${LONG_INVITE.source}`);

/** The start state of chapters 2–4: two computers, each with an owner, an agent and its AI app. */
export interface TwoOwners {
  readonly pcA: JourneyComputer;
  readonly pcB: JourneyComputer;
  readonly a: JourneyPage;
  readonly b: JourneyPage;
  readonly mcpA: AiAppMcp;
  readonly mcpB: AiAppMcp;
  /** Quits the app on A (`agentlink ui` exits). */
  readonly quitA: () => Promise<void>;
}

/**
 * Two computers on one relay and one drop. Each runs `agentlink ui`, does today's first run with a
 * real passkey (agent "Ana" on A, "Bo" on B), and starts its AI app's MCP server (what a connected AI
 * app does all day: it runs the agent's sync).
 */
export async function twoOwners(
  browser: Browser,
  files: Map<string, Uint8Array>,
  world: JourneyWorld,
  closers: (() => Promise<unknown>)[],
): Promise<TwoOwners> {
  const pcA = await world.computer();
  const pcB = await world.computer();
  const a = await journeyPage(browser);
  const b = await journeyPage(browser);
  const uiA = await startUiRun(pcA, files, closers);
  await firstRunWithTouchId(a, uiA.link, 'Ana');
  await firstRunWithTouchId(b, await startUi(pcB, files, closers), 'Bo');
  const mcpA = await startAiAppMcp(pcA, undefined);
  closers.push(() => mcpA.close());
  const mcpB = await startAiAppMcp(pcB, undefined);
  closers.push(() => mcpB.close());
  return { pcA, pcB, a, b, mcpA, mcpB, quitA: uiA.stop };
}

/**
 * W4-WIRE: Go to → Invite someone → the Invite screen (U4): the link is made at once; Copy (✓
 * Copied) → Done. Answers the link the screen showed (it shows it without https://).
 */
export async function createInviteInApp(jp: JourneyPage): Promise<string> {
  const { page } = jp;
  await goTo(page, 'Invite someone');
  await page.getByRole('heading', { name: 'Invite someone', level: 1 }).waitFor();
  const shown = page.locator('.inv-link[data-state="ready"]');
  await shown.waitFor();
  const value = (await shown.innerText()).trim();
  const link = ANY_INVITE.exec(value.startsWith('https://') ? value : `https://${value}`)?.[0] ?? '';
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return link;
}

/** Contacts → Add contact → I have an invite → paste → Check invite (stops on "Is this…?"). */
export async function checkInviteInApp(jp: JourneyPage, link: string): Promise<void> {
  const { page } = jp;
  await navTo(page, 'Contacts');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await page.getByRole('tab', { name: 'I have an invite' }).click();
  await page.getByLabel('Paste the invite link').fill(link);
  await page.getByRole('button', { name: 'Check invite' }).click();
}

/** Check invite, then Connect with one Touch ID. */
export async function acceptInviteInApp(
  jp: JourneyPage,
  link: string,
  inviter: string,
): Promise<void> {
  const { page } = jp;
  await checkInviteInApp(jp, link);
  await page.getByText('Is this who you expected?').waitFor();
  expect(await text(page)).toContain(inviter);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
}

/** True once the agent behind `mcp` lists `name` as a completed pairing. */
export async function pairedWith(mcp: AiAppMcp, name: string): Promise<true | undefined> {
  const listed = await mcp.call('agentlink_list_contacts');
  const contacts = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
  return contacts.some((c) => c['name'] === name && c['pairing'] === 'complete') ? true : undefined;
}

/** Start state of chapters 3–4: Ana and Bo paired through the app (passes today). */
export async function pairedOwners(
  browser: Browser,
  files: Map<string, Uint8Array>,
  world: JourneyWorld,
  closers: (() => Promise<unknown>)[],
): Promise<TwoOwners> {
  const two = await twoOwners(browser, files, world, closers);
  const link = await createInviteInApp(two.a);
  await acceptInviteInApp(two.b, link, 'Ana');
  await until('Bo is paired with Ana', () => pairedWith(two.mcpB, 'Ana'), 30_000);
  await until('Ana is paired with Bo', () => pairedWith(two.mcpA, 'Bo'), 30_000);
  return two;
}

/** Polls the agent's inbox (through its AI app) until it holds `needle`. */
export async function inboxHas(mcp: AiAppMcp, needle: string): Promise<true | undefined> {
  return JSON.stringify((await mcp.call('agentlink_inbox')).structured).includes(needle)
    ? true
    : undefined;
}
