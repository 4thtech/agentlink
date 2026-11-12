#!/usr/bin/env node
// Builds AgentLink.app + DMG + zip for macOS (arm64 or x64). Run on macOS (needs ditto, codesign, hdiutil).
//
//   node build-mac.mjs --arch arm64 --tgz <packed-cli.tgz> [--version 0.5.0] [--out dir]
//
// What it does (WP-D4; Decision 3 / H1):
//   pinned Electron + Node fetched over plain HTTPS and hash-checked -> Electron.app renamed AgentLink.app
//   -> app.asar from apps/desktop/dist (placeholder main if absent) -> official Node copied UNTOUCHED to
//   Resources/node -> core tarball installed with --ignore-scripts -> fuses + ASAR integrity -> ad-hoc
//   sign ONLY our bundle, Electron frameworks and helpers (never Resources/node) -> DMG + zip + SHA256SUMS.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants } from './lib/constants.mjs';
import { BUILD_FUSES } from './lib/fuses.mjs';
import { makeIcns } from './lib/icon.mjs';
import { asarIntegrity, writeMacDigest } from './lib/integrity.mjs';
import { describeSignature, planFor, signApp, verifyApp } from './lib/mac-sign.mjs';
import { APP_NAME, infoPlist } from './lib/plist.mjs';
import { parseArgs, run } from './lib/run.mjs';
import {
  CACHE_DIR,
  DESKTOP_DIR,
  OUT_DIR,
  LAYOUT,
  assertNoPreviewString,
  buildPayload,
  extract,
  fetchRuntimes,
  gitHeadOrNull,
  installCore,
  packAsar,
  sha256Of,
} from './lib/stage.mjs';

if (process.platform !== 'darwin') throw new Error('build-mac.mjs runs on macOS only.');

const args = parseArgs(process.argv.slice(2), {
  arch: 'v',
  tgz: 'v',
  version: 'v',
  out: 'v',
  'dist-dir': 'v',
  'keep-work': 'flag',
});
const arch = args.arch ?? 'arm64';
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64.');
if (!args.tgz) throw new Error('--tgz <packed CLI tarball> is required.');
const version = args.version ?? '0.0.0-dev';
const platform = `darwin-${arch}`;
const out = resolve(args.out ?? OUT_DIR);
const work = join(CACHE_DIR, `work-${platform}`);
const tgz = resolve(args.tgz);

const req = createRequire(new URL('./package.json', import.meta.url));
const fuses = await import(pathToFileURL(req.resolve('@electron/fuses')).href);

console.log(`[1/9] fetch pinned runtimes for ${platform}`);
const rt = await fetchRuntimes(platform);

