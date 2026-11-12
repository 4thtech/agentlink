// WP-D7 (S2; plan 2026-11-12 Decision 2 "Installer launcher: optionally repointed to the bundled
// CLI"): the `agentlink` command the one-line installer writes (installer/install.sh `write_launcher`,
// installer/install.ps1 `Format-Launcher`), and the same command pointed at the desktop app's
// bundled Node and CLI instead of `npx`.
//
// - Only a launcher that is exactly what the installer writes (or exactly what this module writes)
//   is recognised; anything else is the person's own file and is never touched.
// - The repointed launcher keeps the installer's header lines (so the installer's uninstall still
//   names it) and `AGENTLINK_LAUNCHER=installer` (D4: AgentLink then names the `agentlink` command).
// - The paths come from locateDesktopApp (desktop-app.ts), which already refused translocated,
//   temporary and unquotable paths; they are checked again here before they are quoted.
import { quotablePath, type AppStart } from './desktop-app.js';

/** Where the installer puts the command, below the home folder (POSIX `~/.agentlink/bin`). */
export function launcherParts(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? ['AppData', 'Local', 'AgentLink', 'bin', 'agentlink.cmd']
    : ['.agentlink', 'bin', 'agentlink'];
}

/** How the launcher's path is shown. */
export function launcherDisplay(platform: NodeJS.Platform): string {
  return `~/${launcherParts(platform).join('/')}`;
}

const SH_HEAD = [
  '#!/bin/sh',
  '# AgentLink launcher, written by https://agentlink.4thtech.io/install.sh.',
  '# Remove with: curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall',
];
const SH_APP_NOTE = '# Points at the AgentLink app (set from the app).';
const SH_NPX = [
  /^PATH='[^']*':"\$PATH"$/,
  /^export PATH$/,
  /^AGENTLINK_LAUNCHER=installer$/,
  /^export AGENTLINK_LAUNCHER$/,
  /^exec '[^']*\/npx' -y --prefix='[^']*' --registry=https:\/\/registry\.npmjs\.org\/ --@4thtech-io:registry=https:\/\/registry\.npmjs\.org\/ @4thtech-io\/agentlink@latest "\$@"$/,
];

const CMD_HEAD = [
  '@echo off',
  'rem AgentLink launcher, written by https://agentlink.4thtech.io/install.ps1.',
  'rem Remove with: irm https://agentlink.4thtech.io/install.ps1 | iex, run with -Uninstall.',
];
const CMD_APP_NOTE = 'rem Points at the AgentLink app (set from the app).';
const CMD_NPX = [
  /^setlocal$/,
  /^set "AGENTLINK_LAUNCHER=installer"$/,
  /^set "PATH=[^"]*;%PATH%"$/,
  /^"[^"]*\\npx\.cmd" -y --prefix="[^"]*" --registry=https:\/\/registry\.npmjs\.org\/ --@4thtech-io:registry=https:\/\/registry\.npmjs\.org\/ @4thtech-io\/agentlink@latest %\*$/,
];

/** The launcher text pointed at the app (the exact text this module writes). */
export function appLauncherText(start: AppStart, platform: NodeJS.Platform): string {
  if (!quotablePath(start.node, platform) || !quotablePath(start.cli, platform)) {
    throw new Error('launcher: path cannot be quoted');
  }
  if (platform === 'win32') {
    return `${[
      ...CMD_HEAD,
      CMD_APP_NOTE,
      'setlocal',
      'set "AGENTLINK_LAUNCHER=installer"',
      `"${start.node}" "${start.cli}" %*`,
    ].join('\r\n')}\r\n`;
  }
  return `${[
    ...SH_HEAD,
    SH_APP_NOTE,
    'AGENTLINK_LAUNCHER=installer',
    'export AGENTLINK_LAUNCHER',
    `exec '${start.node}' '${start.cli}' "$@"`,
  ].join('\n')}\n`;
}

export type LauncherState =
  | { readonly kind: 'none' }
  /** The installer's own `npx` launcher: may be repointed. */
  | { readonly kind: 'npx' }
  /** Already pointed at this app. */
  | { readonly kind: 'app' }
  /** Anything else (edited by hand, another app path): never touched. */
  | { readonly kind: 'foreign' };

function linesOf(text: string, platform: NodeJS.Platform): string[] | undefined {
  const eol = platform === 'win32' ? '\r\n' : '\n';
  if (!text.endsWith(eol)) return undefined;
  const lines = text.slice(0, -eol.length).split(eol);
  if (platform !== 'win32' && lines.some((l) => l.includes('\r'))) return undefined;
  return lines;
}

/** What the launcher text is, relative to `start` (the app it would point at). */
export function readLauncher(
  text: string | undefined,
  start: AppStart,
  platform: NodeJS.Platform,
): LauncherState {
  if (text === undefined) return { kind: 'none' };
  try {
    if (text === appLauncherText(start, platform)) return { kind: 'app' };
  } catch {
    return { kind: 'foreign' };
  }
  const lines = linesOf(text, platform);
  if (lines === undefined) return { kind: 'foreign' };
  const head = platform === 'win32' ? CMD_HEAD : SH_HEAD;
  const rest = platform === 'win32' ? CMD_NPX : SH_NPX;
  if (lines.length !== head.length + rest.length) return { kind: 'foreign' };
  if (!head.every((line, i) => lines[i] === line)) return { kind: 'foreign' };
  if (!rest.every((re, i) => re.test(lines[head.length + i] ?? ''))) return { kind: 'foreign' };
  return { kind: 'npx' };
}
