#!/usr/bin/env node
// Builds the owner-presence helpers (WP-D12b; contract at the top of each source):
//   macOS:   swiftc (per arch, or universal via lipo) -> ad-hoc signed with a fixed identifier
//   Windows: MSVC cl.exe from a Developer Command Prompt (CI: an MSVC dev-env step); static CRT
//
//   node native.mjs [--arch arm64|x64|universal] [--out dir]
//
// Output: <out>/agentlink-presence (macOS) or <out>\agentlink-presence.exe (Windows). Default out:
// apps/desktop/.cache/native/<platform>-<arch>. Nothing is downloaded; no package scripts run.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './lib/run.mjs';
import { HELPER_SIGN_OPTIONS } from './lib/sign-plan.mjs';

export const HELPER_NAME = 'agentlink-presence';
export { HELPER_ID } from './lib/sign-plan.mjs';
export const MAC_MIN_OS = '13.0';
export const REASONS = Object.freeze(['setup', 'approve', 'pay']);

/** Fixed exit codes, identical in both helpers (checked by test/native-build.test.mjs). */
export const EXIT = Object.freeze({
  ok: 0,
  cancelled: 10,
  failed: 11,
  notInteractive: 12,
  keyUnusable: 13,
  lockout: 14,
  callerRefused: 15,
  notHardware: 16,
  attestationRetry: 17,
  weakKey: 18,
  usage: 64,
  badInput: 65,
  unavailable: 69,
  internalError: 70,
});

const NATIVE_DIR = fileURLToPath(new URL('../native/', import.meta.url));
const MAC_SRC = join(NATIVE_DIR, 'macos', `${HELPER_NAME}.swift`);
const MAC_PLIST = join(NATIVE_DIR, 'macos', 'Info.plist');
const WIN_SRC = join(NATIVE_DIR, 'windows', `${HELPER_NAME}.cpp`);
const SWIFT_ARCH = { arm64: 'arm64', x64: 'x86_64' };

export function swiftcArgs({ arch, src, out, plist }) {
  const a = SWIFT_ARCH[arch];
  if (!a) throw new Error(`Unknown arch ${arch}.`);
  return [
    '-O',
    '-swift-version',
    '5',
    '-target',
    `${a}-apple-macos${MAC_MIN_OS}`,
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    plist,
    src,
    '-o',
    out,
  ];
}

/** Steps [{cmd, args}] for macOS; pure so the plan is testable on any OS. */
export function macBuildPlan({ arch, outDir, work }) {
  const out = join(outDir, HELPER_NAME);
  const archs = arch === 'universal' ? ['arm64', 'x64'] : [arch];
  if (!archs.every((a) => SWIFT_ARCH[a])) throw new Error(`Unknown arch ${arch}.`);
  const steps = [];
  if (archs.length === 1) {
    steps.push({
      cmd: 'swiftc',
      args: swiftcArgs({ arch: archs[0], src: MAC_SRC, out, plist: MAC_PLIST }),
    });
  } else {
    const slices = archs.map((a) => join(work, `${HELPER_NAME}-${a}`));
    archs.forEach((a, i) =>
      steps.push({
        cmd: 'swiftc',
        args: swiftcArgs({ arch: a, src: MAC_SRC, out: slices[i], plist: MAC_PLIST }),
      }),
    );
    steps.push({ cmd: 'lipo', args: ['-create', ...slices, '-output', out] });
  }
  // Ad-hoc today (signing hooks off), fixed identifier, hardened runtime on; the app's sign plan
  // re-signs it inside the bundle with the same options (sign-plan.mjs HELPER_SIGN_OPTIONS).
  steps.push({ cmd: 'codesign', args: ['--force', '--sign', '-', ...HELPER_SIGN_OPTIONS, out] });
  return steps;
}

