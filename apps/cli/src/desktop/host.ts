// WP-D3: the core desktop host entry, built to dist/desktop/host.js. Hidden on purpose: it is not a
// `bin` and not a command (no dispatcher entry), and it runs only when the AgentLink app's shell
// starts it with its private pipe on fd 3 (host-main.ts; protocol.ts). Started any other way it
// prints one fixed line and exits 1. It writes nothing to stdout.
import process from 'node:process';
import { readPackageVersion, setCliVersion } from '../runtime/cli-version.js';
import { desktopHostMain, nodeDesktopHostMainDeps } from './host-main.js';

// HOTFIX-NOID: the app's status strip and update checks show this package's version (it read
// 0.0.0: only main.ts set it). Bundled: dist/desktop-host.js; per-file build: dist/desktop/host.js.
setCliVersion(
  readPackageVersion([
    new URL('../package.json', import.meta.url),
    new URL('../../package.json', import.meta.url),
  ]),
);

const code = await desktopHostMain(nodeDesktopHostMainDeps());
// Relay sockets and timers of a closed agent must not keep the process alive after a clean stop.
// The exit comes a moment later, not at once: on Windows a write to the shell's stderr pipe is
// asynchronous, and an immediate exit lost the one fixed line (the app log showed only "exited").
process.exitCode = code;
setTimeout(() => process.exit(code), 500);
