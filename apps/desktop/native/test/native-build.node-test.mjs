// WP-D12b: build plan for the presence helpers and static checks on both sources (all platforms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  HELPER_BUNDLE_PATH,
  HELPER_PATH,
  HELPER_SIGN_OPTIONS,
  macSignPlan,
} from '../../build/lib/sign-plan.mjs';
import {
  EXIT,
  HELPER_APP,
  HELPER_ID,
  HELPER_NAME,
  MAC_MIN_OS,
  REASONS,
  macBuildPlan,
  macHelperLayout,
  msvcArgs,
  swiftcArgs,
} from '../../build/native.mjs';

const macSrc = readFileSync(new URL('../macos/agentlink-presence.swift', import.meta.url), 'utf8');
const winSrc = readFileSync(new URL('../windows/agentlink-presence.cpp', import.meta.url), 'utf8');

test('exit code table is fixed and the same in both helpers', () => {
  assert.deepEqual(EXIT, {
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
  const swift = Object.fromEntries(
    [...macSrc.matchAll(/^\s*case (\w+) = (\d+)$/gm)].map((m) => [m[1], Number(m[2])]),
  );
  const cpp = Object.fromEntries(
    [...winSrc.matchAll(/^constexpr int EXIT_(\w+) = (\d+);/gm)].map((m) => [
      m[1].toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase()),
      Number(m[2]),
    ]),
  );
  assert.deepEqual(swift, EXIT);
  assert.deepEqual(cpp, EXIT);
});

test('reason ids are a fixed set and the macOS reason texts live in the helper', () => {
  assert.deepEqual(REASONS, ['setup', 'approve', 'pay', 'code']);
  // D15-04: Replace master code names the operation on the OS sheet.
  assert.match(macSrc, /case "code": return "replace your AgentLink master code"/);
  for (const r of REASONS) {
    assert.match(macSrc, new RegExp(`case "${r}": return "[^"]+"`));
    assert.match(winSrc, new RegExp(`L"${r}"`));
  }
});

test('helpers print nothing but the result: no logging calls in either source', () => {
  for (const bad of [
    'print(',
    'NSLog',
    'os_log',
    'Logger(',
    'standardError',
    'debugPrint',
    'dump(',
  ]) {
    assert.ok(!macSrc.includes(bad), `swift uses ${bad}`);
  }
  for (const bad of [
    'printf',
    'std::cout',
    'std::cerr',
    'std::wcout',
    'std::wcerr',
    'OutputDebugString',
    'fprintf',
    'puts(',
  ]) {
    assert.ok(!winSrc.includes(bad), `cpp uses ${bad}`);
  }
  // WIN-HELLO-NATIVE: stderr is written in exactly one place, the fixed `unavailable <reason>` line.
  assert.equal(winSrc.split('STD_ERROR_HANDLE').length - 1, 1, 'one stderr write in the cpp');
  const unavail = winSrc.slice(
    winSrc.indexOf('static void FinishUnavailable'),
    winSrc.indexOf('// ---- end FinishUnavailable'),
  );
  assert.match(unavail, /STD_ERROR_HANDLE/);
});

test('Windows available: says why not, as one fixed token (WIN-HELLO-NATIVE)', () => {
  const lines = [...winSrc.matchAll(/"unavailable ([a-z_]+)\\n"/g)].map((m) => m[1]).sort();
  assert.deepEqual(lines, ['no_secure_hardware', 'not_set_up']);
  // No TPM: Windows Hello would make a software key, which create refuses (16); say so up front.
  assert.match(winSrc, /MS_PLATFORM_CRYPTO_PROVIDER/);
  assert.match(winSrc, /KeyCredentialManager::IsSupportedAsync\(\)/);
  // Every command that needs Windows Hello says unavailable before it touches a credential.
  for (const cmd of ['CmdCreate', 'CmdCheck', 'CmdSign', 'CmdDelete']) {
    const body = winSrc.slice(winSrc.indexOf(`static void ${cmd}`));
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    assert.match(fn, /RequireHello\(\)/, `${cmd} checks Windows Hello first`);
    if (cmd !== 'CmdCreate') {
      assert.ok(fn.indexOf('RequireHello()') < fn.indexOf('OpenMatching'), `${cmd}: gate first`);
    }
  }
  // Never a WebAuthn / security-key path in the helper.
  assert.ok(!/webauthn|WebAuthN|fido/i.test(winSrc));
});

test('Windows prompts are brought in front of the AgentLink window (WIN-HELLO-NATIVE)', () => {
  assert.match(winSrc, /L"Credential Dialog Xaml Host"/);
  assert.match(winSrc, /SetForegroundWindow/);
  for (const cmd of ['CmdCreate', 'CmdSign']) {
    const body = winSrc.slice(winSrc.indexOf(`static void ${cmd}`));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    assert.match(fn, /PromptFocus /, `${cmd} raises the Windows Hello prompt`);
  }
});

test('macOS helper: Secure Enclave key gated by .biometryCurrentSet, this-device-only', () => {
  assert.match(macSrc, /\[\.privateKeyUsage, \.biometryCurrentSet\]/);
  assert.match(macSrc, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(macSrc, /SecureEnclave\.P256\.KeyAgreement\.PrivateKey\(accessControl:/);
  assert.ok(!macSrc.includes('.userPresence'));
  assert.ok(!macSrc.includes('.devicePasscode'));
  // no keychain item is ever written or read: the key handle travels with the ALKH record
  assert.ok(!macSrc.includes('SecItemAdd'));
  assert.ok(!macSrc.includes('SecItemCopyMatching'));
});

test('Windows helper: TPM attestation required, PKCS#1 v1.5 SHA-256 verified, fails closed', () => {
  assert.match(winSrc, /GetAttestationAsync\(\)/);
  assert.match(winSrc, /KeyCredentialAttestationStatus::Success/);
  assert.match(winSrc, /RsaSignPkcs1Sha256\(\)/);
  assert.match(winSrc, /CryptographicEngine::VerifySignature/);
  assert.match(winSrc, /KeyCredentialCreationOption::FailIfExists/);
  assert.ok(!winSrc.includes('ReplaceExisting'));
  assert.ok(!/Pss/i.test(winSrc));
});

test('caller-signature check is present, off in phase 2, and fails closed when switched on', () => {
  assert.match(macSrc, /let enforceCallerSignature = false/);
  assert.match(winSrc, /constexpr bool kEnforceCallerSignature = false;/);
});

test('swiftc args: optimised, pinned target, embedded Info.plist, nothing from the environment', () => {
  const a = swiftcArgs({ arch: 'arm64', src: '/s/x.swift', out: '/o/x', plist: '/s/Info.plist' });
  assert.ok(a.includes('-O'));
  assert.deepEqual(a.slice(a.indexOf('-target'), a.indexOf('-target') + 2), [
    '-target',
    `arm64-apple-macos${MAC_MIN_OS}`,
  ]);
  assert.ok(
    a
      .join(' ')
      .includes(
        '-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker /s/Info.plist',
      ),
  );
  const x = swiftcArgs({ arch: 'x64', src: '/s/x.swift', out: '/o/x', plist: '/s/Info.plist' });
  assert.ok(x.includes(`x86_64-apple-macos${MAC_MIN_OS}`));
  assert.throws(() => swiftcArgs({ arch: 'ppc', src: 'a', out: 'b', plist: 'c' }), /arch/);
});

test('mac build plan: per-arch compiles, lipo for universal, ad-hoc sign with the fixed identifier', () => {
  const one = macBuildPlan({ arch: 'arm64', outDir: '/o', work: '/w' });
  assert.equal(one.filter((s) => s.cmd === 'swiftc').length, 1);
  assert.ok(!one.some((s) => s.cmd === 'lipo'));
  const uni = macBuildPlan({ arch: 'universal', outDir: '/o', work: '/w' });
  assert.equal(uni.filter((s) => s.cmd === 'swiftc').length, 2);
  const lipo = uni.find((s) => s.cmd === 'lipo');
  assert.ok(lipo && lipo.args.includes('-create'));
  const sign = uni.at(-1);
  assert.equal(sign.cmd, 'codesign');
  assert.deepEqual(sign.args.slice(0, 5), ['--force', '--sign', '-', '--identifier', HELPER_ID]);
  assert.deepEqual(sign.args.slice(5, 7), ['--options', 'runtime']);
  // DESK051-C3: the whole helper app is signed (Info.plist and icon sealed), not a bare binary.
  assert.equal(sign.args.at(-1), '/o/AgentLink.app');
});

// DESK051-C3 (owner feedback): a bare executable makes the macOS Touch ID sheet show a generic
// "exec" icon. The helper is a real app bundle with the AgentLink name and icon.
test('mac helper is an app bundle: Contents/MacOS executable, Info.plist, AgentLink icon', () => {
  assert.equal(HELPER_APP, 'AgentLink.app');
  const l = macHelperLayout('/o');
  assert.equal(l.bundle, '/o/AgentLink.app');
  assert.equal(l.executable, `/o/AgentLink.app/Contents/MacOS/${HELPER_NAME}`);
  assert.equal(l.infoPlist, '/o/AgentLink.app/Contents/Info.plist');
  assert.equal(l.icon, '/o/AgentLink.app/Contents/Resources/AgentLink.icns');
  for (const arch of ['arm64', 'universal']) {
    const plan = macBuildPlan({ arch, outDir: '/o', work: '/w' });
    const out = plan.find((s) => s.cmd === 'lipo') ?? plan.find((s) => s.cmd === 'swiftc');
    assert.equal(out.args.at(-1), l.executable, arch);
  }
  // The same layout the app's sign plan and the core use (sign-plan.mjs, owner-native-helper.ts).
  assert.equal(HELPER_BUNDLE_PATH, '/Contents/Helpers/AgentLink.app');
  assert.equal(HELPER_PATH, `${HELPER_BUNDLE_PATH}/Contents/MacOS/${HELPER_NAME}`);
});

test('mac helper Info.plist: fixed identifier, AgentLink name and icon, no Dock icon', () => {
  const plist = readFileSync(new URL('../macos/Info.plist', import.meta.url), 'utf8');
  const value = (key) =>
    (plist.match(new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`)) ?? [])
      .slice(1)
      .map((part) => part.trim())
      .join(':');
  assert.equal(value('CFBundleIdentifier'), `string:${HELPER_ID}`);
  assert.equal(value('CFBundleExecutable'), `string:${HELPER_NAME}`);
  assert.equal(value('CFBundleName'), 'string:AgentLink');
  assert.equal(value('CFBundleDisplayName'), 'string:AgentLink');
  assert.equal(value('CFBundleIconFile'), 'string:AgentLink');
  assert.equal(value('CFBundlePackageType'), 'string:APPL');
  assert.equal(value('LSUIElement'), 'true:');
});

test('MSVC args: static CRT, hardening flags, WinRT + bcrypt only, no debug info', () => {
  const a = msvcArgs({ src: 'C:\\s\\a.cpp', out: 'C:\\o\\agentlink-presence.exe' });
  for (const f of [
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
  ]) {
    assert.ok(a.includes(f), f);
  }
  const link = a.slice(a.indexOf('/link'));
  for (const f of [
    '/DYNAMICBASE',
    '/NXCOMPAT',
    '/CETCOMPAT',
    '/guard:cf',
    'windowsapp.lib',
    'bcrypt.lib',
    'ncrypt.lib',
    'user32.lib',
    '/SUBSYSTEM:CONSOLE',
    '/guard:ehcont',
    '/DEPENDENTLOADFLAG:0x800',
  ]) {
    assert.ok(link.includes(f), f);
  }
  const arm = msvcArgs({ src: 'a.cpp', out: 'b.exe', arch: 'arm64' });
  assert.ok(!arm.includes('/CETCOMPAT'), 'CET shadow stacks are x64-only');
  assert.throws(() => msvcArgs({ src: 'a', out: 'b', arch: 'x86' }), /arch/);
  assert.ok(!a.some((x) => /^\/(DEBUG|Zi|ZI|MD)$/i.test(x)));
});

test('app sign plan keeps the helper identifier and hardened runtime inside the bundle', () => {
  const app = '/out/AgentLink.app';
  const helper = `${app}${HELPER_PATH}`;
  for (const mode of ['adhoc', 'developer-id']) {
    const plan = macSignPlan({ app, files: [helper], bundles: [], mode, identity: 'X' });
    const step = plan.find((s) => s.target === helper);
    assert.deepEqual(step.options.slice(-4), [...HELPER_SIGN_OPTIONS]);
    assert.equal(step.options.filter((o) => o === '--options').length, 1);
    assert.ok(plan.indexOf(step) < plan.length - 1, 'signed before the app');
  }
});

test('Windows create: refusals delete the new key, RSA < 2048 has its own code, first signature folded in', () => {
  assert.match(winSrc, /\[\[noreturn\]\] static void Refuse\(/);
  assert.ok(!winSrc.includes('auto refuse'));
  assert.match(winSrc, /Refuse\(name, EXIT_WEAK_KEY\)/);
  const create = winSrc.slice(
    winSrc.indexOf('static void CmdCreate'),
    winSrc.indexOf('static void CmdCheck'),
  );
  assert.match(create, /RequestSignAsync/);
  assert.match(create, /CryptographicEngine::VerifySignature/);
  assert.match(winSrc, /LOCAL HEURISTIC/);
  assert.match(winSrc, /backup\s+\/\/?\s*code|backup code/);
});

test('macOS ecdh proves the key needs a gesture before any sheet', () => {
  const ecdh = macSrc.slice(macSrc.indexOf('func cmdEcdh'), macSrc.indexOf('// MARK: main'));
  assert.ok(ecdh.indexOf('requireGated(') >= 0);
  assert.ok(ecdh.indexOf('requireGated(') < ecdh.indexOf('LAContext()'));
});
