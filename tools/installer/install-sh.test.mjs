// INSTALLER-1 (owner Decision 58): installer/install.sh, the one-line installer for macOS and Linux.
// Every run is sandboxed: HOME is a temporary folder and PATH holds only the tools the script needs
// plus fakes. The fake `curl` serves files from a folder (no network), the fake `uname` picks the
// platform, and a fake `node` stands in for a Node.js already on the computer. The Node.js archive is
// a tiny fixture, so the tests run a copy of the script whose pinned linux-x64 hash is the fixture's;
// the real pinned hashes are checked against nodejs.org's signed SHASUMS256.txt lines below.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NODE_VERSION, SIGNED_SHASUMS, findTool, removeAll } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(root, 'installer/install.sh');
const temps = [];
const temp = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `agentlink-installer-${name}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => removeAll(temps));

const ARCHIVE = `node-v${NODE_VERSION}-linux-x64.tar.gz`;
const TOOLS = [
  'cat',
  'chmod',
  'cut',
  'dirname',
  'grep',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'sed',
  'awk',
  'tar',
  'gzip',
  'sha256sum',
  'shasum',
  'perl', // shasum on macOS is a Perl script
];

const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A sandbox: tools, fakes, the served files and a HOME. */
function sandbox() {
  const dir = temp('sandbox');
  const bin = join(dir, 'bin');
  const serve = join(dir, 'serve');
  const home = join(dir, 'home');
  for (const d of [bin, serve, home]) mkdirSync(d);
  for (const tool of TOOLS) {
    const real = findTool(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  exe(
    join(bin, 'uname'),
    'case "$1" in -s) echo "${MOCK_OS:-Linux}" ;; -m) echo "${MOCK_ARCH:-x86_64}" ;; *) echo "${MOCK_OS:-Linux}" ;; esac',
  );
  // curl -fsSL ... -o <file> <url>: copies serve/<basename of url>, or fails like curl -f.
  exe(
    join(bin, 'curl'),
    [
      'out="" url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto|--retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
      'echo "$url" >> "$MOCK_LOG"',
      'f="$MOCK_SERVE/${url##*/}"',
      '[ -f "$f" ] || { echo "curl: (22) 404" >&2; exit 22; }',
      'cat "$f" > "$out"',
    ].join('\n'),
  );

  // The fixture Node.js: bin/node prints the version, bin/npx records its arguments.
  const build = join(dir, 'build');
  const nodeDir = join(build, `node-v${NODE_VERSION}-linux-x64/bin`);
  mkdirSync(nodeDir, { recursive: true });
  exe(join(nodeDir, 'node'), `echo ${NODE_VERSION}`);
  exe(join(nodeDir, 'npx'), 'echo "npx($0) $*" >> "$MOCK_LOG"');
  execFileSync('tar', [
    '-czf',
    join(serve, ARCHIVE),
    '-C',
    build,
    `node-v${NODE_VERSION}-linux-x64`,
  ]);
  const sha = createHash('sha256')
    .update(readFileSync(join(serve, ARCHIVE)))
    .digest('hex');
  writeFileSync(
    join(serve, 'SHASUMS256.txt'),
    `${'0'.repeat(64)}  other.tar.gz\n${sha}  ${ARCHIVE}\n`,
  );

  // The script under test, with the fixture's hash pinned for linux-x64 (only that line differs).
  const real = readFileSync(SCRIPT, 'utf8');
  const pinnedLine = /(linux-x64\) echo )[0-9a-f]{64}/;
  expect(real).toMatch(pinnedLine);
  const script = join(dir, 'install.sh');
  writeFileSync(script, real.replace(pinnedLine, `$1${sha}`));

  const log = join(dir, 'log');
  writeFileSync(log, '');
  return { dir, bin, serve, home, script, log, sha };
}

/** A fake Node.js already on PATH: its own folder with node (printing `version`) and npx. */
function existingNode(box, version) {
  const dir = join(box.dir, `user-node-${version}`);
  mkdirSync(dir);
  exe(join(dir, 'node'), `echo ${version}`);
  exe(join(dir, 'npx'), 'echo "npx($0) $*" >> "$MOCK_LOG"');
  return dir;
}

function run(box, args = [], { script = box.script, env = {}, shell = 'sh', pathExtra = [] } = {}) {
  const result = spawnSync(findTool(shell) ?? shell, [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: [...pathExtra, box.bin].join(':'),
      HOME: box.home,
      SHELL: '/bin/zsh',
      TMPDIR: box.dir,
      MOCK_SERVE: box.serve,
      MOCK_LOG: box.log,
      ...env,
    },
  });
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    log: readFileSync(box.log, 'utf8'),
  };
}

const runtimeDir = (box) => join(box.home, `.agentlink/runtime/node-v${NODE_VERSION}-linux-x64`);
const launcher = (box) => join(box.home, '.agentlink/bin/agentlink');

/** Runs the installed launcher; returns what the fake npx recorded. */
function launch(box, args = []) {
  writeFileSync(box.log, '');
  execFileSync(launcher(box), args, { env: { PATH: box.bin, MOCK_LOG: box.log } });
  return readFileSync(box.log, 'utf8');
}

const shells = ['sh', ...(findTool('dash') ? ['dash'] : [])];

describe('the launcher against a hostile .npmrc in the folder it is started from (real npm)', () => {
  const npm = join(dirname(process.execPath), 'npm');
  // The npm options the launcher passes, read from the launcher itself (quotes removed).
  function launcherOptions() {
    const box = sandbox();
    expect(run(box).code).toBe(0);
    const exec = readFileSync(launcher(box), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('exec '));
    const options = exec
      .split(' ')
      .filter((w) => w.startsWith('--'))
      .map((w) => w.replaceAll("'", ''));
    return { box, options };
  }
  function npmConfig(box, cwd, options, key) {
    return execFileSync(npm, [...options, 'config', 'get', key], {
      cwd,
      encoding: 'utf8',
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: box.home },
    }).trim();
  }

  it('ignores its node-options, https-proxy and strict-ssl (the launcher pins --prefix)', () => {
    if (!existsSync(npm)) {
      expect(process.env.CI, 'npm is required on CI').toBeFalsy();
      return;
    }
    const { box, options } = launcherOptions();
    expect(options[0]).toBe(`--prefix=${box.home}/.agentlink`);
    const folder = join(box.dir, 'project');
    mkdirSync(folder);
    const inject = join(box.dir, 'inj.cjs');
    writeFileSync(
      join(folder, '.npmrc'),
      `node-options=--require ${inject}\nhttps-proxy=http://127.0.0.1:9/\nstrict-ssl=false\n`,
    );
    // Control: without the launcher's options npm takes all three from the folder.
    expect(npmConfig(box, folder, [], 'node-options')).toContain(inject);
    expect(npmConfig(box, folder, [], 'strict-ssl')).toBe('false');
    // With them, none.
    expect(npmConfig(box, folder, options, 'node-options')).not.toContain(inject);
    expect(npmConfig(box, folder, options, 'https-proxy')).not.toContain('127.0.0.1');
    expect(npmConfig(box, folder, options, 'strict-ssl')).toBe('true');
    expect(npmConfig(box, folder, options, 'registry')).toBe('https://registry.npmjs.org/');
  });
});