/** cl.exe args. arch: the target of the Developer Command Prompt (CET shadow stacks are x64-only). */
export function msvcArgs({ src, out, arch = 'x64' }) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unknown arch ${arch}.`);
  return [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/permissive-',
    '/O2',
    '/MT',
    '/GS',
    '/guard:cf',
    '/sdl',
    '/W4',
    '/WX',
    '/guard:ehcont',
    '/DUNICODE',
    '/D_UNICODE',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    src,
    `/Fe:${out}`,
    `/Fo:${out}.obj`,
    '/link',
    '/SUBSYSTEM:CONSOLE',
    '/DYNAMICBASE',
    '/NXCOMPAT',
    ...(arch === 'x64' ? ['/CETCOMPAT'] : []),
    '/guard:cf',
    '/guard:ehcont',
    // LOAD_LIBRARY_SEARCH_SYSTEM32: delay-loaded and dependent DLLs only from System32 (no planting)
    '/DEPENDENTLOADFLAG:0x800',
    'windowsapp.lib',
    'bcrypt.lib',
  ];
}

function runStep({ cmd, args }) {
  const r = capture(cmd, args);
  if (r.code !== 0) {
    throw new Error(`${cmd} exited with ${r.code}.\n${r.stdout}${r.stderr}`.trimEnd());
  }
}

/** Builds the macOS helper; returns its path. */
export function buildMacHelper({ arch = 'universal', outDir }) {
  if (process.platform !== 'darwin') throw new Error('The macOS helper builds on macOS only.');
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'al-native-'));
  try {
    for (const step of macBuildPlan({ arch, outDir, work })) runStep(step);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return join(outDir, HELPER_NAME);
}

/** Builds the Windows helper with cl.exe from the current MSVC environment; returns its path. */
export function buildWinHelper({ outDir, arch = 'x64' }) {
  if (process.platform !== 'win32') throw new Error('The Windows helper builds on Windows only.');
  if (capture('where', ['cl.exe']).code !== 0) {
    throw new Error('cl.exe not found: run from a Visual Studio Developer Command Prompt.');
  }
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${HELPER_NAME}.exe`);
  runStep({ cmd: 'cl.exe', args: msvcArgs({ src: WIN_SRC, out, arch }) });
  rmSync(`${out}.obj`, { force: true });
  return out;
}

/** Parses a macOS record (hex line) into its parts. Used by tests and by WP-D12c. */
export function parseMacRecord(hexLine) {
  const hex = hexLine.endsWith('\n') ? hexLine.slice(0, -1) : hexLine;
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('Not a record.');
  const b = Buffer.from(hex, 'hex');
  if (b[0] !== 0x01 || b.length < 3) throw new Error('Unknown record version.');
  const len = b.readUInt16BE(1);
  if (len < 1 || len > 1024 || b.length !== 3 + len + 130) throw new Error('Bad record length.');
  return {
    version: 1,
    handle: b.subarray(3, 3 + len),
    sePub: b.subarray(3 + len, 3 + len + 65),
    peerPub: b.subarray(3 + len + 65),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { parseArgs } = await import('./lib/run.mjs');
  const { CACHE_DIR } = await import('./lib/stage.mjs');
  const args = parseArgs(process.argv.slice(2), { arch: 'v', out: 'v' });
  if (process.platform === 'darwin') {
    const arch = args.arch ?? 'universal';
    const outDir = resolve(args.out ?? join(CACHE_DIR, 'native', `darwin-${arch}`));
    console.log(buildMacHelper({ arch, outDir }));
  } else if (process.platform === 'win32') {
    // --arch must match the Developer Command Prompt's target (it sets the folder and /CETCOMPAT).
    const arch = args.arch ?? process.arch;
    const outDir = resolve(args.out ?? join(CACHE_DIR, 'native', `win32-${arch}`));
    console.log(buildWinHelper({ outDir, arch }));
  } else {
    throw new Error('Presence helpers exist for macOS and Windows only.');
  }
}
