// deps-check: architecture boundary guard that ESLint alone cannot give.
//
// Why a script on top of the ESLint zones: an inline `eslint-disable`, a plain .js/.mjs file, a
// package.json dependency (declared but not yet imported), an alias, or a file ESLint ignores can
// all slip past ESLint. This scan cannot be switched off from inside the code it checks, and it runs
// in `pnpm lint` (turbo task `check`), therefore in `ci-gate`.
//
// Scope: every package under packages/* and apps/* (the same scope as the ESLint zones). tools/,
// e2e/ and test-vectors/ are not scanned; the vectors task (M0-9) owns test-vectors/.
// Files: every file the repository tracks (or would track: not ignored) under those packages, at any
// depth. Nothing is skipped by directory name, so `src/dist/` or `src/.claude/` cannot hide code.
//
// Problems reported:
//   manifest   - a workspace package name that differs from the policy, a package without a policy
//                entry, a forbidden workspace dependency (layering) even behind an `npm:` or
//                `workspace:<name>@` alias, a spec that resolves from a path, URL or git host, a
//                primitive library declared outside its zone, a runtime dependency that is not in
//                the per-package allowlist, an `imports` map, a dependency cycle (on resolved names).
//                A zone with `bundles: true` (apps/cli, OPS-REL-1) ships its workspace packages inside
//                its own bundle: it may re-declare their third-party runtime dependencies with the
//                exact same spec (bundledRuntimeOf), and it may not declare a workspace package at
//                runtime. Its source imports are checked as in every other zone.
//   files      - a test-like file name other than *.test.ts (`.test.mts`, `.spec.ts`, ...): builds
//                exclude only *.test.ts, so it would be built (IR-M1-1c-G2-1 L-1).
//   source     - an import (static, dynamic, require, import type) that violates policy.violationFor,
//                a relative import that leaves its package, `crypto.subtle` outside packages/crypto
//                (also through Reflect.get or a computed key), a dynamic import with a non-literal
//                specifier, `require` used other than as a direct call, `module.require`,
//                `process.getBuiltinModule` and the other loader members, eval and Function, an
//                eslint-disable or inline eslint config that switches the boundary rules off.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  LIBRARIES,
  LOADER_MEMBERS,
  SUBTLE_ONLY_ZONES,
  SUBTLE_ZONES,
  ZONES,
  allowedManifestNames,
  isRetiredScope,
  isSubtleExempt,
  layerMessage,
  libraryAllowed,
  libraryMessage,
  matchesGroup,
  misnamedTestFile,
  retiredScopeMessage,
  testSeamViolation,
  violationFor,
  workspaceNameOf,
} from './policy.mjs';

// Only the fallback walk (no repository metadata) skips anything, and only these.
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ALL_FIELDS = [...RUNTIME_FIELDS, 'devDependencies'];
const BOUNDARY_RULES = [
  'no-restricted-imports',
  'no-restricted-syntax',
  'boundaries/no-bypass',
  'no-eval',
  'no-new-func',
  'no-implied-eval',
];

/**
 * The package a dependency really installs. `"foo": "npm:@scope/pkg@1"` and
 * `"foo": "workspace:@scope/pkg@*"` both install `@scope/pkg`, whatever the key says.
 */
export function realPackageName(name, spec) {
  if (typeof spec !== 'string') return name;
  if (spec.startsWith('npm:')) {
    const target = spec.slice(4);
    const at = target.indexOf('@', 1);
    return at === -1 ? target : target.slice(0, at);
  }
  if (spec.startsWith('workspace:')) {
    const named = /^(@[^/@]+\/[^/@]+|[^/@.][^/@]*)@/.exec(spec.slice('workspace:'.length));
    if (named) return named[1];
  }
  return name;
}

/**
 * Why a dependency spec is not acceptable, or null. Allowed: a registry version, range or tag,
 * `workspace:` (version forms and `workspace:<name>@<range>`) and `npm:` aliases. Everything that
 * resolves from a path, a URL or a git host (`link:`, `file:`, `portal:`, `github:`, `jsr:`, tarball
 * URLs, `user/repo`) or from a catalog is refused: it can hide any package behind any name.
 */
