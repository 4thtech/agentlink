#!/usr/bin/env node
// Signing hook, OFF by default (early builds are unsigned by owner decision).
//   node sign.mjs --app <AgentLink.app> [--dry-run]
// Today: ad-hoc codesign of OUR bundle, the Electron frameworks and helpers only. The bundled
// Resources/node keeps its upstream Node.js Foundation signature (re-signing it would change its code
// identity and make every existing keychain item prompt). With DESKTOP_SIGNING=on and CODESIGN_IDENTITY
// set it uses Developer ID + hardened runtime + assets/entitlements.mac.plist (notarization: WP-D18).
import { join, resolve } from 'node:path';
import { DESKTOP_DIR } from './lib/stage.mjs';
import { planFor, signApp, verifyApp } from './lib/mac-sign.mjs';
import { parseArgs } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v', 'dry-run': 'flag' });
if (!args.app) throw new Error('--app <AgentLink.app> is required.');
const app = resolve(args.app);
const entitlements = join(DESKTOP_DIR, 'assets', 'entitlements.mac.plist');
if (args['dry-run']) {
  for (const s of planFor(app, process.env, entitlements))
    console.log(`${s.identity === '-' ? 'adhoc' : 'id'}  ${s.target}`);
} else {
  console.log(`Signed ${signApp(app, process.env, entitlements)} targets.`);
  verifyApp(app);
}
