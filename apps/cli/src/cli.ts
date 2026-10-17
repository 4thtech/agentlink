#!/usr/bin/env node
// The `agentlink` bin. M1-9y: the Node.js version check comes first and the real program
// (main.ts) loads only after it passes, so an old Node gets one clear line on stderr instead of a
// crash inside a native module. Stderr only: with `agentlink mcp`, stdout belongs to the protocol.
import process from 'node:process';
import { checkNodeVersion } from './node-check.js';
import { createOutput } from './output.js';

const tooOld = checkNodeVersion();
if (tooOld === undefined) {
  await import('./main.js');
} else {
  createOutput().printError(tooOld);
  process.exitCode = 1;
}
