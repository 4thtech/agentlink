#!/usr/bin/env node
// Builds the Windows x64 app dir, a portable zip and the per-user NSIS setup.exe.
// Runs on windows-2022 in CI (needs `tar` and `makensis`), or anywhere with --nsi-only for a dry run
// (the PE edits and fuses are pure Node, so everything except makensis can be checked on a Mac).
//
//   node build-win.mjs --tgz <packed-cli.tgz> [--version 0.5.0] [--out dir] [--nsi-only]
//
// Signing: Authenticode is a hook that is OFF. DESKTOP_SIGNING=on is refused here until WP-D18.
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants } from './lib/constants.mjs';
import { BUILD_FUSES } from './lib/fuses.mjs';
import { asarIntegrity, writeWinIntegrity } from './lib/integrity.mjs';
import { nsisScript } from './lib/nsis.mjs';
import { capture, parseArgs, run } from './lib/run.mjs';
import {
  CACHE_DIR,
  LAYOUT,
  OUT_DIR,
  assertNoPreviewString,
  buildPayload,
  extract,
  fetchRuntimes,
  gitHeadOrNull,
  installCore,
  packAsar,
  sha256Of,
} from './lib/stage.mjs';

const args = parseArgs(process.argv.slice(2), {
  tgz: 'v',
  version: 'v',
  out: 'v',
  'dist-dir': 'v',
  'nsi-only': 'flag',
});
if (!args.tgz) throw new Error('--tgz <packed CLI tarball> is required.');
if (process.env.DESKTOP_SIGNING === 'on')
  throw new Error('Authenticode signing is not wired yet (WP-D18). Unset DESKTOP_SIGNING.');
const version = args.version ?? '0.0.0-dev';
const platform = 'win32-x64';
const out = resolve(args.out ?? OUT_DIR);
const work = join(CACHE_DIR, `work-${platform}`);
const tgz = resolve(args.tgz);

const req = createRequire(new URL('./package.json', import.meta.url));
const fuses = await import(pathToFileURL(req.resolve('@electron/fuses')).href);

console.log(`[1/7] fetch pinned runtimes for ${platform}`);
const rt = await fetchRuntimes(platform);

console.log('[2/7] extract Electron, rename to AgentLink.exe');
const dir = join(work, 'AgentLink');
extract(rt.electron, dir);
renameSync(join(dir, 'electron.exe'), join(dir, 'AgentLink.exe'));
rmSync(join(dir, 'resources', 'default_app.asar'), { force: true });

console.log('[3/7] ASAR payload');
const payload = buildPayload({
  workDir: work,
  version,
  distDir: args['dist-dir'] ? resolve(args['dist-dir']) : undefined,
});
const asarPath = join(dir, 'resources', 'app.asar');
await packAsar(payload.dir, asarPath);
await assertNoPreviewString(asarPath);
const integrity = await asarIntegrity(asarPath);

console.log('[4/7] bundled Node (official node.exe, untouched)');
const nx = join(work, 'node-x');
extract(rt.node, nx);
const nodeSrc = join(nx, `node-v${constants.node.version}-win-x64`);
const nodeExe = join(dir, 'resources', ...LAYOUT.node.win32); // resources\\node\\node.exe
mkdirSync(join(nodeExe, '..'), { recursive: true });
cpSync(join(nodeSrc, 'node.exe'), nodeExe);
cpSync(join(nodeSrc, 'LICENSE'), join(nodeExe, '..', 'LICENSE'));

console.log('[5/7] core (packed tarball, npm ci from core-lock, --ignore-scripts)');
const core = installCore({
  tgz,
  dest: join(dir, 'resources', ...LAYOUT.coreDir),
  os: 'win32',
  cpu: 'x64',
});

console.log('[6/7] fuses and ASAR integrity resource');
const exe = join(dir, 'AgentLink.exe');
await fuses.flipFuses(exe, {
  version: fuses.FuseVersion.V1,
  strictlyRequireAllFuses: true,
  ...Object.fromEntries(Object.entries(BUILD_FUSES).map(([k, v]) => [fuses.FuseV1Options[k], v])),
});
await writeWinIntegrity(exe, 'resources\\app.asar', integrity);

console.log('[7/7] zip, NSIS, SHA256SUMS');
mkdirSync(out, { recursive: true });
const base = `AgentLink-${version}-win-x64`;
const zip = join(out, `${base}.zip`);
const setup = join(out, `${base}-setup.exe`);
const nsi = join(out, `${base}.nsi`);
rmSync(zip, { force: true });
rmSync(setup, { force: true });
run('tar', ['-a', '-c', '-f', zip, '-C', work, 'AgentLink']);
writeFileSync(nsi, nsisScript({ version, sourceDir: dir, outFile: setup }));
const files = [zip];
if (!args['nsi-only']) {
  const r = capture('makensis', ['-V2', nsi]);
  if (r.code !== 0) throw new Error(`makensis failed:\n${r.stdout}${r.stderr}`);
  files.push(setup);
}
const sums = [];
for (const f of files) sums.push(`${await sha256Of(f)}  ${basename(f)}`);
writeFileSync(join(out, 'SHA256SUMS-win-x64'), sums.join('\n') + '\n');
writeFileSync(
  join(out, 'inputs-win-x64.json'),
  JSON.stringify(
    {
      platform,
      version,
      signed: false,
      placeholderMain: payload.placeholder,
      electron: {
        version: constants.electron.version,
        sha256: constants.electron.assets[platform].sha256,
      },
      node: { version: constants.node.version, sha256: constants.node.assets[platform].sha256 },
      coreTgzSha256: await sha256Of(tgz),
      asarHeaderSha256: integrity.hash,
      coreLockSha256: core.lockSha256,
      coreTreeSha256: core.treeSha256,
      git: gitHeadOrNull(),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `\nApp dir: ${dir}\nZip: ${zip}\n${args['nsi-only'] ? `NSIS script (not compiled): ${nsi}` : `Setup: ${setup}`}`,
);
