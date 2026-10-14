// deps-check: architecture boundary guard that ESLint alone cannot give.
//
// Why a script on top of the ESLint zones: an inline `eslint-disable`, a plain .js/.mjs file, a
// package.json dependency (declared but not yet imported), or an npm alias can all slip past ESLint.
// This scan cannot be switched off from inside the code it checks, and it runs in `pnpm lint`
// (turbo task `check`), therefore in `ci-gate`.
//
// Scope: every package under packages/* and apps/* (the same scope as the ESLint zones). tools/,
// e2e/ and test-vectors/ are not scanned; the vectors task (M0-9) owns test-vectors/.
//
// Problems reported:
//   manifest   - a workspace package name that differs from the policy, a package without a policy
//                entry, a forbidden workspace dependency (layering), a primitive library declared
//                outside its zone (also behind an `npm:` alias), a runtime dependency that is not in
//                the per-package allowlist, a dependency cycle between workspace packages.
//   source     - an import (static, dynamic, require, import type) that violates policy.violationFor,
//                a relative import that leaves its package, `crypto.subtle` outside packages/crypto,
//                a dynamic import with a non-literal specifier, an eslint-disable that switches the
//                boundary rules off (or is blanket).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  LIBRARIES,
  SUBTLE_ZONES,
  ZONES,
  allowedWorkspaceNames,
  layerMessage,
  libraryMessage,
  matchesGroup,
  violationFor,
  workspaceNameOf,
} from './policy.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', '.turbo', 'coverage']);
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ALL_FIELDS = [...RUNTIME_FIELDS, 'devDependencies'];
const BOUNDARY_RULES = ['no-restricted-imports', 'no-restricted-syntax', 'boundaries/no-bypass'];

/** The package an `npm:` alias really installs: `"foo": "npm:@scope/pkg@1"` -> `@scope/pkg`. */
export function realPackageName(name, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) return name;
  const target = spec.slice(4);
  const at = target.indexOf('@', 1);
  return at === -1 ? target : target.slice(0, at);
}

// --- Manifest checks ------------------------------------------------------------------------------

/**
 * Problems in one workspace manifest. `zone` is its directory ('packages/crypto'), `manifest` the
 * parsed package.json. Pure: no file access.
 */
export function checkManifest(zone, manifest) {
  const policy = ZONES[zone];
  if (!policy) {
    return [
      `${zone}: no entry in tools/deps-check/policy.mjs; add one (layering and allowed dependencies)`,
    ];
  }
  const problems = [];
  if (manifest.name !== policy.name) {
    problems.push(
      `${zone}: package name is ${JSON.stringify(manifest.name)}, policy.mjs expects "${policy.name}"`,
    );
  }
  const allowed = allowedWorkspaceNames(zone);

  for (const field of ALL_FIELDS) {
    for (const [declared, spec] of Object.entries(manifest[field] ?? {})) {
      const real = realPackageName(declared, spec);
      const where = `${zone}: ${field}.${declared}`;
      const alias = real === declared ? '' : ` (alias of ${real})`;

      const workspaceName = workspaceNameOf(real);
      if (workspaceName !== null) {
        if (!allowed.includes(workspaceName)) {
          problems.push(`${where}${alias}: ${layerMessage(zone, workspaceName)}`);
        }
        continue;
      }
      const lib = LIBRARIES.find((candidate) => matchesGroup(real, candidate.group));
      if (lib && !lib.zones.includes(zone)) {
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

/**
 * Problems in one source file. `zone` is the package directory, `file` is the absolute path,
 * `text` the file content. `root` resolves relative imports against the package directory.
 */
export function checkSource(zone, file, text, root) {
  const problems = [];
  const shown = `${zone}/${relative(join(root, zone), file)}`;
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
      const rel = relative(zoneDir, resolve(dirname(file), specifier));
      if (rel.startsWith('..') || isAbsolute(rel)) {
        report(
          node,
          `relative import "${specifier}" leaves ${zone}; import another package by its name`,
        );
      }
      return;
    }
    const message = violationFor(zone, specifier);
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

  const subtleAllowed = SUBTLE_ZONES.includes(zone);

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = staticText(node.moduleSpecifier);
      if (specifier != null) checkSpecifier(node, specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        checkDynamic(node, node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      checkDynamic(node, literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        checkDynamic(node, node.arguments[0]);
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        checkDynamic(node, node.arguments[0]);
      }
    } else if (!subtleAllowed) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'subtle') {
        report(node, 'crypto.subtle may be used only in packages/crypto');
      } else if (
        ts.isElementAccessExpression(node) &&
        staticText(node.argumentExpression) === 'subtle'
      ) {
        report(node, 'crypto.subtle may be used only in packages/crypto');
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        (node.propertyName ?? node.name).getText(sourceFile).replace(/['"]/g, '') === 'subtle'
      ) {
        report(node, 'crypto.subtle may be used only in packages/crypto');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // Directives that switch the boundary rules off. Matched on comments only.
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
  return problems;
}

// --- Repository scan ------------------------------------------------------------------------------

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...sourceFiles(join(dir, entry.name)));
    } else if (SOURCE_EXT.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
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
    if (manifest) {
      problems.push(...checkManifest(zone, manifest));
      graph[manifest.name ?? zone] = ALL_FIELDS.flatMap((field) =>
        Object.entries(manifest[field] ?? {})
          .map(([name, spec]) => realPackageName(name, spec))
          .filter((name) => workspaceNameOf(name) !== null),
      );
    }
    if (!ZONES[zone]) continue; // already reported; do not guess its policy
    for (const file of sourceFiles(dir)) {
      files += 1;
      problems.push(...checkSource(zone, file, readFileSync(file, 'utf8'), root));
    }
  }

  const cycle = findCycle(graph);
  if (cycle) problems.push(`workspace dependency cycle: ${cycle.join(' -> ')}`);
  return { problems, packages: zones.length, files };
}