export function specProblem(spec) {
  if (typeof spec !== 'string') return 'the version spec must be a string';
  if (spec.startsWith('npm:')) return null;
  if (spec.startsWith('workspace:')) {
    return /^[./]/.test(spec.slice('workspace:'.length))
      ? 'workspace: path specs are not allowed; use workspace:*'
      : null;
  }
  if (spec.startsWith('catalog:')) return 'catalog: specs are not supported by deps-check';
  if (/[:/]/.test(spec)) {
    return `"${spec}" resolves from a path, URL or git host; only registry versions, workspace: and npm: specs are allowed`;
  }
  return null;
}

// --- Manifest checks ------------------------------------------------------------------------------

/**
 * The third-party runtime dependencies of the workspace packages that `manifest` depends on (any
 * field), transitively: what a bundle of them must still install (OPS-REL-1). `manifests` maps
 * workspace package names to their parsed package.json. Returns { runtime: Map name -> spec,
 * problems } where a problem is one dependency declared with two different specs. Pure.
 * M1-11b-6: `embedded` names workspace packages whose built files are embedded (policy `embeds`,
 * apps/local-ui), not bundled: they are not traversed, and their (browser) dependencies are not
 * part of the bundle's runtime.
 */
export function bundledRuntimeOf(manifest, manifests, embedded = []) {
  const runtime = new Map();
  const problems = [];
  const seen = new Set(embedded);
  const queue = [];
  const enqueueWorkspace = (pkg, fields) => {
    for (const field of fields) {
      for (const [declared, spec] of Object.entries(pkg[field] ?? {})) {
        const real = realPackageName(declared, spec);
        if (workspaceNameOf(real) !== null && !seen.has(real)) {
          seen.add(real);
          queue.push(real);
        }
      }
    }
  };
  enqueueWorkspace(manifest, ALL_FIELDS);
  while (queue.length > 0) {
    const name = queue.shift();
    const pkg = manifests[name];
    if (!pkg) continue;
    enqueueWorkspace(pkg, RUNTIME_FIELDS);
    for (const field of RUNTIME_FIELDS) {
      for (const [declared, spec] of Object.entries(pkg[field] ?? {})) {
        const real = realPackageName(declared, spec);
        if (workspaceNameOf(real) !== null || real !== declared) continue;
        const before = runtime.get(real);
        if (before !== undefined && before !== spec) {
          problems.push(
            `${manifest.name}: bundled packages declare ${real} as both ${before} and ${spec}; align them`,
          );
          continue;
        }
        runtime.set(real, spec);
      }
    }
  }
  return { runtime, problems };
}

/**
 * Problems in one workspace manifest. `zone` is its directory ('packages/crypto'), `manifest` the
 * parsed package.json. `bundledRuntime` (bundledRuntimeOf) applies only to a zone whose policy has
 * `bundles: true`. Pure: no file access.
 */