describe.each(shells)('install.sh under %s', (shell) => {
  it('downloads Node.js when there is none, checks it, installs the agentlink command', () => {
    const box = sandbox();
    const r = run(box, [], { shell });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain(`https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}`);
    expect(r.log).toContain(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
    expect(r.out).toMatch(/matches nodejs\.org and this installer/);
    expect(existsSync(join(runtimeDir(box), 'bin/node'))).toBe(true);
    // A new ~/.agentlink is private (it also holds the IDs).
    expect(statSync(join(box.home, '.agentlink')).mode & 0o777).toBe(0o700);
    expect(launch(box, ['ui'])).toBe(
      `npx(${runtimeDir(box)}/bin/npx) -y --prefix=${box.home}/.agentlink --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest ui\n`,
    );
    // Not run from a terminal: it does not start the app, it says how.
    expect(r.out).toContain(`To start it now, run: ${launcher(box)}`);
    expect(r.out).not.toMatch(/Starting AgentLink/);
    for (const profile of ['.profile', '.zshrc']) {
      expect(readFileSync(join(box.home, profile), 'utf8')).toContain(
        'export PATH="$HOME/.agentlink/bin:$PATH" # added by the AgentLink installer',
      );
    }
  });

  it('uses a Node.js 22.14 or newer that is already there, and downloads nothing', () => {
    const box = sandbox();
    const nodeDir = existingNode(box, '22.14.0');
    const r = run(box, [], { shell, pathExtra: [nodeDir] });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Using your Node.js 22.14.0.');
    expect(r.log).toBe('');
    expect(existsSync(join(box.home, '.agentlink/runtime'))).toBe(false);
    expect(launch(box)).toBe(
      `npx(${nodeDir}/npx) -y --prefix=${box.home}/.agentlink --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest\n`,
    );
  });

  it('downloads its own Node.js when the one there is older than 22.14', () => {
    const box = sandbox();
    const nodeDir = existingNode(box, '22.13.1');
    const r = run(box, [], { shell, pathExtra: [nodeDir] });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Your Node\.js 22\.13\.1 is older than 22\.14/);
    expect(r.log).toContain(ARCHIVE);
    expect(launch(box)).toContain(`npx(${runtimeDir(box)}/bin/npx)`);
  });

  it('stops, installing nothing, when the download does not match SHASUMS256.txt', () => {
    const box = sandbox();
    writeFileSync(join(box.serve, 'SHASUMS256.txt'), `${'a'.repeat(64)}  ${ARCHIVE}\n`);
    const r = run(box, [], { shell });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/did not pass its safety check \(SHA-256 mismatch\)/);
    expect(existsSync(join(box.home, '.agentlink/runtime'))).toBe(false);
    expect(existsSync(launcher(box))).toBe(false);
    expect(readdirSync(box.dir).filter((f) => f.startsWith('agentlink-install.'))).toEqual([]);
  });

  it('stops when the download matches SHASUMS256.txt but not the hash pinned in the script', () => {
    const box = sandbox();
    // The unpatched script pins nodejs.org's real hash, which the fixture cannot have.
    const r = run(box, [], { shell, script: SCRIPT });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SHA-256 mismatch/);
    expect(existsSync(launcher(box))).toBe(false);
  });

  it('says plainly when the download fails', () => {
    const box = sandbox();
    writeFileSync(join(box.serve, 'SHASUMS256.txt'), '');
    execFileSync('rm', [join(box.serve, ARCHIVE)]);
    const r = run(box, [], { shell });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Could not download .*Check your internet connection/);
  });

  it('--dry-run prints the plan and changes nothing', () => {
    const box = sandbox();
    const r = run(box, ['--dry-run'], { shell });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /would download https:\/\/nodejs\.org\/dist\/v[\d.]+\/node-v[\d.]+-linux-x64\.tar\.gz/,
    );
    expect(r.out).toContain('Dry run: nothing was changed.');
    expect(r.log).toBe('');
    expect(readdirSync(box.home)).toEqual([]);
  });

  it('is safe to run again (an update): one PATH line, one runtime', () => {
    const box = sandbox();
    expect(run(box, [], { shell }).code).toBe(0);
    const again = run(box, [], { shell });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('already installed');
    const profile = readFileSync(join(box.home, '.zshrc'), 'utf8');
    expect(profile.match(/added by the AgentLink installer/g)).toHaveLength(1);
    expect(readdirSync(join(box.home, '.agentlink/runtime'))).toEqual([
      `node-v${NODE_VERSION}-linux-x64`,
    ]);
  });

  it('--uninstall removes the command, the runtime and the PATH lines, and keeps the IDs', () => {
    const box = sandbox();
    writeFileSync(join(box.home, '.zshrc'), 'alias ll="ls -l"\n');
    expect(run(box, [], { shell }).code).toBe(0);
    mkdirSync(join(box.home, '.agentlink/keystore'));
    writeFileSync(join(box.home, '.agentlink/keystore/id.alks'), 'kept');
    const r = run(box, ['--uninstall'], { shell });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(box.home, '.agentlink/bin'))).toBe(false);
    expect(existsSync(join(box.home, '.agentlink/runtime'))).toBe(false);
    expect(readFileSync(join(box.home, '.agentlink/keystore/id.alks'), 'utf8')).toBe('kept');
    expect(readFileSync(join(box.home, '.zshrc'), 'utf8')).toContain('alias ll="ls -l"');
    expect(readFileSync(join(box.home, '.zshrc'), 'utf8')).not.toMatch(/AgentLink installer/);
    expect(r.out).toMatch(/were kept/);
  });

  it('--uninstall --dry-run changes nothing', () => {
    const box = sandbox();
    expect(run(box, [], { shell }).code).toBe(0);
    const r = run(box, ['--uninstall', '--dry-run'], { shell });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('would run: rm -rf');
    expect(existsSync(launcher(box))).toBe(true);
  });

  it('refuses Windows and unknown processors in plain words', () => {
    const box = sandbox();
    const win = run(box, [], { shell, env: { MOCK_OS: 'MINGW64_NT-10.0' } });
    expect(win.code).toBe(1);
    expect(win.out).toMatch(/On Windows, use install\.ps1/);
    const cpu = run(box, [], { shell, env: { MOCK_ARCH: 'riscv64' } });
    expect(cpu.code).toBe(1);
    expect(cpu.out).toMatch(/processor \(riscv64\) is not supported yet/);
  });

  it('picks the right archive on each supported platform', () => {
    for (const [os, arch, want] of [
      ['Darwin', 'arm64', 'darwin-arm64'],
      ['Darwin', 'x86_64', 'darwin-x64'],
      ['Linux', 'aarch64', 'linux-arm64'],
      ['Linux', 'x86_64', 'linux-x64'],
    ]) {
      const box = sandbox();
      const r = run(box, ['--dry-run'], {
        shell,
        script: SCRIPT,
        env: { MOCK_OS: os, MOCK_ARCH: arch },
      });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`node-v${NODE_VERSION}-${want}.tar.gz`);
      expect(r.out).toContain(SIGNED_SHASUMS[`node-v${NODE_VERSION}-${want}.tar.gz`]);
    }
  });
});

