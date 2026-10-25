#!/usr/bin/env node
// The neutral-platform bundle check (M1-9c-c, IR-M1-9c-1 F07; D-76, 06 §1). CI runs it in the
// `bundle-check` job after the build; test/bundle-check.test.ts drives it the same way. It needs no
// native module, no keychain and no network, and adds no dependency: it reuses the repository's
// Vite (the bundler of bundle.config.mjs) for both parsing and bundling.
//
// 1. The published bundle (dist/agentlink.js; OPS-REL-1). Every import it keeps (static, re-export,
//    side-effect, dynamic `import("…")`), read from the AST, must be a `node:` built-in or a declared
//    runtime dependency of apps/cli/package.json. Banned, whatever the manifest says (D-76): the
//    crypto-capable transitive packages of the MCP SDK's HTTP and OAuth transports (jose,
//    pkce-challenge, cookie-signature, etag, hono, @hono/node-server) and every SDK dependency the
//    stdio path does not use. SDK imports must name a subpath in SDK_ENTRIES. A workspace
//    (`@4thtech-io/*`) or relative import, any `require(…)` and an `import(…)` without a string
//    literal fail too: the bundle is one ESM file whose imports can all be read statically. The
//    runtime counterpart, which traces the modules the stdio server really loads, is
//    test/mcp-module-graph.test.ts.
// 2. packages/mcp-tools/src/ for a neutral (Worker) platform (06 §1 runtime-agnostic, IR-M1-9j-1 F04). Vite
//    bundles packages/mcp-tools/src/index.ts with Worker resolve conditions and nothing external; a Node built-in
//    (`node:` or one Vite resolves to its browser-external stub), `@4thtech-io/node`, the MCP SDK or
//    a banned package anywhere in its module graph (workspace packages and third-party code
//    included) fails the check, except the narrow NEUTRAL_EXCEPTIONS.
//
// Usage: node scripts/bundle-check.mjs [--bundle <file>] [--tools-entry <file>]
//                                      [--skip-bundle] [--skip-tools]
// Exit code 0 when every check passes, 1 on a finding (each one on stderr), 2 on an error.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, parseAst } from 'vite';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** SDK dependencies the stdio server and the protocol types use (as in mcp-module-graph.test.ts). */
export const STDIO_PACKAGES = ['ajv', 'ajv-formats', 'zod', 'zod-to-json-schema'];
/** Crypto-capable transitive packages of the SDK's HTTP and OAuth code (D-76). */
export const CRYPTO_TRANSITIVE = [
  'cookie-signature',
  'etag',
  'jose',
  'pkce-challenge',
  'hono',
  '@hono/node-server',
];
/** The SDK subpaths the published bundle may import (the stdio server and the protocol types). */
export const SDK_ENTRIES = [
  '@modelcontextprotocol/sdk/server/index.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  '@modelcontextprotocol/sdk/types.js',
];
const SDK = '@modelcontextprotocol/sdk';
/**
 * The Node built-ins the published bundle may import: exactly the ones it uses today (IR-M1-9c-c-1
 * L1). Anything else (`node:module`, `node:vm`, `node:worker_threads`, `node:crypto`, …) fails until
 * a reviewed change adds it here. No `node:crypto`: crypto goes through @4thtech-io/crypto on
 * @noble/* and @hpke/core (I-8).
 *
 * Added by M1-11a-b (reviewed with that S2 PR), when `agentlink mcp` started serving the local
 * approval UI (08 §1): `node:http` for the approval server on localhost (@4thtech-io/node
 * approval-server.ts). `node:child_process` stays out of this list: see BUNDLE_BUILTIN_NAMED.
 */
export const BUNDLE_BUILTINS = [
  'node:dns',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:os',
  'node:path',
  'node:process',
  'node:readline/promises',
  'node:tls',
  'node:tty',
  'node:util',
];
/**
 * Node built-ins the bundle may import only as the named bindings listed, in static `import { … }`
 * declarations (no default, namespace or bare import, no re-export, no `import()`). M1-11a-b: the
 * local approval UI's OS browser opener and notifier (@4thtech-io/node approval-os.ts) run a fixed
 * program with fixed arguments through `execFile` (no shell); `spawn`, `exec`, `fork` and the rest
 * stay findings.
 */