export function checkManifest(zone, manifest, { bundledRuntime = new Map() } = {}) {
  const policy = ZONES[zone];
  if (!policy) {
    return [
      `${zone}: no entry in tools/deps-check/policy.mjs; add one (layering and allowed dependencies)`,
    ];
  }
  const problems = [];
  if (isRetiredScope(manifest.name)) {
    problems.push(`${zone}: package name: ${retiredScopeMessage(manifest.name)}`);
  }
  if (manifest.name !== policy.name) {
    problems.push(
      `${zone}: package name is ${JSON.stringify(manifest.name)}, policy.mjs expects "${policy.name}"`,
    );
  }
  if (manifest.imports !== undefined) {
    problems.push(
      `${zone}: the package.json "imports" map is not allowed (its targets are not checked)`,
    );
  }
  const allowed = allowedManifestNames(zone);
  const bundles = policy.bundles === true;

  for (const field of ALL_FIELDS) {
    for (const [declared, spec] of Object.entries(manifest[field] ?? {})) {
      const real = realPackageName(declared, spec);
      const where = `${zone}: ${field}.${declared}`;
      const alias = real === declared ? '' : ` (alias of ${real})`;

      if (isRetiredScope(declared) || isRetiredScope(real)) {
        problems.push(
          `${where}${alias}: ${retiredScopeMessage(isRetiredScope(real) ? real : declared)}`,
        );
        continue;
      }
      const bad = specProblem(spec);
      if (bad !== null) {
        problems.push(`${where}: ${bad}`);
        continue;
      }
      if (spec.startsWith('workspace:') && real !== declared) {
        problems.push(
          `${where}: a workspace: alias must not point to a different package (${real})`,
        );
      }

      const workspaceName = workspaceNameOf(real);
      if (workspaceName !== null) {
        if (!allowed.includes(workspaceName)) {
          problems.push(`${where}${alias}: ${layerMessage(zone, workspaceName)}`);
        }
        if (bundles && RUNTIME_FIELDS.includes(field)) {
          problems.push(
            `${where}: ${zone} its workspace packages are bundled (OPS-REL-1); declare them in devDependencies, not at runtime`,
          );
        }
        continue;
      }
      // OPS-REL-1: a bundling zone re-declares a bundled package's runtime dependency, same spec.
      if (
        bundles &&
        RUNTIME_FIELDS.includes(field) &&
        real === declared &&
        bundledRuntime.get(real) === spec
      ) {
        continue;
      }
      const lib = LIBRARIES.find((candidate) => matchesGroup(real, candidate.group));
      // A test-only library (LIBRARIES testZones) may be a devDependency, never a runtime one.
      if (lib && !libraryAllowed(lib, zone, { test: field === 'devDependencies' })) {
        problems.push(`${where}${alias}: ${libraryMessage(lib)}`);
        continue;
      }
      if (RUNTIME_FIELDS.includes(field)) {
        const entry = policy.external.find((candidate) => matchesGroup(real, [candidate.pattern]));
        if (!entry || !entry.reason?.trim()) {
          problems.push(
            `${where}${alias}: not in the runtime-dependency allowlist for ${zone}; add an entry with a justification in tools/deps-check/policy.mjs`,
          );
        }
      }
    }
  }
  return problems;
}

