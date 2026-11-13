// Derives the npm package-lock for the desktop core FROM pnpm-lock.yaml, so the app ships exactly the
// name@version and integrity the repository already locked, reviewed and tested (no second
// resolution). Pure: takes the parsed pnpm lock and the CLI's production dependencies.
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/';

const stripPeers = (v) => v.replace(/\(.*$/, '');
const split = (key) => {
  const at = key.indexOf('@', 1); // first '@' after a possible scope marker
  return { name: key.slice(0, at), version: stripPeers(key.slice(at + 1)) };
};

/** Reads pnpm-lock.yaml (it may hold several YAML documents) and returns the main lockfile object. */
export async function readPnpmLock(path) {
  const YAML = await import('yaml');
  const docs = YAML.parseAllDocuments(readFileSync(path, 'utf8')).map((d) => d.toJS());
  const main = docs.find((d) => d?.importers?.['apps/cli'] && d?.snapshots);
  if (!main) throw new Error('No document with importers and snapshots in pnpm-lock.yaml.');
  return main;
}

/** Returns a package-lock v3 object. `importer` is the pnpm importer path, e.g. 'apps/cli'. */
export function buildCoreLock(pnpm, importer, cliDeps) {
  const imp = pnpm.importers[importer];
  if (!imp) throw new Error(`pnpm-lock.yaml has no importer ${importer}.`);
  const snapshots = pnpm.snapshots;
  const pkgs = pnpm.packages;
  const roots = Object.entries(imp.dependencies ?? {}).map(([name, d]) => {
    if (cliDeps[name] !== stripPeers(d.version)) {
      throw new Error(
        `${name}: package.json has ${cliDeps[name]}, pnpm-lock.yaml has ${d.version}`,
      );
    }
    return [name, `${name}@${d.version}`];
  });
  if (roots.length !== Object.keys(cliDeps).length) {
    throw new Error('apps/cli dependencies and the pnpm importer differ.');
  }

  // Which snapshots are reachable through required (non-optional) edges.
  const required = new Set();
  const stack = roots.map(([, k]) => k);
  while (stack.length) {
    const k = stack.pop();
    if (required.has(k)) continue;
    required.add(k);
    for (const [n, v] of Object.entries(snapshots[k]?.dependencies ?? {})) stack.push(`${n}@${v}`);
  }

  const tree = new Map(); // location -> {name, version, key}
  const find = (from, name) => {
    let loc = from;
    for (;;) {
      const cand = `${loc}node_modules/${name}`;
      if (tree.has(cand)) return cand;
      if (loc === '') return null;
      loc = loc.replace(/node_modules\/(@[^/]+\/)?[^/]+\/$/, '');
    }
  };
  const queue = roots.map(([n, k]) => ['', n, k]);
  while (queue.length) {
    const [parent, name, key] = queue.shift();
    const { version } = split(key);
    const found = find(parent, name);
    if (found && tree.get(found).version === version) continue;
    // Free name: hoist to the root. Taken by another version: nest under the requiring package.
    const place = found ? `${parent}node_modules/${name}` : `node_modules/${name}`;
    tree.set(place, { name, version, key });
    const s = snapshots[key] ?? {};
    for (const [n, v] of Object.entries(s.dependencies ?? {})) {
      queue.push([`${place}/`, n, `${n}@${v}`]);
    }
    for (const [n, v] of Object.entries(s.optionalDependencies ?? {})) {
      queue.push([`${place}/`, n, `${n}@${v}`]);
    }
  }

  const packages = {
    '': {
      name: 'agentlink-core-deps',
      version: '0.0.0',
      dependencies: Object.fromEntries(roots.map(([n]) => [n, cliDeps[n]]).sort()),
    },
  };
  for (const loc of [...tree.keys()].sort()) {
    const { name, version, key } = tree.get(loc);
    const meta = pkgs[`${name}@${version}`];
    if (!meta?.resolution?.integrity) throw new Error(`No integrity for ${name}@${version}.`);
    const s = snapshots[key] ?? {};
    const entry = {
      version,
      resolved: `${REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`,
      integrity: meta.resolution.integrity,
    };
    if (!required.has(key)) entry.optional = true;
    const dep = (o) =>
      Object.fromEntries(Object.entries(o ?? {}).map(([n, v]) => [n, stripPeers(v)]));
    if (s.dependencies) entry.dependencies = dep(s.dependencies);
    if (s.optionalDependencies) entry.optionalDependencies = dep(s.optionalDependencies);
    if (meta.os) entry.os = meta.os;
    if (meta.cpu) entry.cpu = meta.cpu;
    if (meta.engines) entry.engines = meta.engines;
    packages[loc] = entry;
  }
  return {
    name: 'agentlink-core-deps',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}
