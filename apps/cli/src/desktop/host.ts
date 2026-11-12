// WP-D3: the core desktop host entry, built to dist/desktop/host.js. Hidden on purpose: it is not a
// `bin` and not a command (no dispatcher entry), and it runs only when the AgentLink app's shell
// starts it with its private pipe on fd 3 (host-main.ts; protocol.ts). Started any other way it
// prints one fixed line and exits 1. It writes nothing to stdout.
import process from 'node:process';
import { desktopHostMain, nodeDesktopHostMainDeps } from './host-main.js';

const code = await desktopHostMain(nodeDesktopHostMainDeps());
// Relay sockets and timers of a closed agent must not keep the process alive after a clean stop.
process.exit(code);
