// M1-11a acceptance in a real browser: the local approval UI on `http://localhost:<port>` (08 §1;
// 11 §6.2.1; 02 J4; 04 §2.5, §2.5.2; D-68), in Chromium with a CDP virtual authenticator (WebAuthn
// PRF, user verification, resident keys; no hardware). It runs the page script itself
// (approval-page.ts) against the real server, the real owner store and real owner signatures.
//
// Covered: J4 end to end with the first-run passkey; review together signs exactly the selected
// items with one passkey gesture; a commitment cannot be selected and "Remember for this contact" is
// absent from the batch view; injected HTML and script in request text render inert; a PRF-less
// authenticator, or a browser with no passkeys at all, falls back to the owner code; the session link
// is single-use; wrong owner codes back off.
//
// CI installs Chromium for Playwright (ci.yml), so there the test always runs and a browser that
// cannot start fails it. Locally, without the Playwright browsers, it is skipped; set
// AGENTLINK_TEST_CHROMIUM to a Chromium or chrome-headless-shell executable to run it.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FREE_PRESENCE_ATTEMPTS,
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from './approval-server.js';
import {
  approvalId as id,
  fakeSource,
  ownerSigValid,
  ownerWorld,
  type FakeSource,
  type OwnerWorld,
} from './approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { OWNER_PASSKEY_ACCOUNT } from './owner-passkey.js';

let world: OwnerWorld;
let browser: Browser | undefined;
let launchError: unknown;

beforeAll(async () => {
  world = await ownerWorld('agentlink-m1-11a-browser-');
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
  world.cleanup();
});

const servers: ApprovalServer[] = [];
const contexts: BrowserContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await world.keychain.delete(OWNER_PASSKEY_ACCOUNT);
});

/** Skips locally when no browser could start; in CI that is a failure. */
function needBrowser(skip: () => void): void {
  if (browser !== undefined) return;
  if (process.env['CI'] !== undefined) throw launchError;
  skip();
}

async function start(source: ApprovalServerSource = fakeSource(world)): Promise<{
  server: ApprovalServer;
  source: FakeSource;
  link: () => Promise<string>;
}> {
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    { source },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  return {
    server,
    source: source as FakeSource,
    link: async () => {
      await server.open();
      return opened[opened.length - 1] ?? '';
    },
  };
}

interface AuthPage {
  readonly page: Page;
  /** The virtual authenticator's credentials with their sign counts (one per gesture). */
  readonly signCounts: () => Promise<number[]>;
}

/** A page with a CDP virtual authenticator (internal, resident keys, UV, PRF as asked). */
async function pageWithAuthenticator(hasPrf: boolean): Promise<AuthPage> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  return {
    page,
    signCounts: async () => {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials.map((c) => c.signCount);
    },
  };
}

/** A page in a browser without WebAuthn (no PublicKeyCredential). */
async function pageWithoutPasskeys(): Promise<Page> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'PublicKeyCredential');
  });
  return page;
}