console.log('[2/9] extract Electron, rename to AgentLink.app');
const ex = join(work, 'electron');
extract(rt.electron, ex);
const app = join(work, `${APP_NAME}.app`);
rmSync(app, { recursive: true, force: true });
renameSync(join(ex, 'Electron.app'), app);
const contents = join(app, 'Contents');
renameSync(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', APP_NAME));
rmSync(join(contents, 'Resources', 'default_app.asar'), { force: true });
rmSync(join(contents, 'Resources', 'electron.icns'), { force: true });
const iconSource = makeIcns(join(contents, 'Resources', `${APP_NAME}.icns`), work);

console.log('[3/9] ASAR payload');
const payload = buildPayload({
  workDir: work,
  version,
  distDir: args['dist-dir'] ? resolve(args['dist-dir']) : undefined,
});
const asarPath = join(contents, 'Resources', 'app.asar');
await packAsar(payload.dir, asarPath);
await assertNoPreviewString(asarPath);
const integrity = await asarIntegrity(asarPath);

console.log('[4/9] bundled Node (official binary, left untouched)');
const nx = join(work, 'node-x');
extract(rt.node, nx);
const nodeSrc = join(nx, `node-v${constants.node.version}-${platform}`);
const nodeBin = join(contents, 'Resources', ...LAYOUT.node.posix); // Resources/node/bin/node
const nodeDest = join(contents, 'Resources', LAYOUT.node.posix[0]);
mkdirSync(dirname(nodeBin), { recursive: true });
cpSync(join(nodeSrc, 'bin', 'node'), nodeBin);
cpSync(join(nodeSrc, 'LICENSE'), join(nodeDest, 'LICENSE'));
chmodSync(nodeBin, 0o755);
const nodeBefore = describeSignature(join(nodeSrc, 'bin', 'node'));

console.log('[5/9] core (packed tarball, npm ci from core-lock, --ignore-scripts)');
const core = installCore({
  tgz,
  dest: join(contents, 'Resources', ...LAYOUT.coreDir),
  os: 'darwin',
  cpu: arch,
});
if (!existsSync(join(contents, 'Resources', ...LAYOUT.hostScript))) {
  throw new Error(
    `The core has no desktop host at Resources/${LAYOUT.hostScript.join('/')}: pack the CLI after \`pnpm --filter @4thtech-io/agentlink build\` (it builds dist/desktop-host.js).`,
  );
}

console.log('[6/9] Info.plist, fuses, ASAR integrity digest');
writeFileSync(join(contents, 'Info.plist'), infoPlist({ version, asarHash: integrity.hash }));
const frameworkBin = join(
  contents,
  'Frameworks',
  'Electron Framework.framework',
  'Versions',
  'A',
  'Electron Framework',
);
const slots = await writeMacDigest(frameworkBin, { 'Resources/app.asar': integrity });
await fuses.flipFuses(join(contents, 'MacOS', APP_NAME), {
  version: fuses.FuseVersion.V1,
  strictlyRequireAllFuses: true,
  ...Object.fromEntries(Object.entries(BUILD_FUSES).map(([k, v]) => [fuses.FuseV1Options[k], v])),
});

console.log('[7/9] sign (ad-hoc, our bundle and Electron parts only)');
const entitlements = join(DESKTOP_DIR, 'assets', 'entitlements.mac.plist'); // used only for Developer ID
mkdirSync(out, { recursive: true });
const mode =
  planFor(app, process.env, entitlements).at(-1).identity === '-' ? 'ad-hoc' : 'developer-id';
const signed = signApp(app, process.env, entitlements);
verifyApp(app);
const nodeAfter = describeSignature(nodeBin);
if (nodeAfter.cdhash !== nodeBefore.cdhash || nodeAfter.teamId !== nodeBefore.teamId) {
  throw new Error(
    'The bundled node signature changed. It must keep the upstream Node.js signature.',
  );
}

console.log('[8/9] DMG and zip');
const base = `AgentLink-${version}-mac-${arch}`;
const dmgStage = join(work, 'dmg');
rmSync(dmgStage, { recursive: true, force: true });
mkdirSync(dmgStage, { recursive: true });
run('ditto', [app, join(dmgStage, `${APP_NAME}.app`)]);
symlinkSync('/Applications', join(dmgStage, 'Applications'));
const dmg = join(out, `${base}.dmg`);
const zip = join(out, `${base}.zip`);
rmSync(dmg, { force: true });
rmSync(zip, { force: true });
run('hdiutil', [
  'create',
  '-quiet',
  '-volname',
  APP_NAME,
  '-srcfolder',
  dmgStage,
  '-fs',
  'HFS+',
  '-format',
  'UDZO',
  dmg,
]);
if (mode === 'ad-hoc') run('codesign', ['--force', '--sign', '-', dmg]);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

console.log('[9/9] SHA256SUMS and inputs');
const sums = [];
for (const f of [dmg, zip]) sums.push(`${await sha256Of(f)}  ${basename(f)}`);
writeFileSync(join(out, `SHA256SUMS-mac-${arch}`), sums.join('\n') + '\n');
const inputs = {
  platform,
  version,
  mode,
  placeholderMain: payload.placeholder,
  iconSource,
  electron: {
    version: constants.electron.version,
    sha256: constants.electron.assets[platform].sha256,
  },
  node: {
    version: constants.node.version,
    sha256: constants.node.assets[platform].sha256,
    signature: nodeAfter,
  },
  coreTgzSha256: await sha256Of(tgz),
  asarHeaderSha256: integrity.hash,
  integritySlotsPatched: slots,
  signedTargets: signed,
  coreLockSha256: core.lockSha256,
  coreTreeSha256: core.treeSha256,
  git: gitHeadOrNull(),
};
writeFileSync(join(out, `inputs-mac-${arch}.json`), JSON.stringify(inputs, null, 2) + '\n');
if (!args['keep-work']) rmSync(dmgStage, { recursive: true, force: true });

console.log(
  `\nDMG: ${dmg}\nZip: ${zip}\nApp: ${app}\nCodesign mode: ${mode}; node signature kept (${nodeAfter.authority[0] ?? 'upstream'}).`,
);
