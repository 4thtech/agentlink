// M1-PAY-CONFIRM-b in a real browser: the confirmation sheet for a proof above the owner's limits
// (b11 §19; 04 §2.5.3; D-132), in Chromium with a CDP virtual authenticator (PRF, user
// verification). M1-11b-2c: the server-rendered page is gone, so this runs the built local app
// (apps/local-ui, the CLI's bundle), with the passkey registered on its first-run page.
//
// - A paid request is never offered for the list's single confirmation: its card has its own
//   Approve, which opens the sheet (rule 7).
// - The sheet is a modal dialog; focus starts on its title, never on Confirm; the main button names
//   the platform's check; one live region says Waiting, then Done; the trust lines are shown.
// - After Done it closes itself (about 1.2 s); with reduced motion it waits for Close.
//
// - M1-11b-2: the deep link, the backup code with a wrong try first, axe-core clean.
//
// CI installs Chromium and builds the app (ci.yml), so there the test always runs. Locally, without
// the Playwright browsers or the build (`pnpm build`), it is skipped; set AGENTLINK_TEST_CHROMIUM to
// run it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerSource,
} from './approval-server.js';
import { needBuiltApp, switchToPasskey } from './local-ui-app.fixture.js';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { OWNER_PASSKEY_ACCOUNT, OWNER_PASSKEY_KEY_ACCOUNT } from './owner-passkey.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const root = mkdtempSync(join(tmpdir(), 'agentlink-pay-confirm-browser-'));
const keychainFile = join(root, 'keychain-stand-in.json');

