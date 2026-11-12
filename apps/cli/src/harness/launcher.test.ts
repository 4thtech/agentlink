// WP-D7: the installer's `agentlink` launcher, recognised exactly, and the same launcher pointed at
// the desktop app. Anything else is never touched.
import { describe, expect, it } from 'vitest';
import { appLauncherText, launcherParts, readLauncher } from './launcher.js';

const MAC = {
  node: '/Applications/AgentLink.app/Contents/Resources/node/bin/node',
  cli: '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
};
const RES = 'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources';
const WIN = {
  node: `${RES}\\node\\node.exe`,
  cli: `${RES}\\core\\node_modules\\@4thtech-io\\agentlink\\dist\\agentlink.js`,
};

/** Exactly what installer/install.sh write_launcher writes. */
const shLauncher = (
  nodeBin = '/Users/ana/.agentlink/runtime/node/bin',
  base = '/Users/ana/.agentlink',
) =>
  [
    '#!/bin/sh',
    '# AgentLink launcher, written by https://agentlink.4thtech.io/install.sh.',
    '# Remove with: curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall',
    `PATH='${nodeBin}':"$PATH"`,
    'export PATH',
    'AGENTLINK_LAUNCHER=installer',
    'export AGENTLINK_LAUNCHER',
    `exec '${nodeBin}/npx' -y --prefix='${base}' --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest "$@"`,
  ].join('\n') + '\n';

/** Exactly what installer/install.ps1 Format-Launcher writes (plus the CRLF it appends). */
const cmdLauncher = (
  dir = 'C:\\Users\\ana\\AppData\\Local\\AgentLink\\runtime\\node',
  root = 'C:\\Users\\ana\\AppData\\Local\\AgentLink',
) =>
  [
    '@echo off',
    'rem AgentLink launcher, written by https://agentlink.4thtech.io/install.ps1.',
    'rem Remove with: irm https://agentlink.4thtech.io/install.ps1 | iex, run with -Uninstall.',
    'setlocal',
    'set "AGENTLINK_LAUNCHER=installer"',
    `set "PATH=${dir};%PATH%"`,
    `"${dir}\\npx.cmd" -y --prefix="${root}" --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest %*`,
  ].join('\r\n') + '\r\n';

describe('launcher', () => {
  it('lives where the installer puts it', () => {
    expect(launcherParts('darwin')).toEqual(['.agentlink', 'bin', 'agentlink']);
    expect(launcherParts('win32')).toEqual([
      'AppData',
      'Local',
      'AgentLink',
      'bin',
      'agentlink.cmd',
    ]);
  });

  it("recognises the installer's own launcher, and ours", () => {
    expect(readLauncher(undefined, MAC, 'darwin')).toEqual({ kind: 'none' });
    expect(readLauncher(shLauncher(), MAC, 'darwin')).toEqual({ kind: 'npx' });
    expect(readLauncher(appLauncherText(MAC, 'darwin'), MAC, 'darwin')).toEqual({ kind: 'app' });
    expect(readLauncher(cmdLauncher(), WIN, 'win32')).toEqual({ kind: 'npx' });
    expect(readLauncher(appLauncherText(WIN, 'win32'), WIN, 'win32')).toEqual({ kind: 'app' });
  });

  it('anything edited by hand, or pointed at another app, is foreign', () => {
    expect(readLauncher(`${shLauncher()}echo hi\n`, MAC, 'darwin')).toEqual({ kind: 'foreign' });
    expect(readLauncher(shLauncher().replace('@latest', '@0.1.0'), MAC, 'darwin')).toEqual({
      kind: 'foreign',
    });
    expect(readLauncher(shLauncher().replace(/\n$/, ''), MAC, 'darwin')).toEqual({
      kind: 'foreign',
    });
    const other = appLauncherText({ node: '/opt/x/node', cli: '/opt/x/agentlink.js' }, 'darwin');
    expect(readLauncher(other, MAC, 'darwin')).toEqual({ kind: 'foreign' });
    expect(readLauncher(cmdLauncher().replace(/\r\n/g, '\n'), WIN, 'win32')).toEqual({
      kind: 'foreign',
    });
  });

  it('the app launcher runs the bundled node with the CLI, no npx, no shell on Windows', () => {
    const sh = appLauncherText(MAC, 'darwin');
    expect(sh.startsWith('#!/bin/sh\n# AgentLink launcher, written by')).toBe(true);
    expect(sh).toContain('AGENTLINK_LAUNCHER=installer');
    expect(sh).toContain(`exec '${MAC.node}' '${MAC.cli}' "$@"\n`);
    expect(sh).not.toContain('npx');
    const cmd = appLauncherText(WIN, 'win32');
    expect(cmd).toContain(`"${WIN.node}" "${WIN.cli}" %*\r\n`);
    expect(cmd).not.toContain('npx');
    expect(cmd).not.toMatch(/cmd \/c/i);
  });

  it('refuses a path it cannot quote', () => {
    expect(() => appLauncherText({ node: "/x/'y/node", cli: '/x/cli.js' }, 'darwin')).toThrow();
    expect(() =>
      appLauncherText({ node: 'C:\\%X%\\node.exe', cli: 'C:\\a.js' }, 'win32'),
    ).toThrow();
  });
});
