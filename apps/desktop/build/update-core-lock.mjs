#!/usr/bin/env node
// Regenerates core-lock/ FROM pnpm-lock.yaml (no network, no second resolution): the same
// name@version and integrity the repository already locked for apps/cli's production dependencies.
// build-mac/build-win install it with `npm ci --ignore-scripts`, then unpack the packed CLI tarball.
// Run it whenever pnpm-lock.yaml changes for apps/cli; test/core-lock.test.mjs fails on drift.
//
//   node update-core-lock.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoreLock, readPnpmLock } from './lib/pnpm-core-lock.mjs';

const dir = fileURLToPath(new URL('./core-lock/', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));

const cli = JSON.parse(readFileSync(join(repo, 'apps', 'cli', 'package.json'), 'utf8'));
const pnpm = await readPnpmLock(join(repo, 'pnpm-lock.yaml'));
const lock = buildCoreLock(pnpm, 'apps/cli', cli.dependencies);
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
writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(
  `core-lock written: ${Object.keys(lock.packages).length - 1} packages. Review the diff.`,
);
