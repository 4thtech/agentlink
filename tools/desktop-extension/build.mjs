// M1-9f (D-91): builds the optional Claude Desktop extension bundle (MCPB, formerly DXT) for one
// published CLI version and one platform.
//
//   node tools/desktop-extension/build.mjs --version <x.y.z> --target <darwin-arm64|darwin-x64|win32-x64> --out <dir>
//
// Reproducible from its inputs: the bundle holds the manifest (apps/cli/desktop-extension/manifest.json
// with version and platform filled in) and `server/node_modules`, installed from the npm registry
// for exactly @4thtech-io/agentlink@<version>, with the target's native modules (`--os`/`--cpu`),
// no install scripts, and dependency resolution frozen at that version's publish time (`--before`).
// Every zip entry is stamped with the publish time and written in sorted order (zip.mjs), so the
// same version and target give the same bytes as long as the registry serves the same tarballs.
// Unsigned: release.yml signs, hashes and attests it (sign.sh). Needs network access to the
// registry; runs no package code. Built-ins only.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildManifest, TARGETS, VERSION_RE } from './manifest.mjs';
import { writeDeterministicZip } from './zip.mjs';

const PACKAGE = '@4thtech-io/agentlink';
const REGISTRY = 'https://registry.npmjs.org/';
const root = resolve(import.meta.dirname, '../..');

function npm(args, cwd) {
  return execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, npm_config_registry: REGISTRY, npm_config_update_notifier: 'false' },
  });
}

/** The registry publish time of PACKAGE@version (ISO string). */
function publishTime(version, cwd) {
  const times = JSON.parse(npm(['view', `${PACKAGE}@${version}`, 'time', '--json'], cwd));
  const t = times?.[version];
  if (typeof t !== 'string' || Number.isNaN(Date.parse(t))) {
    throw new Error(`${PACKAGE}@${version} is not on the registry`);
  }
  return t;
}

export function build({ version, target, out }) {
  if (!VERSION_RE.test(version ?? '')) throw new Error('--version must be a stable x.y.z version');
  if (!Object.hasOwn(TARGETS, target ?? '')) {
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
  }
  if (!out) throw new Error('--out is required');
  const { os, cpu } = TARGETS[target];
  const template = JSON.parse(
    readFileSync(join(root, 'apps/cli/desktop-extension/manifest.json'), 'utf8'),
  );
  const manifest = buildManifest(template, { version, target });

  const stage = mkdtempSync(join(tmpdir(), `agentlink-ext-${target}-`));
  try {
    const published = publishTime(version, stage);
    const server = join(stage, 'server');
    mkdirSync(server);
    writeFileSync(join(server, 'package.json'), '{"private":true}\n');
    npm(
      [
        'install',
        `${PACKAGE}@${version}`,
        '--prefix',
        server,
        '--os',
        os,
        '--cpu',
        cpu,
        '--before',
        published,
        '--omit=dev',
        '--ignore-scripts',
        '--no-save',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--registry',
        REGISTRY,
      ],
      stage,
    );
    rmSync(join(server, 'package.json'));
    // npm's own bookkeeping and command shims (symbolic links) are not needed: Claude Desktop runs
    // the entry point with node.
    rmSync(join(server, 'node_modules/.package-lock.json'), { force: true });
    rmSync(join(server, 'node_modules/.bin'), { recursive: true, force: true });

    // The entry point is the published CLI at exactly this version.
    const installed = JSON.parse(
      readFileSync(join(server, `node_modules/${PACKAGE}/package.json`), 'utf8'),
    );
    if (installed.version !== version)
      throw new Error(`installed ${installed.version}, expected ${version}`);
    if (!existsSync(join(stage, manifest.server.entry_point)))
      throw new Error('entry point missing');
    // The target's native modules are present (self-contained bundle).
    const keyring = readdirSync(join(server, 'node_modules/@napi-rs')).filter((n) =>
      n.startsWith(`keyring-${os}-${cpu}`),
    );
    if (keyring.length !== 1) throw new Error(`no @napi-rs/keyring binary for ${target}`);
    if (!existsSync(join(server, `node_modules/better-sqlite3/prebuilds/${os}-${cpu}.node`))) {
      throw new Error(`no better-sqlite3 binary for ${target}`);
    }

    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const file = join(out, `agentlink-${version}-${target}.mcpb`);
    const count = writeDeterministicZip(stage, file, {
      mtime: Math.floor(Date.parse(published) / 1000),
    });
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    console.log(`${file}: ${count} files, sha256 ${sha256} (unsigned)`);
    return { file, sha256 };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: { version: { type: 'string' }, target: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  build(values);
}
