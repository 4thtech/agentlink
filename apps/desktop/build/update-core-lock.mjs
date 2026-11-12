#!/usr/bin/env node
// Regenerates core-lock/package-lock.json: the committed, reviewed npm lock for the CLI's production
// dependencies (apps/cli/package.json `dependencies`, exact pins). build-mac/build-win install it with
// `npm ci --ignore-scripts` and then unpack the packed CLI tarball on top, so no transitive package
// is ever resolved at build time. Review the lock diff like any dependency change (no new install
// scripts, integrity hashes present, registry URLs only registry.npmjs.org).
//
//   node update-core-lock.mjs [--days 7]     (7 days = the repo cooldown for crypto/transport deps)
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY, defaultBefore } from './lib/stage.mjs';
import { parseArgs, run } from './lib/run.mjs';

const args = parseArgs(process.argv.slice(2), { days: 'v' });
const dir = new URL('./core-lock/', import.meta.url).pathname;
const cli = JSON.parse(readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'));
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: 'agentlink-core-deps',
      version: '0.0.0',
      private: true,
      dependencies: cli.dependencies,
    },
    null,
    2,
  ) + '\n',
);
rmSync(join(dir, 'package-lock.json'), { force: true });
run('npm', [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  `--registry=${REGISTRY}`,
  `--before=${defaultBefore(Number(args.days ?? 7))}`,
  '--prefix',
  dir,
]);
console.log('core-lock updated. Review the diff.');