/** Finds a dependency cycle in `graph` (name -> names). Returns the cycle as an array or null. */
export function findCycle(graph) {
  const state = new Map(); // name -> 1 visiting, 2 done
  const stack = [];
  function visit(name) {
    state.set(name, 1);
    stack.push(name);
    for (const next of graph[name] ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(name, 2);
    return null;
  }
  for (const name of Object.keys(graph)) {
    if (!state.has(name)) {
      const cycle = visit(name);
      if (cycle) return cycle;
    }
  }
  return null;
}

// --- Source checks --------------------------------------------------------------------------------

const staticText = (node) => node && (ts.isStringLiteralLike(node) ? node.text : null);

function scriptKind(file) {
  if (file.endsWith('x')) return ts.ScriptKind.TSX;
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** `crypto` or `<something>.crypto`. */
function isCryptoReceiver(node) {
  if (ts.isIdentifier(node)) return node.text === 'crypto';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'crypto';
}

/** True when this `require` identifier names a declaration or a property rather than reading it. */
function isRequireName(node) {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  return parent.name === node || parent.propertyName === node;
}

/**
 * Problems in one source file. `zone` is the package directory, `file` is the absolute path,
 * `text` the file content. `root` resolves relative imports against the package directory.
 */
export function checkSource(zone, file, text, root) {
  const problems = [];
  const shown = `${zone}/${relative(join(root, zone), file)}`;
  const repoPath = relative(root, file).split('\\').join('/');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const zoneDir = join(root, zone);
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const report = (node, message) => problems.push(`${shown}:${lineOf(node)}: ${message}`);

  function checkSpecifier(node, specifier) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      const rel = relative(zoneDir, target);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        report(
          node,
          `relative import "${specifier}" leaves ${zone}; import another package by its name`,
        );
      }
      const seam = testSeamViolation(repoPath, relative(root, target).split('\\').join('/'));
      if (seam !== null) report(node, `import of "${specifier}": ${seam}`);
      return;
    }
    const message = violationFor(zone, specifier, repoPath);
    if (message !== null) report(node, `import of "${specifier}": ${message}`);
  }

  function checkDynamic(node, argument) {
    const specifier = staticText(argument);
    if (specifier === null || specifier === undefined) {
      report(node, 'dynamic import or require with a non-literal specifier cannot be checked');
      return;
    }
    checkSpecifier(node, specifier);
  }

  // Zones such as test-vectors/ are checked for crypto.subtle only; the harness has its own rules.
  const full = !SUBTLE_ONLY_ZONES.includes(zone);
  const subtleAllowed = SUBTLE_ZONES.includes(zone) || isSubtleExempt(repoPath);
  const isReflectSubtle = (node) =>
    !subtleAllowed &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    ['Reflect', 'Object'].includes(node.expression.expression.text) &&
    node.arguments.some((argument) => staticText(argument) === 'subtle');
  const subtle = (node) => report(node, 'crypto.subtle may be used only in packages/crypto');
  const loader = (node, name) =>
    report(node, `"${name}" reaches the module loader around the import checks`);

  /** Name of a property access / element access / binding, or null when it is computed. */
  function memberName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return staticText(node.argumentExpression) ?? null;
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
    }
    return null;
  }

  function visit(node) {
    if (!full) {
      if (isReflectSubtle(node)) subtle(node);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = staticText(node.moduleSpecifier);
      if (specifier != null) checkSpecifier(node, specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        checkDynamic(node, node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      checkDynamic(node, literal);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword) {
        checkDynamic(node, node.arguments?.[0]);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(callee) &&
        callee.text === 'require'
      ) {
        checkDynamic(node, node.arguments[0]);
      } else if (ts.isIdentifier(callee) && ['eval', 'Function'].includes(callee.text)) {
        report(
          node,
          `${callee.text} builds code from a string and hides imports from the boundary checks`,
        );
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(callee) &&
        ['setTimeout', 'setInterval'].includes(callee.text) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        report(node, `${callee.text} with a string argument is eval`);
      } else if (isReflectSubtle(node)) {
        subtle(node);
      }
    } else if (ts.isIdentifier(node) && node.text === 'module' && !isRequireName(node)) {
      report(node, '"module" (CommonJS) is not allowed; the packages are ESM');
    } else if (ts.isIdentifier(node) && node.text === 'require') {
      // `require` anywhere but as the callee of a direct call: const r = require; require.call(...)
      const parent = node.parent;
      const direct = ts.isCallExpression(parent) && parent.expression === node;
      if (!direct && !isRequireName(node)) {
        report(node, '"require" may only be called directly with a string literal');
      }
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isBindingElement(node)
    ) {
      const name = memberName(node);
      const receiver = ts.isBindingElement(node) ? undefined : node.expression;
      if (full && name !== null && LOADER_MEMBERS.includes(name)) loader(node, name);
      if (full && receiver && ts.isIdentifier(receiver)) {
        if (name === 'require' && receiver.text === 'module') loader(node, 'module.require');
        if (name === 'binding' && receiver.text === 'process') loader(node, 'process.binding');
      }
      if (!subtleAllowed) {
        if (name === 'subtle') subtle(node);
        else if (
          name === null &&
          receiver &&
          ts.isElementAccessExpression(node) &&
          isCryptoReceiver(receiver)
        ) {
          subtle(node); // crypto[k] with a computed key could be 'subtle'
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!full) return problems;

  // Directives and inline config comments that switch the boundary rules off. Matched on comments only.
  const directive = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b([^\n]*)/g;
  for (const match of text.matchAll(directive)) {
    const listed = match[1]
      .replace(/\*\/.*$/, '')
      .split('--')[0]
      .trim();
    const rules = listed === '' ? [] : listed.split(',').map((rule) => rule.trim());
    const blanket = rules.length === 0;
    if (blanket || rules.some((rule) => BOUNDARY_RULES.includes(rule))) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(
        `${shown}:${line}: eslint-disable must not switch off the boundary rules (${blanket ? 'blanket directive' : listed})`,
      );
    }
  }
  for (const match of text.matchAll(/\/\*\s*eslint\s([\s\S]*?)\*\//g)) {
    if (BOUNDARY_RULES.some((rule) => match[1].includes(rule))) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(
        `${shown}:${line}: an inline eslint config comment must not change the boundary rules`,
      );
    }
  }
  return problems;
}

// --- Repository scan ------------------------------------------------------------------------------

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...walk(join(dir, entry.name)));
    } else {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const gitList = (root, args) =>
  execFileSync('git', ['-C', root, 'ls-files', '-z', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean);

/**
 * Every file under `dir` (a package directory) that deps-check must look at:
 *   files    - absolute paths of source files. Inside a repository: the tracked files plus untracked
 *              files that are not ignored, so an ignored build directory is left out but
 *              `git add -f src/dist/x.ts` is still scanned. Without repository metadata: a full walk
 *              that skips only node_modules.
 *   symlinks - repo-relative paths of symbolic links (mode 120000 in the index, or found on disk). A
 *              linked directory is one entry without a source extension and would hide its files.
 */
export function listSourceFiles(root, dir) {
  return listSourceFilesIn(root, [dir]).get(dir);
}

/**
 * The same listing for several directories at once: 2 `git ls-files` runs in total instead of 2 per
 * directory (the repository scan spawned 34 processes, which dominated its time on a loaded CI
 * runner). A path belongs to the deepest listed directory that contains it. Returns Map(dir -> result).
 */
export function listSourceFilesIn(root, dirs) {
  const zonePaths = new Map(dirs.map((dir) => [dir, relative(root, dir).split('\\').join('/')]));
  // Fail closed: with nested zones the deepest-owner rule would narrow what the outer zone scans.
  const all = [...zonePaths.values()];
  for (const a of all) {
    for (const b of all) {
      if (a === b ? false : b.startsWith(`${a}/`)) {
        throw new Error(`deps-check: zones must not nest (${a}, ${b})`);
      }
    }
  }
  const pathsOf = new Map(dirs.map((dir) => [dir, []]));
  const symlinksOf = new Map(dirs.map((dir) => [dir, new Set()]));
  const ownerOf = (path) => {
    let best = null;
    for (const [dir, zonePath] of zonePaths) {
      if (
        (path === zonePath || path.startsWith(`${zonePath}/`)) &&
        (best === null || zonePath.length > zonePaths.get(best).length)
      ) {
        best = dir;
      }
    }
    return best;
  };
  let listedByGit = false;
  try {
    const specs = ['--', ...zonePaths.values()];
    const listed = gitList(root, ['--cached', '--others', '--exclude-standard', ...specs]);
    const staged = gitList(root, ['-s', ...specs]);
    for (const path of listed) pathsOf.get(ownerOf(path))?.push(join(root, path));
    for (const entry of staged) {
      const [meta, path] = entry.split('\t');
      if (meta.startsWith('120000 ')) symlinksOf.get(ownerOf(path))?.add(path);
    }
    listedByGit = true;
  } catch {
    // no repository metadata: walk each directory
  }
  const result = new Map();
  for (const dir of dirs) {
    const paths = listedByGit ? pathsOf.get(dir) : walk(dir);
    const symlinks = symlinksOf.get(dir);
    const live = paths.filter((path) => !path.split(/[\\/]/).includes('node_modules'));
    for (const path of live) {
      try {
        if (lstatSync(path).isSymbolicLink()) {
          symlinks.add(relative(root, path).split('\\').join('/'));
        }
      } catch {
        // deleted but still listed: nothing to scan
      }
    }
    const files = live
      .filter(
        (path) => SOURCE_EXT.test(path) && existsSync(path) && !symlinks.has(relative(root, path)),
      )
      .sort();
    result.set(dir, { files, symlinks: [...symlinks].sort() });
  }
  return result;
}

/** Workspace directories under packages/* and apps/*: [{ zone, dir }]. */
function workspaceZones(root) {
  const zones = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        zones.push({ zone: `${group}/${entry.name}`, dir: join(groupDir, entry.name) });
      }
    }
  }
  return zones.sort((a, b) => a.zone.localeCompare(b.zone));
}

