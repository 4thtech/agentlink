#!/usr/bin/env node
// CI-side check (H1): the built app.asar must not contain AGENTLINK_DESKTOP_PREVIEW anywhere.
// It scans every file inside the ASAR, and the raw ASAR bytes (catches the name in the header or in
// an unpacked-file listing).
//
//   node check-preview-string.mjs --app <AgentLink.app | AgentLink.exe | path/to/app.asar>
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PREVIEW_VAR, findPreviewString } from './lib/preview-check.mjs';
import { parseArgs } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v' });
if (!args.app) throw new Error('--app <app | exe | app.asar> is required.');
const given = resolve(args.app);
const asarPath = given.endsWith('.asar')
  ? given
  : given.endsWith('.app')
    ? join(given, 'Contents', 'Resources', 'app.asar')
    : join(dirname(given), 'resources', 'app.asar');
if (!existsSync(asarPath)) throw new Error(`No app.asar at ${asarPath}`);

const asar = await import('@electron/asar');
const files = [{ path: '(raw app.asar bytes)', content: readFileSync(asarPath) }];
for (const p of asar.listPackage(asarPath, { isPack: false })) {
  const rel = p.replace(/^[\\/]/, '');
  try {
    files.push({ path: rel, content: asar.extractFile(asarPath, rel) });
  } catch {
    /* directories */
  }
}
const hits = findPreviewString(files);
if (hits.length) {
  console.error(`PREVIEW CHECK FAILED: ${PREVIEW_VAR} appears in:\n- ${hits.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `Preview check passed: ${PREVIEW_VAR} is not in ${files.length - 1} files of the ASAR.`,
);
