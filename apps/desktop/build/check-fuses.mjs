#!/usr/bin/env node
// CI-side fuse read-back (H1). Reads the fuses back from the BUILT binary and fails on any
// difference from lib/fuses.mjs. On macOS it also checks that the ASAR integrity entry in Info.plist
// matches the real app.asar header and that the digest slot in the Electron Framework was written.
//
//   node check-fuses.mjs --app <AgentLink.app | AgentLink.exe>
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FUSE_NAMES, FUSES, diffFuses } from './lib/fuses.mjs';
import { asarIntegrity, integrityDigest } from './lib/integrity.mjs';
import { parseArgs, capture } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { app: 'v' });
if (!args.app) throw new Error('--app <AgentLink.app | AgentLink.exe> is required.');
const app = resolve(args.app);
if (!existsSync(app)) throw new Error(`Not found: ${app}`);

const req = createRequire(new URL('./package.json', import.meta.url));
const fuses = await import(pathToFileURL(req.resolve('@electron/fuses')).href);

// The numeric indices in @electron/fuses must still match our name table (guards a library change).
for (const [i, name] of FUSE_NAMES.entries()) {
  if (fuses.FuseV1Options[i] !== name)
    throw new Error(`Fuse index ${i} is ${fuses.FuseV1Options[i]}, expected ${name}.`);
}

const wire = await fuses.getCurrentFuseWire(app);
const actual = {};
for (const [k, state] of Object.entries(wire)) {
  if (k === 'version') continue;
  const name = fuses.FuseV1Options[k];
  actual[name] =
    state === fuses.FuseState.ENABLE
      ? true
      : state === fuses.FuseState.DISABLE
        ? false
        : `state ${String(state)}`;
}
const problems = diffFuses(actual);
for (const name of Object.keys(FUSES)) console.log(`  ${name}: ${actual[name]}`);

if (app.endsWith('.app')) {
  const asarPath = join(app, 'Contents', 'Resources', 'app.asar');
  const plist = capture('plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(app, 'Contents', 'Info.plist'),
  ]);
  const entry = JSON.parse(plist.stdout).ElectronAsarIntegrity?.['Resources/app.asar'];
  const real = await asarIntegrity(asarPath);
  if (!entry || entry.hash !== real.hash || entry.algorithm !== 'SHA256') {
    problems.push('Info.plist ElectronAsarIntegrity does not match app.asar');
  }
  const fw = readFileSync(
    join(
      app,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Electron Framework',
    ),
  );
  const sentinel = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');
  const want = integrityDigest({ 'Resources/app.asar': real });
  let slots = 0;
  for (let at = fw.indexOf(sentinel); at !== -1; at = fw.indexOf(sentinel, at + 1)) {
    slots++;
    const slot = fw.subarray(at + sentinel.length, at + sentinel.length + 34);
    if (slot.length < 34 || slot[0] !== 1 || slot[1] !== 1 || !slot.subarray(2).equals(want)) {
      problems.push(`Electron Framework integrity digest slot ${slots} is not written or wrong`);
    }
  }
  if (slots === 0) problems.push('Electron Framework has no integrity digest slot');
} else {
  const asarPath = join(dirname(app), 'resources', 'app.asar');
  if (!existsSync(asarPath)) problems.push('resources/app.asar is missing');
  else {
    const real = await asarIntegrity(asarPath);
    const exe = readFileSync(app);
    const want = Buffer.from(
      JSON.stringify([{ file: 'resources\\app.asar', alg: real.algorithm, value: real.hash }]),
      'utf8',
    );
    if (!exe.includes(want))
      problems.push('exe has no ELECTRONASAR integrity resource matching resources/app.asar');
  }
}

if (problems.length) {
  console.error(`FUSE CHECK FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Fuse check passed: release fuse set and ASAR integrity as expected.');