// WP-2 (I-1, I-5, I-6; 08 §4): the one command on the invite page installs AgentLink and opens the
// app on the invite. The link is checked with the patterns of `agentlink join` before anything else
// happens; anything else gets one fixed line, and no part of it is ever printed.
const LONG_LINK = `https://agentlink.4thtech.io/i#${'Ab9_-'.repeat(40)}`;
const SHORT_LINK = `https://agentlink.4thtech.io/i#2.${'a'.repeat(42)}w`;
const REFUSED =
  "AgentLink installer: This isn't a complete AgentLink invite. Open the link again and copy the command.\n";
const BAD_INVITES = [
  '',
  'Ab9_-Ab9_-',
  'http://agentlink.4thtech.io/i#Ab9_-',
  'https://agentlink.4thtech.io/i#',
  'https://agentlink.4thtech.io/i/#Ab9_-',
  'https://agentlink.4thtech.io/x#Ab9_-',
  'https://agentlink.4thtech.io.evil.example/i#Ab9_-',
  'https://evil.example/i#Ab9_-',
  'https://AGENTLINK.4thtech.io/i#Ab9_-',
  'https://agentlinkx4thtech.io/i#Ab9_-',
  'https://аgentlink.4thtech.io/i#Ab9_-', // Cyrillic a
  `${LONG_LINK} `,
  ` ${LONG_LINK}`,
  `${LONG_LINK}\n`,
  `${LONG_LINK}\nid`,
  `'${LONG_LINK}'`,
  `${LONG_LINK}'`,
  `${LONG_LINK}"`,
  `${LONG_LINK};id`,
  `${LONG_LINK}$(id)`,
  `${LONG_LINK}\`id\``,
  `${LONG_LINK}&`,
  `${LONG_LINK}|id`,
  `${LONG_LINK}%41`,
  `${LONG_LINK}#x`,
  `${LONG_LINK}é`,
  `${LONG_LINK}*`,
  `${LONG_LINK}.`,
  `https://agentlink.4thtech.io/i#${'A'.repeat(21847)}`,
  `https://agentlink.4thtech.io/i#2.${'a'.repeat(42)}b`, // the last character has trailing bits
  `https://agentlink.4thtech.io/i#2.${'a'.repeat(41)}w`, // 42 characters
  `https://agentlink.4thtech.io/i#2.${'a'.repeat(43)}w`, // 44 characters
  `https://agentlink.4thtech.io/i#2.${'a'.repeat(41)}.w`,
];