export const BUNDLE_BUILTIN_NAMED = Object.freeze({
  'node:child_process': Object.freeze(['execFile']),
});

/** Names that load a module without an import declaration (IR-M1-9c-c-1 L1). */
const LOADER_NAMES = new Set(['require', 'createRequire', 'getBuiltinModule']);
/** Globals whose computed (non-literal) member access could reach a loader by a built-up name. */
const LOADER_HOSTS = new Set(['globalThis', 'global', 'self', 'window', 'module', 'process']);
/**
 * Computed global accesses that are reviewed and allowed, by their exact source text. Fails closed:
 * a renamed or new site is a finding until it is reviewed and listed here.
 */
export const COMPUTED_GLOBAL_EXCEPTIONS = [
  // packages/core/src/invite-link.ts `codec(kind)`: `kind` is typed
  // 'CompressionStream' | 'DecompressionStream' and both call sites pass a literal (04 §3.6).
  'globalThis[kind]',
];

/** The package name of a bare specifier (`@scope/name` or `name`). */
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every package banned from the stdio path: the SDK's non-stdio dependencies plus D-76's list. */
export function bannedPackages() {
  const sdkManifest = JSON.parse(
    readFileSync(join(packageDir, 'node_modules', SDK, 'package.json'), 'utf8'),
  );
  const sdkDeps = Object.keys(sdkManifest.dependencies ?? {});
  return new Set([
    ...sdkDeps.filter((name) => !STDIO_PACKAGES.includes(name)),
    ...CRYPTO_TRANSITIVE,
  ]);
}

/** A short, single-line excerpt of `source` for a finding. */
function excerpt(source, node) {
  return source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80);
}

/** The static name of a member expression's property, or undefined when it is computed. */
function memberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal') return String(node.property.value);
  return undefined;
}

/**
 * Every import specifier of an ESM source, read from its AST (comments and string contents never
 * count), plus the `import(…)` and `require(…)` calls that cannot be read statically and every
 * loader access: a `require`, `createRequire` or `getBuiltinModule` reference (bare or as a member),
 * `import.meta.resolve`, and a computed member access with a built-up name on a global such as
 * `globalThis[…]` (IR-M1-9c-c-1 L1, L2).
 */
export function extractImports(source) {
  const specifiers = new Set();
  const unreadable = [];
  const loader = new Set();
  /** BUNDLE_BUILTIN_NAMED built-ins imported in any other form than their listed named bindings. */
  const misused = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const isModuleDeclaration =
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration';
    if (isModuleDeclaration && node.source?.type === 'Literal') {
      specifiers.add(node.source.value);
      const allowed = BUNDLE_BUILTIN_NAMED[node.source.value];
      if (allowed !== undefined) {
        const named =
          node.type === 'ImportDeclaration' &&
          node.specifiers.length > 0 &&
          node.specifiers.every(
            (s) =>
              s.type === 'ImportSpecifier' &&
              s.imported.type === 'Identifier' &&
              allowed.includes(s.imported.name),
          );
        if (!named) misused.add(node.source.value);
      }
    }
    if (node.type === 'ImportExpression') {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifiers.add(node.source.value);
        if (BUNDLE_BUILTIN_NAMED[node.source.value] !== undefined) misused.add(node.source.value);
      } else {
        unreadable.push(excerpt(source, node));
      }
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      unreadable.push(excerpt(source, node));
    } else if (node.type === 'Identifier' && LOADER_NAMES.has(node.name)) {
      loader.add(node.name);
    }
    if (node.type === 'MemberExpression') {
      const name = memberName(node);
      const host = node.object.type === 'Identifier' ? node.object.name : undefined;
      if (name !== undefined && LOADER_NAMES.has(name)) loader.add(excerpt(source, node));
      if (name === 'resolve' && node.object.type === 'MetaProperty') {
        loader.add(excerpt(source, node));
      }
      if (name === undefined && host !== undefined && LOADER_HOSTS.has(host)) {
        const text = excerpt(source, node);
        if (!COMPUTED_GLOBAL_EXCEPTIONS.includes(text)) loader.add(text);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') visit(child);
    }
  };
  visit(parseAst(source));
  return {
    specifiers: [...specifiers].sort(),
    unreadable,
    loader: [...loader].sort(),
    misused: [...misused].sort(),
  };
}