/** Runs every check against the repository at `root`. Returns { problems, packages, files }. */
export function runChecks(root) {
  const problems = [];
  const graph = {};
  let files = 0;
  const zones = workspaceZones(root);
  const subtleDirs = SUBTLE_ONLY_ZONES.map((zone) => join(root, zone)).filter((dir) =>
    existsSync(dir),
  );
  const listings = listSourceFilesIn(root, [...zones.map(({ dir }) => dir), ...subtleDirs]);

  // First pass: every manifest, so a bundling zone can see the packages it bundles (OPS-REL-1).
  const parsed = new Map();
  const byName = {};
  for (const { zone, dir } of zones) {
    const manifestPath = join(dir, 'package.json');
    let manifest = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (error) {
        problems.push(`${zone}/package.json: cannot be read as JSON (${error.message})`);
      }
    } else {
      problems.push(`${zone}: no package.json`);
    }
    parsed.set(zone, manifest);
    if (manifest && typeof manifest.name === 'string') byName[manifest.name] = manifest;
  }

  for (const { zone, dir } of zones) {
    const manifest = parsed.get(zone);
    if (manifest) {
      let bundledRuntime = new Map();
      if (ZONES[zone]?.bundles === true) {
        const embedded = (ZONES[zone].embeds ?? []).map((app) => ZONES[app].name);
        const bundled = bundledRuntimeOf(manifest, byName, embedded);
        problems.push(...bundled.problems);
        bundledRuntime = bundled.runtime;
      }
      problems.push(...checkManifest(zone, manifest, { bundledRuntime }));
      graph[manifest.name ?? zone] = ALL_FIELDS.flatMap((field) =>
        Object.entries(manifest[field] ?? {})
          .map(([name, spec]) => realPackageName(name, spec))
          .filter((name) => workspaceNameOf(name) !== null),
      );
    }
    if (!ZONES[zone]) continue; // already reported; do not guess its policy
    const listed = listings.get(dir);
    for (const link of listed.symlinks) {
      problems.push(
        `${link}: symbolic links are not allowed in packages/ and apps/ (they hide files from the scan)`,
      );
    }
    for (const file of listed.files) {
      if (file.endsWith('.cjs')) {
        problems.push(
          `${relative(root, file)}: CommonJS (.cjs) files are not allowed in packages/ and apps/; use ESM`,
        );
      }
      const misnamed = misnamedTestFile(relative(root, file).split('\\').join('/'));
      if (misnamed !== null) problems.push(`${relative(root, file)}: ${misnamed}`);
      files += 1;
      problems.push(...checkSource(zone, file, readFileSync(file, 'utf8'), root));
    }
  }

  for (const zone of SUBTLE_ONLY_ZONES) {
    const dir = join(root, zone);
    if (!existsSync(dir)) continue;
    const listed = listings.get(dir);
    for (const link of listed.symlinks)
      problems.push(`${link}: symbolic links are not allowed here`);
    for (const file of listed.files) {
      files += 1;
      problems.push(...checkSource(zone, file, readFileSync(file, 'utf8'), root));
    }
  }

  const cycle = findCycle(graph);
  if (cycle) problems.push(`workspace dependency cycle: ${cycle.join(' -> ')}`);
  return { problems, packages: zones.length, files };
}