/** Runs the installer in a real terminal (`script`), where it starts the app. Undefined without it. */
function runInTerminal(box, args) {
  const tool = findTool('script');
  if (!tool || !['darwin', 'linux'].includes(process.platform)) return undefined;
  const q = (v) => `'${v.replaceAll("'", `'\\''`)}'`;
  const argv =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', findTool('sh'), box.script, ...args]
      : ['-qec', [findTool('sh'), box.script, ...args].map(q).join(' '), '/dev/null'];
  const result = spawnSync(tool, argv, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: box.bin,
      HOME: box.home,
      SHELL: '/bin/zsh',
      TMPDIR: box.dir,
      MOCK_SERVE: box.serve,
      MOCK_LOG: box.log,
    },
  });
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`.replaceAll('\r', ''),
    log: readFileSync(box.log, 'utf8'),
  };
}

describe.each(shells)('install.sh --invite under %s (WP-2)', (shell) => {
  it.each([
    ['a long link', LONG_LINK],
    ['a short link', SHORT_LINK],
  ])('%s: installs, never prints the link, and says how to open the invite', (_, link) => {
    const box = sandbox();
    const r = run(box, ['--invite', link], { shell });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(launcher(box))).toBe(true);
    // Not run from a terminal: the app is not started, and nothing names the link.
    expect(r.out).toContain(
      'To open the invite, run the command from the invite page again in your own terminal.',
    );
    expect(r.out).not.toMatch(/To start it now|Starting AgentLink/);
    expect(r.out).not.toContain('4thtech.io/i#');
    expect(r.log).not.toContain('npx(');
  });

  it('refuses a malformed link with one fixed line, exit code 2, before anything happens', () => {
    for (const bad of BAD_INVITES) {
      const box = sandbox();
      const r = run(box, ['--invite', bad], { shell });
      expect(r.code, JSON.stringify(bad)).toBe(2);
      expect(r.out, JSON.stringify(bad)).toBe(REFUSED);
      expect(r.log, JSON.stringify(bad)).toBe('');
      expect(readdirSync(box.home), JSON.stringify(bad)).toEqual([]);
    }
  });

  it('refuses a missing value, the --invite= form, two invites and --uninstall with an invite', () => {
    for (const args of [
      ['--invite'],
      [`--invite=${LONG_LINK}`],
      ['--invite', LONG_LINK, '--invite', SHORT_LINK],
      ['--invite', LONG_LINK, '--uninstall'],
    ]) {
      const box = sandbox();
      const r = run(box, args, { shell });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out, args.join(' ')).toMatch(/^AgentLink installer: [^\n]*\n$/);
      expect(r.out, args.join(' ')).not.toContain('Ab9_-');
      expect(r.out, args.join(' ')).not.toContain('aaaa');
      expect(readdirSync(box.home)).toEqual([]);
    }
  });

  it('refuses an unknown option without echoing it (a link pasted without --invite)', () => {
    const box = sandbox();
    const r = run(box, [LONG_LINK], { shell });
    expect(r.code).toBe(2);
    expect(r.out).toBe('AgentLink installer: Unknown option (try --help).\n');
  });

  it('--dry-run with an invite says it would open it, without the link', () => {
    const box = sandbox();
    const r = run(box, ['--dry-run', '--invite', SHORT_LINK], { shell });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('  would open the invite in AgentLink');
    expect(r.out).not.toContain('aaaa');
    expect(readdirSync(box.home)).toEqual([]);
  });

  it('the launcher tells AgentLink it was started by the installer (D4)', () => {
    const box = sandbox();
    expect(run(box, [], { shell }).code).toBe(0);
    exe(join(runtimeDir(box), 'bin/npx'), 'echo "marker=$AGENTLINK_LAUNCHER" >> "$MOCK_LOG"');
    expect(launch(box, ['ui'])).toBe('marker=installer\n');
  });
});

