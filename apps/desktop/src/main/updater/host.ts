// UPD-1: what the updater asks for on this computer and build. Fixes two defects of the first
// wiring in main.ts: the channel was hard-coded `stable`, and the arch was the raw process.arch, so
// an Intel copy running under Rosetta on Apple silicon would have been offered the Intel build
// forever. Pure helpers; the one system call is injected.
import { macArch } from '../../shared/app-update.js';
import type { AssetKind, Channel } from './manifest.js';

/**
 * The channel this build follows. UPD-3 (D-151): every GitHub Release is signed for `stable` by the
 * one update key; a pre-release version (`-beta.N`) still follows `beta`.
 */
export const BUILD_CHANNEL: Channel = 'stable';

/** A pre-release version (`-beta.N`) always follows `beta`; any other follows the build channel. */
export function updateChannel(version: string, build: Channel = BUILD_CHANNEL): Channel {
  return version.includes('-') ? 'beta' : build;
}

/** Runs a fixed program with fixed arguments and returns its standard output. */
export type RunFixed = (command: string, args: readonly string[]) => string;

const SYSCTL = '/usr/sbin/sysctl';
const TRANSLATED_ARGS: readonly string[] = Object.freeze(['-n', 'sysctl.proc_translated']);

/**
 * True when this process runs under Rosetta (`sysctl.proc_translated` = 1). An Intel Mac has no such
 * key (the command fails): not translated. Anything unexpected also counts as not translated.
 */
export function procTranslated(run: RunFixed): boolean {
  try {
    return run(SYSCTL, TRANSLATED_ARGS).trim() === '1';
  } catch {
    return false;
  }
}

/** The arch to ask the manifest for: the Mac's real arch on macOS, process.arch elsewhere. */
export function updaterArch(platform: string, arch: string, translated: boolean): string {
  if (platform !== 'darwin') return arch;
  return macArch(arch, translated) ?? arch;
}

/** The installer form the phase-1 flow opens (UPD-4's in-app install asks for `zip`). */
export function installerKind(platform: string): AssetKind {
  return platform === 'win32' ? 'nsis' : 'dmg';
}