/** Findings for the loader accesses and unreadable imports of one extraction. */
function loaderFindings({ unreadable, loader }) {
  return [
    ...unreadable.map((call) => `${call}: not a static import; imports must be literal`),
    ...loader.map((access) => `loader access: ${access} (loads a module without an import)`),
  ];
}

/** The findings for the published bundle `source`, given the declared runtime dependencies. */
export function checkBundleSource(source, dependencies, banned) {
  const findings = [];
  const extracted = extractImports(source);
  const { specifiers } = extracted;
  findings.push(...loaderFindings(extracted));
  for (const specifier of specifiers) {
    const quoted = JSON.stringify(specifier);
    // The bundler writes every Node built-in with the `node:` prefix; a bare `fs` is a finding.
    if (specifier.startsWith('node:')) {
      const namedOnly =
        Object.hasOwn(BUNDLE_BUILTIN_NAMED, specifier) && !extracted.misused.includes(specifier);
      if (!BUNDLE_BUILTINS.includes(specifier) && !namedOnly) {
        findings.push(`${quoted}: Node built-in outside the bundle allowlist (BUNDLE_BUILTINS)`);
      }
      continue;
    }
    if (/^[./]|^[A-Za-z]:[\\/]/.test(specifier)) {
      findings.push(`${quoted}: relative or absolute import; the bundle must be one file`);
      continue;
    }
    const name = packageName(specifier);
    if (banned.has(name)) {
      findings.push(`${quoted}: banned on the stdio path (D-76: SDK HTTP, OAuth or crypto code)`);
    } else if (name.startsWith('@4thtech-io/')) {
      findings.push(`${quoted}: a workspace package must be bundled, not imported`);
    } else if (!Object.hasOwn(dependencies, name)) {
      findings.push(`${quoted}: not a declared runtime dependency of apps/cli/package.json`);
    } else if (name === SDK && !SDK_ENTRIES.includes(specifier)) {
      findings.push(`${quoted}: SDK subpath outside the stdio allowlist (SDK_ENTRIES)`);
    }
  }
  return { findings, specifiers };
}

/** The Worker resolve conditions (workerd first), as the cloud agent will bundle packages/mcp-tools. */
const WORKER_CONDITIONS = ['workerd', 'worker', 'browser', 'import', 'module', 'default'];
/** The id prefix Vite gives a Node built-in in a non-Node build. */
const BROWSER_EXTERNAL = '__vite-browser-external';

/**
 * Third-party code that may reach a Node built-in in the neutral bundle: only a DYNAMIC import, only
 * from the named package, only of the named built-in. Each entry is a guarded runtime fallback that
 * a Worker never takes. First-party code (packages/mcp-tools and the workspace packages) has no exception.
 */
export const NEUTRAL_EXCEPTIONS = [
  // `await import("crypto")` inside try/catch, reached only when `globalThis.crypto` is missing
  // (Node <= 18); Workers and Node 22+ have Web Crypto. @hpke/common is part of the allowlisted
  // @hpke/core (AGENTS.md crypto allowlist).
  { package: '@hpke/common', specifier: 'crypto' },
];

/** The package a node_modules file belongs to (its last node_modules segment), or undefined. */
export function packageOfFile(file) {
  const path = file.replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  return packageName(path.slice(at + '/node_modules/'.length));
}

/** True when a dynamic import of `source` from `importer` is one of NEUTRAL_EXCEPTIONS. */
export function isNeutralException(source, importer, kind) {
  if (kind !== 'dynamic-import' || importer === undefined) return false;
  const owner = packageOfFile(importer);
  return NEUTRAL_EXCEPTIONS.some((e) => e.package === owner && e.specifier === source);
}

