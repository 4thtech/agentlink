// @vitest-environment jsdom
// HOTFIX-045-PASTE-FIELD in a real browser: in Add contact (Paste tab) the label, the paste box and the
// hint sit one under the other and never overlap, even with a long pasted invite. Renders the real
// sheet to markup, loads the app's real stylesheets and measures bounding boxes in Chromium at
// 1440 and 360 px, light and dark. Needs the Playwright Chromium; without it the test is skipped
// locally (in CI a missing browser fails it). AGENTLINK_TEST_CHROMIUM names another executable.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddContactSheet } from './add-contact.js';
import type { InviteApi } from './invite-api.js';

const dir = dirname(fileURLToPath(import.meta.url));
const ui = (file: string): string =>
  readFileSync(resolve(dir, '../../../../../packages/ui/src', file), 'utf8');
const here = (file: string): string => readFileSync(resolve(dir, file), 'utf8');

const LONG = `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once: https://agentlink.4thtech.io/i#${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-'.repeat(6)}`;

let browser: Browser | undefined;
let launchError: unknown;

beforeAll(async () => {
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The sheet portals into document.body, so it is rendered in jsdom and its markup handed to Chromium.
async function pageHtml(): Promise<string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(AddContactSheet, {
        invites: {} as unknown as InviteApi,
        passkey: undefined,
        onCreated: () => undefined,
        onConnected: () => undefined,
        onClose: () => undefined,
      }),
    );
  });
  const markup = document.body.innerHTML;
  act(() => root.unmount());
  host.remove();
  const css = [
    'tokens/tokens.css',
    'components/components.css',
    'components/depth.css',
    'components/progress.css',
    'components/motion.css',
    'components/chrome.css',
  ]
    .map((f) => ui(f))
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${here('./contacts.css')}</style></head><body>${markup}</body></html>`;
}

const cases = [
  { width: 1440, scheme: 'light' },
  { width: 1440, scheme: 'dark' },
  { width: 360, scheme: 'light' },
  { width: 360, scheme: 'dark' },
] as const;

describe('Add contact paste field layout (HOTFIX-045-PASTE-FIELD)', () => {
  for (const c of cases) {
    it(`label, box and hint do not overlap at ${c.width}px, ${c.scheme}`, async (ctx) => {
      if (browser === undefined) {
        if (process.env['CI'] !== undefined) throw launchError;
        ctx.skip();
        return;
      }
      const page = await browser.newPage({
        viewport: { width: c.width, height: 900 },
        colorScheme: c.scheme,
      });
      try {
        await page.setContent(await pageHtml());
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('[hidden]')) el.removeAttribute('hidden');
        });
        const field = page.locator('textarea[name="invite-link"]');
        await field.fill(LONG);
        const box = async (sel: string) => {
          const b = await page.locator(sel).boundingBox();
          if (b === null) throw new Error(`no box for ${sel}`);
          return b;
        };
        const label = await box(`label[for="${await field.getAttribute('id')}"]`);
        const area = await box('textarea[name="invite-link"]');
        const hint = await box(`[id="${await field.getAttribute('aria-describedby')}"]`);
        expect(area.y).toBeGreaterThanOrEqual(label.y + label.height - 0.5);
        expect(hint.y).toBeGreaterThanOrEqual(area.y + area.height - 0.5);
        // The box is tall enough for several lines of the pasted text, not one clipped line.
        expect(area.height).toBeGreaterThanOrEqual(60);
      } finally {
        await page.close();
      }
    });
  }
});