describe('install.sh in a terminal (WP-2, F43)', () => {
  it('starts the app on the invite, and says how to start it next time after it closes', () => {
    const box = sandbox();
    const r = runInTerminal(box, ['--invite', SHORT_LINK]);
    if (r === undefined) {
      expect(process.env.CI, '`script` is required on CI').toBeFalsy();
      return;
    }
    expect(r.code, r.out).toBe(0);
    // The fake npx records its arguments: the launcher ran `join` with the link as one argument.
    expect(r.log.endsWith(`@4thtech-io/agentlink@latest join ${SHORT_LINK}\n`), r.log).toBe(true);
    // The installer itself never prints the link.
    expect(r.out).not.toContain('aaaa');
    const lines = r.out.split('\n');
    const installed = lines.indexOf('AgentLink is installed.');
    const starting = lines.findIndex((l) => l.startsWith('Starting AgentLink.'));
    const next = lines.indexOf('Next time, open a new terminal and type: agentlink');
    expect(installed, r.out).toBeGreaterThan(-1);
    expect(starting, r.out).toBeGreaterThan(installed);
    expect(next, r.out).toBeGreaterThan(starting);
  });

  it('without an invite, starts the app with no arguments', () => {
    const box = sandbox();
    const r = runInTerminal(box, []);
    if (r === undefined) {
      expect(process.env.CI, '`script` is required on CI').toBeFalsy();
      return;
    }
    expect(r.code, r.out).toBe(0);
    expect(r.log.endsWith('@4thtech-io/agentlink@latest\n'), r.log).toBe(true);
    expect(r.out).toContain('Next time, open a new terminal and type: agentlink');
  });
});