/** Bundles `entry` for a neutral platform with nothing external; returns the findings. */
export async function checkToolsEntry(entry, banned) {
  const findings = new Set();
  const where = (importer) =>
    importer === undefined ? '' : ` (imported by ${importer.replace(packageDir, '')})`;
  const flag = (source) => {
    const quoted = JSON.stringify(source);
    if (source.startsWith('node:')) return `${quoted}: Node built-in`;
    const name = packageName(source);
    if (name === '@4thtech-io/node') return `${quoted}: the Node runtime package`;
    if (name === SDK) return `${quoted}: the MCP SDK belongs to src/mcp/`;
    if (banned.has(name)) return `${quoted}: banned (D-76)`;
    return undefined;
  };
  const result = await build({
    configFile: false,
    root: packageDir,
    logLevel: 'silent',
    publicDir: false,
    envDir: false,
    resolve: { conditions: WORKER_CONDITIONS, mainFields: ['browser', 'module', 'main'] },
    plugins: [
      {
        name: 'agentlink-neutral-fence',
        enforce: 'pre',
        async resolveId(source, importer, options) {
          if (isNeutralException(source, importer, options?.kind)) {
            return { id: source, external: true };
          }
          let finding = flag(source);
          if (finding === undefined) {
            // A bare built-in (`path`, `crypto`): Vite resolves it to its browser-external stub.
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            if (resolved?.id.startsWith(BROWSER_EXTERNAL) !== true) return resolved;
            finding = `${JSON.stringify(source)}: Node built-in`;
          }
          findings.add(`${finding}${where(importer)}`);
          // Kept external so every finding of the graph is collected in one run.
          return { id: source, external: true };
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      emptyOutDir: false,
      modulePreload: false,
      reportCompressedSize: false,
      target: 'es2022',
      rolldownOptions: {
        input: entry,
        platform: 'neutral',
        // Keep the entry's exports: an app build would tree-shake packages/mcp-tools to nothing, and the
        // output scan below would then see an empty chunk.
        preserveEntrySignatures: 'strict',
        output: { format: 'es', codeSplitting: false },
      },
    },
  });
  // IR-M1-9c-c-1 L2: the output chunk itself may hold no loader access and no unreadable import(),
  // whatever code in the graph produced it. Literal imports there are the externals flagged above or
  // NEUTRAL_EXCEPTIONS.
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  for (const chunk of outputs.filter((o) => o.type === 'chunk')) {
    for (const finding of loaderFindings(extractImports(chunk.code))) {
      findings.add(`output: ${finding}`);
    }
  }
  return [...findings].sort();
}

async function main() {
  const { values } = parseArgs({
    options: {
      bundle: { type: 'string', default: join(packageDir, 'dist', 'agentlink.js') },
      'tools-entry': {
        type: 'string',
        default: join(packageDir, '..', '..', 'packages', 'mcp-tools', 'src', 'index.ts'),
      },
      'skip-bundle': { type: 'boolean', default: false },
      'skip-tools': { type: 'boolean', default: false },
    },
  });
  const banned = bannedPackages();
  const findings = [];
  const ok = [];
  if (!values['skip-bundle']) {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const result = checkBundleSource(
      readFileSync(resolve(values.bundle), 'utf8'),
      manifest.dependencies ?? {},
      banned,
    );
    findings.push(...result.findings.map((f) => `published bundle: ${f}`));
    if (result.findings.length === 0) {
      ok.push(`bundle-check: published bundle ok (${result.specifiers.length} imports checked)`);
    }
  }
  if (!values['skip-tools']) {
    const toolFindings = await checkToolsEntry(resolve(values['tools-entry']), banned);
    findings.push(
      ...toolFindings.map((f) =>
        f.startsWith('output: ')
          ? `packages/mcp-tools neutral bundle ${f}`
          : `packages/mcp-tools neutral bundle: ${f}`,
      ),
    );
    if (toolFindings.length === 0) ok.push('bundle-check: packages/mcp-tools neutral bundle ok');
  }
  if (ok.length > 0) process.stdout.write(`${ok.join('\n')}\n`);
  if (findings.length > 0) {
    process.stderr.write(`${findings.map((f) => `bundle-check: ${f}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `bundle-check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