/** First run: the owner sets up the localhost passkey with the owner code once. */
async function setUpPasskey(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Set up a passkey' }).click();
  await page.locator('input[type=password]').fill(world.code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Passkey set up.').waitFor();
}

const card = (page: Page, n: number) => page.locator(`section[data-approval="${id(n)}"]`);
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

describe('the local approval UI (M1-11a; Chromium, virtual PRF authenticator)', () => {
  it('J4: first-run passkey, then the owner reviews the card and approves with the passkey', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, link } = await start();
    const { page } = await pageWithAuthenticator(true);
    await page.goto(await link());
    // First run (11 §6.2.1): what approvals need, and the weaker-setup note.
    await page.getByText('Never give them to your AI.').waitFor();
    await page.getByText('The desktop app protects approvals more strongly.').waitFor();
    await setUpPasskey(page);

    // The agent asks for something outside its rules (J4 step 1-2).
    source.add(1, {
      summary: 'Record a proof · Denis · $0.10',
      details: {
        who: 'Denis',
        what: 'Record a proof',
        cost: '$0.10',
        expires: '12 Oct 2026 14:02 UTC',
        rule: 'Your rules ask you to approve every proof.',
        fromAi: [{ name: 'path', value: 'report.pdf' }],
      },
    });
    await page.goto(server.approvalUrl(id(1)));
    // J4 step 3: who, what, cost and the rule in plain words.
    const box = card(page, 1);
    for (const text of [
      'Denis',
      'Record a proof',
      '$0.10',
      'Your rules ask you to approve every proof.',
      'report.pdf',
      "Your AI can't approve this for you.",
    ]) {
      await box.getByText(text, { exact: false }).first().waitFor();
    }
    // Clicking Approve alone decides nothing: presence comes after the click.
    await box.getByRole('button', { name: 'Approve', exact: true }).click();
    expect(source.applied).toEqual([]);
    await box.getByRole('button', { name: 'Approve with your passkey' }).click();
    await page.getByText('Approved.').waitFor();
    expect(source.applied).toHaveLength(1);
    const signed = source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(world.owner, signed.body, signed.sig)).toBe(true);
    expect(signed.body['op']).toBe('approval.decide');
    expect((signed.body['params'] as Record<string, unknown>)['approvalId']).toBe(id(1));
    // J4 step 4: the request is no longer pending.
    expect(source.pending(1)).toBe(false);
  }, 120_000);

  it('review together: one passkey gesture signs exactly the selected items; terms stay apart', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { source, link } = await start();
    const { page, signCounts } = await pageWithAuthenticator(true);
    await page.goto(await link());
    await setUpPasskey(page);
    for (const n of [1, 2, 3, 4]) source.add(n);
    source.add(5, { commitment: true, summary: 'Answer their terms · Ana · Free' });
    await page.reload();
    await page.getByText('Waiting for you (5)').waitFor();

    // The commitment is listed but cannot be selected (D-31, 04 §2.5.2).
    const terms = card(page, 5);
    await terms.getByText('Terms are approved one at a time.').waitFor();
    expect(await terms.locator('input[type=radio]').count()).toBe(0);
    // "Remember for this contact" is never part of the batch view (06 §3, 11 §6.2.1).
    expect(await page.getByText('Remember for this contact').count()).toBe(0);

    await card(page, 1).getByLabel('Approve', { exact: true }).check();
    await card(page, 3).getByLabel('Approve', { exact: true }).check();
    await card(page, 4).getByLabel('Deny', { exact: true }).check();
    // 2 is left at Later.
    expect(await card(page, 2).getByLabel('Later', { exact: true }).isChecked()).toBe(true);
    const before = await signCounts();
    await page.getByRole('button', { name: 'Approve 2 and deny 1' }).click();
    await page.getByText('This covers exactly these 3. Anything new waits for your next review.').waitFor();
    expect(source.applied).toEqual([]);
    await page.getByRole('button', { name: 'Confirm with your passkey' }).click();
    await page.getByText('Done: approved 2 and denied 1.').waitFor();

    // One gesture (sign count + 1), one signed object, exactly the selected items.
    const after = await signCounts();
    expect((after[0] ?? 0) - (before[0] ?? 0)).toBe(1);
    expect(source.applied).toHaveLength(1);
    const signed = source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(world.owner, signed.body, signed.sig)).toBe(true);
    expect(signed.body['op']).toBe('approval.decideBatch');
    const items = (signed.body['params'] as { items: { approvalId: string; decision: string }[] })
      .items;
    expect(items.map((i) => [i.approvalId, i.decision])).toEqual([
      [id(1), 'approve'],
      [id(3), 'approve'],
      [id(4), 'deny'],
    ]);
    expect(source.pending(2)).toBe(true);
    expect(source.pending(5)).toBe(true);
  }, 120_000);

  it('leaves out an item decided elsewhere during the review, and says so', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { source, link } = await start();
    const page = await pageWithoutPasskeys();
    for (const n of [1, 2, 3]) source.add(n);
    await page.goto(await link());
    await page.getByText('Waiting for you (3)').waitFor();
    for (const n of [1, 2, 3]) await card(page, n).getByLabel('Approve', { exact: true }).check();
    source.remove(2);
    await page.getByRole('button', { name: 'Approve 3' }).click();
    await page.getByText('1 request is no longer waiting and was left out.').waitFor();
    await page.getByText('This covers exactly these 2.', { exact: false }).waitFor();
    await page.getByLabel('Owner code or owner passphrase').fill(world.code);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByText('Done: approved 2.').waitFor();
    const items = (source.applied[0]?.body['params'] as { items: { approvalId: string }[] }).items;
    expect(items.map((i) => i.approvalId)).toEqual([id(1), id(3)]);
  }, 120_000);

  it('renders injected HTML and script in contact names, file names and summaries inert', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, link } = await start();
    const { page } = await pageWithAuthenticator(true);
    source.add(1, {
      summary: `Send a message · ${XSS} · Free`,
      details: {
        who: `Denis ${XSS}`,
        what: 'Send a message',
        cost: 'Free',
        expires: '12 Oct 2026 14:02 UTC',
        rule: 'This is outside your rules.',
        fromAi: [
          { name: `path${XSS}`, value: `/tmp/${XSS}.pdf` },
          { name: 'text', value: '</section><button>Approve 9</button>' },
        ],
      },
    });
    await page.goto(await link());
    await page.getByText('Waiting for you (1)').waitFor();
    await page.goto(server.approvalUrl(id(1)));
    await card(page, 1).getByText(`Denis ${XSS}`).waitFor();
    for (const view of ['/', `/approve/${id(1)}`]) {
      await page.goto(`${server.origin}${view}`);
      await card(page, 1).getByText(`/tmp/${XSS}.pdf`).waitFor();
      expect(await page.evaluate(() => (window as { __xss?: unknown }).__xss)).toBeUndefined();
      expect(await page.locator('#app img').count()).toBe(0);
      expect(await page.locator('#app script').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Approve 9' }).count()).toBe(0);
    }
  }, 120_000);

  it('a PRF-less authenticator falls back to the owner code or owner passphrase', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { source, link } = await start();
    const { page } = await pageWithAuthenticator(false);
    await page.goto(await link());
    await page.getByRole('button', { name: 'Set up a passkey' }).click();
    await page.locator('input[type=password]').fill(world.code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText("This passkey can't protect approvals here.").waitFor();
    expect(await world.keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();

    source.add(1);
    source.add(2);
    await page.reload();
    await card(page, 1).getByLabel('Approve', { exact: true }).check();
    await card(page, 2).getByLabel('Deny', { exact: true }).check();
    await page.getByRole('button', { name: 'Approve 1 and deny 1' }).click();
    expect(await page.getByRole('button', { name: 'Confirm with your passkey' }).count()).toBe(0);
    await page.getByLabel('Owner code or owner passphrase').fill(world.code);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByText('Done: approved 1 and denied 1.').waitFor();
    expect(source.applied).toHaveLength(1);
  }, 120_000);

  it('a browser without passkeys says so and uses the owner code', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, link } = await start();
    const page = await pageWithoutPasskeys();
    await page.goto(await link());
    await page.getByText("Passkeys aren't available in this browser.", { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Set up a passkey' }).count()).toBe(0);
    source.add(1);
    await page.goto(server.approvalUrl(id(1)));
    await card(page, 1).getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByLabel('Owner code or owner passphrase').fill(world.code);
    await page.getByRole('button', { name: 'Confirm denial' }).click();
    await page.getByText('Denied.').waitFor();
    expect((source.applied[0]?.body['params'] as Record<string, unknown>)['decision']).toBe('deny');
  }, 120_000);

  it('the session link opens the page once; a second browser gets the expired page', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { link } = await start();
    const url = await link();
    const first = await pageWithoutPasskeys();
    await first.goto(url);
    await first.getByText('Nothing is waiting for you.').waitFor();
    expect(new URL(first.url()).search).toBe('');
    const second = await pageWithoutPasskeys();
    const res = await second.goto(url);
    expect(res?.status()).toBe(401);
    await second.getByText('This link has expired.', { exact: false }).waitFor();
  }, 60_000);

  it('after repeated wrong owner codes the page asks the owner to wait', async (ctx) => {
    needBrowser(() => ctx.skip());
    const { server, source, link } = await start();
    const page = await pageWithoutPasskeys();
    source.add(1);
    await page.goto(await link());
    await page.goto(server.approvalUrl(id(1)));
    const box = card(page, 1);
    for (let i = 0; i <= FREE_PRESENCE_ATTEMPTS; i += 1) {
      await box.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByLabel('Owner code or owner passphrase').fill('AAAA BBBB CCCC DDDD EEEE FFFF');
      await page.getByRole('button', { name: 'Confirm approval' }).click();
      await box
        .getByText(i < FREE_PRESENCE_ATTEMPTS ? "That didn't match" : 'Too many wrong tries.', {
          exact: false,
        })
        .last()
        .waitFor();
    }
    expect(source.applied).toEqual([]);
  }, 120_000);

  it('before the owner is set up, owner operations are blocked with the reason', async (ctx) => {
    needBrowser(() => ctx.skip());
    const source = fakeSource(world);
    source.context = () => Promise.resolve(undefined);
    source.add(1);
    const { link } = await start(source);
    const { page } = await pageWithAuthenticator(true);
    await page.goto(await link());
    await page.getByText('Set up your owner key first', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Set up a passkey' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: /^Approve/ }).count()).toBe(0);
  }, 60_000);
});