class FileKeychain implements KeychainBackend {
  #read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(keychainFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(account: string): Promise<Uint8Array | null> {
    const value = this.#read()[account];
    return Promise.resolve(value === undefined ? null : decodeBase64url(value));
  }
  set(account: string, value: Uint8Array): Promise<void> {
    writeFileSync(
      keychainFile,
      JSON.stringify({ ...this.#read(), [account]: encodeBase64url(value) }),
    );
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    const items = this.#read();
    const had = account in items;
    Reflect.deleteProperty(items, account);
    writeFileSync(keychainFile, JSON.stringify(items));
    return Promise.resolve(had);
  }
}

const keychain = new FileKeychain();
let agentId = '';
let owner: OwnerPublicKeys;
let code = '';
let browser: Browser | undefined;
let launchError: unknown;

beforeAll(async () => {
  agentId = await createKeychainAgent(keychain);
  const written: string[] = [];
  const setup: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () =>
      Promise.resolve(
        encodeUtf8((written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(-4)),
      ),
    confirm: () => Promise.resolve(true),
    clearScreen: () => undefined,
  };
  ({ owner } = await initOwnerWith(
    keychain,
    setup,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  ));
  code = (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
    'Your owner code: '.length,
  );
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await keychain.delete(OWNER_PASSKEY_ACCOUNT);
  await keychain.delete(OWNER_PASSKEY_KEY_ACCOUNT);
});

const id = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;
const digest = (action: unknown): string =>
  encodeHex(sha256(canonicalizeToBytes(action as JsonObject)));

function ownerSigValid(body: JsonObject, sig: string): boolean {
  try {
    const d = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, d, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

function fakeSource(): ApprovalServerSource & {
  readonly applied: { body: JsonObject; sig: string }[];
  addPaid(n: number): void;
  addFree(n: number): void;
} {
  const rows = new Map<string, ApprovalForDecision>();
  const applied: { body: JsonObject; sig: string }[] = [];
  const put = (n: number, action: JsonObject, summary: string, paid: boolean): void => {
    rows.set(id(n), {
      approvalId: id(n),
      summary,
      actionDigest: digest(action),
      storedDigest: digest(action),
      action,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600 + n,
      commitment: false,
      paid,
      details: {
        headline: summary,
        who: '“Ana” (self-declared)',
        what: summary,
        cost: paid ? '$0.10' : 'Free',
        expires: '12 Oct 2026 14:02 UTC',
        rule: paid ? 'Above your per-proof limit' : 'Your rules ask you first.',
        fromAi: [],
      },
    });
  };
  return {
    applied,
    addPaid(n) {
      put(
        n,
        {
          tool: 'agentlink_notarize',
          args: { envelopeId: 'E'.repeat(22) },
          context: {
            triggers: ['proofs.perActionMaxUSD'],
            counterparty: { agentId: `0x${'12'.repeat(20)}`, ownerKey: 'cd'.repeat(32) },
            envelopeHash: `0x${'ef'.repeat(32)}`,
            fee: { token: `0x${'ab'.repeat(20)}`, amount: '100000', usd: '0.1' },
          },
        },
        'Record a proof',
        true,
      );
    },
    addFree(n) {
      put(n, { tool: 'agentlink_send', to: `contact-${String(n)}`, text: 'hi' }, 'Send', false);
    },
    context: () => Promise.resolve({ agent: agentId, owner }),
    list: () =>
      Promise.resolve(
        [...rows.values()].map((row) => {
          // The list never carries the action (as the CLI's source).
          const view: Record<string, unknown> = { ...row };
          delete view['action'];
          delete view['storedDigest'];
          return view as never;
        }),
      ),
    get: (approvalId) => Promise.resolve(rows.get(approvalId)),
    apply: (signed) => {
      const params = signed.body['params'] as Record<string, unknown> | undefined;
      const row = rows.get(String(params?.['approvalId']));
      if (!ownerSigValid(signed.body, signed.sig) || row === undefined) {
        return Promise.resolve({ status: 'refused' } as never as OwnerActionOutcome);
      }
      rows.delete(row.approvalId);
      applied.push(signed);
      return Promise.resolve({ status: 'applied', op: 'approval.decide' } as OwnerActionOutcome);
    },
  };
}

const AXE_SOURCE = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

/**
 * axe-core over the page's main content (the approvals and the sheet). The app's status bar is the
 * design system shell's and has its own checks; its "Needs setup" state is reported separately.
 */
async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(`(async () => {
    const result = await window.axe.run(document.querySelector('main') || document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(', '));
  })()`);
}

async function start(files: Map<string, Uint8Array>): Promise<{
  server: ApprovalServer;
  source: ReturnType<typeof fakeSource>;
  sessionUrl: string;
}> {
  const source = fakeSource();
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    { source, localUi: { assets: { files } } },
    {
      keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  await server.open();
  return { server, source, sessionUrl: opened[0] ?? '' };
}

async function pageWithAuthenticator(): Promise<Page> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

function needBrowser(skip: () => void): void {
  if (browser !== undefined) return;
  if (process.env['CI'] !== undefined) throw launchError;
  skip();
}

/** The words the tests look for (apps/local-ui approvals strings, @4thtech-io/ui PAY_CONFIRM_STRINGS). */
const T = Object.freeze({
  paidAlone: 'This costs credits. Approve it on its own.',
  payTitleProof: 'Record proof',
  payTrustCredits: 'Your credits stay yours; 4thTech never holds them.',
  payTrustAi: "Your AI can't confirm this for you.",
  payDoneProof: 'Done. Your AI records the proof now.',
  payClose: 'Close',
  payUseBackup: 'Use backup code instead',
  payConfirmCode: 'Confirm',
  payWrongCode: "That backup code didn't match. Nothing was paid.",
});

/** A server with the built app; the owner registers the passkey on its first-run page. */
async function registered(ctx: { skip: () => void }): Promise<{
  server: ApprovalServer;
  source: ReturnType<typeof fakeSource>;
  page: Page;
}> {
  needBrowser(() => ctx.skip());
  const files = needBuiltApp(() => ctx.skip());
  const { server, source, sessionUrl } = await start(files);
  const page = await pageWithAuthenticator();
  await page.goto(sessionUrl);
  await switchToPasskey(page, server.origin, code);
  return { server, source, page };
}

const CONFIRM = /^Confirm with (Touch ID|Windows Hello|your passkey)$/;

describe('the confirmation sheet in the app (M1-PAY-CONFIRM-b, M1-11b-2; Chromium)', () => {
  it('a paid request is its own card; Approve opens the sheet; the passkey confirms it; the sheet closes itself', async (ctx) => {
    const { server, source, page } = await registered(ctx);
    source.addFree(1);
    source.addPaid(2);
    await page.goto(server.origin + '/');
    await page
      .locator('nav[aria-label="Main"] a[aria-current="page"]', { hasText: 'Approvals' })
      .waitFor();
    // Rule 7: the paid request has no list choice; the free one does.
    await page
      .locator(`input[name="choice-${id(1)}"]`)
      .first()
      .waitFor();
    expect(await page.locator(`input[name="choice-${id(2)}"]`).count()).toBe(0);
    const paidCard = page.locator(`[data-approval="${id(2)}"]`);
    await paidCard.getByText(T.paidAlone).waitFor();
    expect(await axeViolations(page)).toEqual([]);

    await paidCard.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    await dialog.getByText('$0.10', { exact: true }).waitFor();
    // Focus starts on the title, never on Confirm (b11 §19.2, §19.5).
    expect(
      await page.evaluate('document.activeElement && document.activeElement.textContent'),
    ).toBe(T.payTitleProof);
    await dialog.getByText(T.payTrustCredits).waitFor();
    await dialog.getByText(T.payTrustAi).waitFor();
    // The sheet slides in (b11 §14): check it once it has settled.
    await page.waitForTimeout(600);
    expect(await axeViolations(page)).toEqual([]);
    const confirm = dialog.getByRole('button', { name: CONFIRM });
    expect(await confirm.count()).toBe(1);
    await confirm.click();
    await dialog.locator('[aria-live="polite"]', { hasText: T.payDoneProof }).waitFor();
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
    await paidCard.getByText('Approved.').waitFor();
    expect(source.applied).toHaveLength(1);
    const signed = source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(signed.body, signed.sig)).toBe(true);
    expect((signed.body['params'] as Record<string, unknown>)['approvalId']).toBe(id(2));
    await page.context().close();
  }, 120_000);

  it('with reduced motion, Done waits for Close; Escape cancelled the first try and paid nothing', async (ctx) => {
    const { server, source, page } = await registered(ctx);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    source.addPaid(3);
    await page.goto(server.approvalUrl(id(3)));
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(source.applied).toHaveLength(0);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await dialog.waitFor();
    expect(await dialog.getAttribute('data-motion')).toBe('reduced');
    await dialog.getByRole('button', { name: CONFIRM }).click();
    await dialog.locator('[aria-live="polite"]', { hasText: T.payDoneProof }).waitFor();
    await page.waitForTimeout(2_000);
    expect(await dialog.count()).toBe(1);
    await dialog.getByRole('button', { name: T.payClose }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(source.applied).toHaveLength(1);
    await page.context().close();
  }, 120_000);

  it('the deep link renders in the app; the backup code confirms a paid request', async (ctx) => {
    const { server, source, page } = await registered(ctx);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    source.addPaid(3);
    await page.goto(server.approvalUrl(id(3)));
    await page
      .locator('nav[aria-label="Main"] a[aria-current="page"]', { hasText: 'Approvals' })
      .waitFor();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: T.payUseBackup }).click();
    await dialog.locator('input[type=password]').fill('WRNG WRNG WRNG');
    await dialog.getByRole('button', { name: T.payConfirmCode, exact: true }).click();
    await dialog.getByText(T.payWrongCode).waitFor();
    expect(source.applied).toHaveLength(0);
    await dialog.locator('input[type=password]').fill(code);
    await dialog.getByRole('button', { name: T.payConfirmCode, exact: true }).click();
    await dialog.locator('[aria-live="polite"]', { hasText: T.payDoneProof }).waitFor();
    await dialog.getByRole('button', { name: T.payClose }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(source.applied).toHaveLength(1);
    expect(await page.content()).not.toContain(code);
    await page.context().close();
  }, 120_000);
});
