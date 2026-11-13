// UPD-S1 SPIKE (test-only, NEVER merged, NEVER released). Answers one question on a real Mac: when
// AgentLink ITSELF downloads a zip with Node fetch, unpacks it with ditto and swaps it into
// /Applications by two renames, does macOS show any dialog (Gatekeeper, App Management, Keychain,
// "damaged"), and does the new bundle carry com.apple.quarantine or com.apple.provenance?
//
// Present only when the shell is bundled with AGENTLINK_SPIKE_SWAP=1 (bundle.config.mjs defines
// `__AGENTLINK_SPIKE_SWAP__`); every release build defines it false and the bundler drops this path.
// No signature or hash check happens here on purpose: the spike measures the operating system, not
// our verifier (UPD-1/UPD-4 own that). The zip URL is fixed at bundle time, never taken from a page.
//
// Everything it learns goes to <userData>/spike-swap.log (plain text, no secrets: paths, xattr
// names and values, codesign/spctl output, step outcomes and timings).
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SPIKE_APP = '/Applications/AgentLink.app';
export const SPIKE_LOG = 'spike-swap.log';
/** The tray item that runs the swap. */
export const SPIKE_ITEM = 'Spike: install the next build';
const PENDING = 'spike-pending.json';

export interface SpikeConfig {
  /** <userData>, e.g. ~/Library/Application Support/AgentLink */
  readonly userData: string;
  /** The zip URL baked in at bundle time. */
  readonly zipUrl: string;
  readonly version: string;
  /** process.execPath of the running shell. */
  readonly execPath: string;
  readonly pid: number;
  readonly quit: () => void;
}

/** https anywhere, or http only on the loopback address (the owner's local test server). */
export function spikeUrlAllowed(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && url.hostname === '127.0.0.1';
}

function logLine(userData: string, line: string): void {
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  appendFileSync(join(userData, SPIKE_LOG), `${new Date().toISOString()} ${line}\n`, {
    mode: 0o600,
  });
}

function run(command: string, args: readonly string[]): string {
  const r = spawnSync(command, [...args], { encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return `$ ${command} ${args.join(' ')}\n  exit=${String(r.status)}${r.error ? ` error=${r.error.message}` : ''}\n  ${out.replace(/\n/g, '\n  ')}`;
}

/** xattr -l (recursive on the bundle top only), codesign -dv, spctl -a -vv. */
export function probeBundle(userData: string, bundle: string, label: string): void {
  logLine(userData, `--- probe ${label}: ${bundle}`);
  logLine(userData, run('/usr/bin/xattr', ['-l', bundle]));
  logLine(userData, run('/usr/bin/xattr', ['-l', join(bundle, 'Contents', 'MacOS', 'AgentLink')]));
  logLine(userData, run('/usr/bin/xattr', ['-l', join(bundle, 'Contents', 'Resources', 'node')]));
  logLine(userData, run('/usr/bin/codesign', ['-dv', bundle]));
  logLine(userData, run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]));
  logLine(userData, run('/usr/sbin/spctl', ['-a', '-vv', bundle]));
}

/** The whole spike: download → ditto -x -k → rename old aside → rename new in → relaunch. */
export async function runSpikeSwap(cfg: SpikeConfig): Promise<void> {
  const t0 = Date.now();
  const step = (s: string): void => logLine(cfg.userData, `[${Date.now() - t0} ms] ${s}`);
  step(
    `=== SPIKE START version=${cfg.version} pid=${String(cfg.pid)} execPath=${cfg.execPath} url=${cfg.zipUrl}`,
  );
  step(`running from ${SPIKE_APP}: ${String(cfg.execPath.startsWith(`${SPIKE_APP}/`))}`);
  try {
    if (!spikeUrlAllowed(cfg.zipUrl))
      throw new Error('zip URL not allowed (https, or http://127.0.0.1)');
    const base = join(cfg.userData, 'spike', String(Date.now()));
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const zip = join(base, 'next.zip');
    const staged = join(base, 'staged');
    const previous = join(base, 'previous');
    mkdirSync(staged, { mode: 0o700 });
    mkdirSync(previous, { mode: 0o700 });

    step('download: start');
    const response = await fetch(cfg.zipUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`download: HTTP ${String(response.status)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(zip, bytes, { mode: 0o600 });
    step(`download: done, ${String(bytes.length)} bytes`);
    logLine(cfg.userData, run('/usr/bin/xattr', ['-l', zip]));

    step('extract: ditto -x -k');
    logLine(cfg.userData, run('/usr/bin/ditto', ['-x', '-k', zip, staged]));
    const stagedApp = join(staged, 'AgentLink.app');
    if (!existsSync(stagedApp)) throw new Error('extract: no AgentLink.app at the top of the zip');
    probeBundle(cfg.userData, stagedApp, 'staged (before swap)');

    step(`swap 1: rename ${SPIKE_APP} -> ${previous}/AgentLink.app`);
    try {
      await rename(SPIKE_APP, join(previous, 'AgentLink.app'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      throw new Error(
        `swap 1 failed: ${code} (EACCES/EPERM: no write access; EXDEV: other volume)`,
        { cause: error },
      );
    }
    step('swap 1: done');
    step(`swap 2: rename staged -> ${SPIKE_APP}`);
    try {
      await rename(stagedApp, SPIKE_APP);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      step(`swap 2 failed: ${code}; putting the old app back`);
      await rename(join(previous, 'AgentLink.app'), SPIKE_APP).catch((e: unknown) =>
        step(`ROLLBACK FAILED: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`),
      );
      throw new Error(`swap 2 failed: ${code}`, { cause: error });
    }
    step('swap 2: done');
    probeBundle(cfg.userData, SPIKE_APP, 'installed (after swap, before relaunch)');

    writeFileSync(
      join(cfg.userData, PENDING),
      JSON.stringify({ from: cfg.version, at: Date.now() }) + '\n',
      { mode: 0o600 },
    );
    // Relaunch after this process has exited (single-instance lock), from a child of this process.
    step('relaunch: waiting for this process to exit, then open the new app');
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'while /bin/kill -0 "$0" 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open "$1"',
        String(cfg.pid),
        SPIKE_APP,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    step('quit');
    cfg.quit();
  } catch (error) {
    step(`OUTCOME: FAILED: ${(error as Error).message}`);
    step('=== SPIKE END');
  }
}

/** On start of a spike build: if a swap just happened, log what the new app sees, then finish. */
export function finishSpikeIfPending(userData: string, version: string, execPath: string): void {
  const pending = join(userData, PENDING);
  if (!existsSync(pending)) return;
  let from = 'unknown';
  let at = 0;
  try {
    const p = JSON.parse(readFileSync(pending, 'utf8')) as { from?: string; at?: number };
    from = p.from ?? 'unknown';
    at = p.at ?? 0;
  } catch {
    /* damaged marker: still finish */
  }
  rmSync(pending, { force: true });
  logLine(
    userData,
    `=== SPIKE RELAUNCHED: now version=${version} (was ${from}), ${String(Date.now() - at)} ms after the swap, execPath=${execPath}`,
  );
  probeBundle(userData, SPIKE_APP, 'installed (after relaunch)');
  logLine(userData, 'OUTCOME: SWAPPED AND RELAUNCHED (report any dialog you saw)');
  logLine(userData, '=== SPIKE END');
}