describe('install.sh source', () => {
  const source = readFileSync(SCRIPT, 'utf8');

  it('pins the hashes of nodejs.org signed SHASUMS256.txt for its Node.js version', () => {
    expect(source).toContain(`NODE_VERSION=${NODE_VERSION}\n`);
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const sha = SIGNED_SHASUMS[`node-v${NODE_VERSION}-${platform}.tar.gz`];
      expect(source).toContain(`${platform}) echo ${sha} ;;`);
    }
  });

  it('is POSIX sh, downloads only over HTTPS from nodejs.org, and needs no sudo', () => {
    expect(source.startsWith('#!/bin/sh\n')).toBe(true);
    const code = source.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/\bsudo\b|\[\[|\blocal\b|\bfunction\b|\$\{[A-Za-z_]+\/\//);
    const urls = [...source.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/(nodejs\.org\/dist\/|registry\.npmjs\.org\/$|agentlink\.4thtech\.io|github\.com\/4thtech\/agentlink)/,
      );
    }
    expect(source).toContain("--proto '=https' --tlsv1.2");
  });

  it('pins the npm registry on the command line, which beats any .npmrc in the folder you run it from', () => {
    expect(source).toContain(
      'exec $(quote "$node_bin/npx") -y --prefix=$(quote "$base") --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ $PACKAGE',
    );
  });

  it('removes its temporary folder as soon as Node.js is unpacked, and on any abort', () => {
    expect(source).toMatch(/trap 'cleanup' EXIT\n\s*trap 'cleanup; exit 130' INT TERM/);
    expect(source).toMatch(/mv "\$tmp\/node-v[^\n]*\n\s*cleanup\n\s*trap - EXIT INT TERM\n/);
  });

  it('WP-2: opens the invite through the launcher with the link as one quoted argument', () => {
    expect(source).toContain('"$launcher" join "$invite" </dev/tty');
    // Ctrl+C closes the app and the installer still prints its last line (F43): a handler, never an
    // ignored signal, which the app would inherit.
    expect(source).not.toMatch(/trap '' INT/);
    expect(source).toMatch(/trap ':' INT/);
  });

  it('runs everything from main on the last line (a cut-off download runs nothing)', () => {
    expect(source.trimEnd().split('\n').at(-1)).toBe('main "$@"');
  });

  it('uses plain words (no wallet, gas, seed phrase or transaction) and plain ASCII', () => {
    expect(source).not.toMatch(/wallet|\bgas\b|seed phrase|transaction/i);
    expect(source).not.toMatch(/[^\t\n -~]/);
  });

  it('is shellcheck-clean', () => {
    const shellcheck = findTool('shellcheck');
    if (!shellcheck) {
      // CI images have shellcheck; a laptop without it skips only this check.
      expect(process.env.CI, 'shellcheck is required on CI').toBeFalsy();
      return;
    }
    const r = spawnSync(shellcheck, ['--shell=sh', '--severity=style', SCRIPT], {
      encoding: 'utf8',
    });
    expect(`${r.stdout}${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });
});
