// The Electron main-process entry (package "main"). The only file that imports the `electron`
// module (Electron's built-in; typed in electron.d.ts from electron-api.ts, no npm package). All
// logic is in main.ts, which takes Electron by injection so it is tested without Electron.
import electron from 'electron';
import { realProcess, runShell } from './main.js';

void runShell(electron, realProcess()).catch(() => electron.app.exit(1));
