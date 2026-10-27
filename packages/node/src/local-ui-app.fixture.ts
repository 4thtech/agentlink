// M1-11b-2c test seam: the local app as the approval server serves it. Not part of the build
// (tsconfig.json excludes *.fixture.ts).
//
// Approvals live only in the app (apps/local-ui) since the server-rendered approval page was
// removed, so every test that opens `/` or `/approve/<id>` gives the server a bundle:
// - TEST_APP: a minimal index.html (no script), for the HTTP tests that only need the page and its
//   CSRF meta;
// - builtApp(): the built app (`pnpm build`), as the CLI embeds it, for the Chromium tests;
// - switchToPasskey(): the owner registers the localhost passkey in the app's first-run page with
//   the backup code once and one gesture (M1-UX-FIRSTRUN-V2-c), the one place the app offers it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUtf8 } from '@4thtech-io/crypto';
import type { Page } from 'playwright';
import type { LocalUiAssets } from './local-ui/context.js';

/** A minimal app bundle: the shell's index.html with the empty CSRF meta the server fills in. */
export const TEST_APP: LocalUiAssets = Object.freeze({
  files: new Map<string, Uint8Array>([
    [
      'index.html',
      encodeUtf8(
        '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
          '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
          '<body><div id="root"></div></body></html>',
      ),
    ],
  ]),
});

const DIST = fileURLToPath(new URL('../../../apps/local-ui/dist/', import.meta.url));

/** The built app as the CLI embeds it (index.html and assets/<name>); undefined when not built. */
export function builtApp(): Map<string, Uint8Array> | undefined {
  if (!existsSync(join(DIST, 'index.html'))) return undefined;
  const files = new Map<string, Uint8Array>([
    ['index.html', new Uint8Array(readFileSync(join(DIST, 'index.html')))],
  ]);
  for (const name of readdirSync(join(DIST, 'assets'))) {
    files.set(`assets/${name}`, new Uint8Array(readFileSync(join(DIST, 'assets', name))));
  }
  return files;
}

/** The built app, or a skip locally when it is not built; in CI a missing build fails the test. */
export function needBuiltApp(skip: () => void): Map<string, Uint8Array> {
  const files = builtApp();
  if (files !== undefined) return files;
  if (process.env['CI'] !== undefined) throw new Error('the app is not built (pnpm build)');
  skip();
  throw new Error('unreachable: skipped');
}

/** The first-run page's button for one passkey gesture (platform named). */
export const USE_PASSKEY = /^Use (Touch ID|Windows Hello|a passkey)$/;
/** The "Switch to …" next step the app shows an owner without a passkey. */
export const SWITCH_TO_PASSKEY = /^Switch to (Touch ID|Windows Hello|a passkey)$/;

/**
 * The owner switches to a passkey in the app: the first-run page, the backup code once, one
 * gesture. Resolves when the page says the passkey is on.
 */
export async function switchToPasskey(page: Page, origin: string, code: string): Promise<void> {
  await page.goto(`${origin}/first-run`);
  await page.getByRole('heading', { level: 1, name: SWITCH_TO_PASSKEY }).waitFor();
  await page.getByLabel('Backup code').fill(code);
  await page.getByRole('button', { name: USE_PASSKEY }).click();
  await page.getByRole('heading', { level: 1, name: /is on$/ }).waitFor();
}
