// Pure helpers for the lockfile-pinned core install.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { walk } from './run.mjs';

/**
 * The packed CLI's runtime dependencies must be a subset of the committed lock's top-level
 * dependencies, at the same exact version. Returns one line per problem.
 */
export function checkTgzDeps(tgzDeps = {}, lockDeps = {}) {
  const out = [];
  for (const [name, range] of Object.entries(tgzDeps)) {
    if (!(name in lockDeps))
      out.push(`${name}@${range}: not in core-lock (run update-core-lock.mjs)`);
    else if (lockDeps[name] !== range) {
      out.push(`${name}: tarball wants ${range}, core-lock has ${lockDeps[name]}`);
    }
  }
  return out;
}

/** Every resolved URL in a package-lock must be on the public npm registry. */
export function lockRegistryProblems(lock, registry = 'https://registry.npmjs.org/') {
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    if (p.link) continue;
    if (!p.resolved || !p.integrity) out.push(`${path}: missing resolved or integrity`);
    else if (!p.resolved.startsWith(registry))
      out.push(`${path}: resolved off registry (${p.resolved})`);
  }
  return out;
}

/** SHA-256 over sorted (relative path, file sha256) lines of every regular file under `root`. */
export function treeHash(root) {
  const lines = [];
  for (const e of walk(root)) {
    if (e.dir || e.symlink) continue;
    const rel = relative(root, e.path).split('\\').join('/');
    lines.push(`${rel}\t${createHash('sha256').update(readFileSync(e.path)).digest('hex')}`);
  }
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
