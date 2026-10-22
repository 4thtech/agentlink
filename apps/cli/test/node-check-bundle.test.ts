// M1-9zc: nothing native loads before the Node.js version check (M1-9y). The published bundle
// dist/agentlink.js hoists every static import of the program to the top of the file, so a static
// import of a native module, or of the main program, would run on an old Node before
// `checkNodeVersion()` and crash there instead of printing one clear line. Two guards:
//
// - static: in the bundle text, no static import names a native module (one documented exception),
//   and the call into the main program comes after the check;
// - runtime: the bundle run under a faked old Node exits 1 with the version line, and the module
//   trace shows no native module resolved or loaded.
//
// Mutated copies of the bundle prove both guards fail when a native import or the main program is
// moved ahead of the check. Needs the build: CI runs `pnpm build` before `pnpm test`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bundlePath = fileURLToPath(new URL('../dist/agentlink.js', import.meta.url));
const hooks = new URL('./fixtures/module-trace-hooks.mjs', import.meta.url).href;
const oldNode = new URL('./fixtures/old-node-preload.mjs', import.meta.url).href;
const work = mkdtempSync(join(tmpdir(), 'agentlink-node-check-bundle-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * Native packages: a static import of one is a violation. better-sqlite3 is the one native package
 * imported statically (the import loads JavaScript only; its binding opens in the first
 * `new Database`, after the check), so it is not listed. The runtime guard still fails when any
 * native addon (.node file) loads before the check.
 */
const NATIVE_PACKAGES = [/^@napi-rs\//];

const CHECK_CALL = /^var \w+ = checkNodeVersion\(\);$/m;

/** What is wrong with the order of things in a bundle; empty when it is right. */
function orderViolations(source: string): string[] {
  const check = CHECK_CALL.exec(source);
  if (check === null) return ['no top-level checkNodeVersion() call'];
  const problems: string[] = [];
  for (const match of source.matchAll(/^import\s[^;]*?"([^"]+)";$/gm)) {
    const specifier = match[1] ?? '';
    if (NATIVE_PACKAGES.some((pattern) => pattern.test(specifier))) {
      problems.push(`static import of native module ${specifier}`);
    }
  }
  for (const match of source.matchAll(/\binit_main\(\)/g)) {
    if (match.index < check.index) {
      problems.push('main program loads before the version check');
      break;
    }
  }
  return problems;
}

let bundle = '';
beforeAll(() => {
  if (!existsSync(bundlePath)) {
    throw new Error(`${bundlePath} is missing: run \`pnpm build\` first (CI builds before tests).`);
  }
  bundle = readFileSync(bundlePath, 'utf8');
});

interface OldNodeRun {
  readonly code: number | null;
  readonly stderr: string;
  readonly loaded: string;
}

/** Runs `file` as a process that reports Node 20, tracing every module it resolves or loads. */
function runOnOldNode(name: string, file: string): OldNodeRun {
  const traceFile = join(work, `${name}-trace.txt`);
  writeFileSync(traceFile, '');
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', oldNode, '--experimental-loader', hooks, file, '--version'],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: work,
        USERPROFILE: work,
        AGENTLINK_MODULE_TRACE: traceFile,
        NODE_DEBUG: 'module',
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return {
    code: result.status,
    stderr: result.stderr,
    loaded: `${readFileSync(traceFile, 'utf8')}\n${result.stderr}`,
  };
}

/** A copy of the bundle with `edit` applied, written next to the real one's name in `work`. */
function mutated(name: string, edit: (source: string) => string): { file: string; text: string } {
  const file = join(work, `${name}.mjs`);
  const text = edit(bundle);
  writeFileSync(file, text);
  return { file, text };
}

/** True when the trace shows a native module or addon. */
const nativeLoaded = (trace: string): boolean => /@napi-rs\/keyring|\.node["'\s]/.test(trace);

const withNativeImport = (source: string): string =>
  source.replace('\n', '\nimport "@napi-rs/keyring";\n');

describe('Node version check comes before any native module (M1-9zc)', () => {
  it('the bundle has no native static import and runs the main program after the check', () => {
    expect(orderViolations(bundle)).toEqual([]);
  });

  it('on an old Node it prints the version line, exits 1 and loads no native module', () => {
    const run = runOnOldNode('real', bundlePath);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/Node/);
    expect(nativeLoaded(run.loaded)).toBe(false);
  });

  it('fails when a native import is moved ahead of the check (static guard)', () => {
    const { text } = mutated('native-static', withNativeImport);
    expect(orderViolations(text)).toContain('static import of native module @napi-rs/keyring');
  });

  it('fails when a native import is moved ahead of the check (runtime guard)', () => {
    const { file } = mutated('native-runtime', withNativeImport);
    expect(nativeLoaded(runOnOldNode('native-runtime', file).loaded)).toBe(true);
  });

  it('fails when the main program is moved ahead of the check', () => {
    const { text } = mutated('main-first', (s) =>
      s.replace(CHECK_CALL, (line) => `await init_main();\n${line}`),
    );
    expect(orderViolations(text)).toContain('main program loads before the version check');
  });
});
