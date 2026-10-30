// W4-LIVE-STATUS (04 §2.5 "The pid is used for one check only"; 06 §6 "Read"; D-143): whether the
// process that wrote an MCP session row still exists on this machine. A stored pid is accepted only
// as an integer greater than 1 and at most 2^31 - 1: `kill(0, 0)` and `kill(-1, 0)` always succeed,
// so they would keep a forged row alive. A valid pid gets signal 0 only, which delivers nothing:
// success or `EPERM` means the process exists, anything else (`ESRCH`) that it is gone. No other
// signal is ever sent and nothing else is done to the process; the pid never leaves the caller.
import process from 'node:process';
import { mcpPidValid } from '@4thtech-io/core';

/** The signal-0 probe (process.kill in production; tests pass a fake). */
export type PidProbe = (pid: number, signal: 0) => unknown;

const probe: PidProbe = (pid, signal) => process.kill(pid, signal);

/** True while a process with this pid exists (signal 0 only); false for any pid outside 2..2^31-1. */
export function pidAlive(pid: unknown, kill: PidProbe = probe): boolean {
  if (!mcpPidValid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'EPERM';
  }
}
