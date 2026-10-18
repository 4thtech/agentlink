// M1-23-e: auto-sync two-Mac dogfood. Both agents run in their own Mac's GUI terminal (macOS denies
// the login keychain in SSH sessions); ssh is used ONLY to move small files between the Macs.
//
// Layout on Mac B: <out>/<run>/sync/ (0700)
//   waiting    B -> A  "<run> <nonce>": B is up and waiting; A reads it, then deletes it
//   status.a   A -> B  sealed lines: READY, STEP (append)
//   status.b   B -> A  sealed lines: STEP, DONE (append)
//   invite     A -> B  one sealed line: INVITE <url> | PAIRED | ABORT; B deletes it after reading
// A sealed line is the M1-23-d protocol line with the run's nonce: `@@AL <nonce> STEP P1 ok`.
// Lines without this run's nonce are ignored, so a stale file or text an agent wrote cannot forge a
// status. Status is written by the script only, from step outcomes (never from model output).
// The invite link is written by A through ssh stdin (`cat >`), never in argv. No owner code and no
// approval ever crosses ssh.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeLine, parseLine, remotePath, sealLine, shq, sshArgs } from './remote.mjs';

const NONCE = /^[0-9a-f]{32}$/;
/** Files in the sync directory; fixed names, so no value from the other Mac is ever a path. */
export const FILES = { waiting: 'waiting', invite: 'invite', a: 'status.a', b: 'status.b' };
export const DEFAULT_REMOTE_OUT = '~/agentlink-dogfood';

/** `<run> <nonce>` as B writes it; undefined when malformed. */
export function parseWaiting(text) {
  const m = /^(\d{8}-\d{6}) ([0-9a-f]{32})\s*$/.exec(String(text));
  return m === null ? undefined : { runId: m[1], nonce: m[2] };
}
export const waitingText = (runId, nonce) => `${runId} ${nonce}\n`;

/** One sealed status line (no newline). */
export const statusLine = (nonce, kind, ...fields) => sealLine(encodeLine(kind, ...fields), nonce);

/** All valid messages of a status file for this nonce, in order. Anything else is dropped. */
export function parseStatusFile(text, nonce) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = parseLine(line, nonce);
    if (m !== undefined) out.push(m);
  }
  return out;
}

/** The invite hand-off file content: INVITE <url> | PAIRED | ABORT. */
export const inviteText = (nonce, kind, ...fields) => `${statusLine(nonce, kind, ...fields)}\n`;
/** Parses it; undefined unless a valid INVITE/PAIRED/ABORT line with this nonce is there. */
export function parseInviteFile(text, nonce) {
  return parseStatusFile(text, nonce).find(
    (m) => m.kind === 'INVITE' || m.kind === 'PAIRED' || m.kind === 'ABORT',
  );
}

// ---------------------------------------------------------------------------------------------
// Transports: the same operations on a local directory (Mac B) or over ssh (Mac A).

export function localTransport(dir) {
  const p = (name) => join(dir, name);
  return {
    async init() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    async read(name) {
      try {
        return await readFile(p(name), 'utf8');
      } catch {
        return undefined;
      }
    },
    async write(name, text) {
      await writeFile(p(name), text, { mode: 0o600 });
    },
    async append(name, text) {
      await appendFile(p(name), text, { mode: 0o600 });
    },
    async remove(name) {
      await rm(p(name), { force: true });
    },
  };
}

/** Runs ssh with `input` on stdin. Resolves { status, stdout }; never rejects, never outlives `timeoutMs`. */
export function sshExec(bin, args, input, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    } catch {
      resolve({ status: -1, stdout: '' });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: -1, stdout: '' });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? -1, stdout });
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * Mac B's sync directory seen from Mac A. `syncDir` is the path on Mac B (may start with `~/`).
 * Contents only travel on stdin/stdout; argv holds fixed commands and validated paths.
 */
export function sshTransport(host, syncDir, { ssh = 'ssh', exec = sshExec } = {}) {
  const run = (script, input) => exec(ssh, sshArgs(host, script), input);
  const f = (name) => remotePath(`${syncDir}/${name}`);
  return {
    async init() {},
    async read(name) {
      const r = await run(`cat ${f(name)} 2>/dev/null`, '');
      return r.status === 0 ? r.stdout : undefined;
    },
    async write(name, text) {
      const r = await run(`umask 077; cat > ${f(name)}`, text);
      if (r.status !== 0) throw new Error('could not write to Mac B over ssh');
    },
    async append(name, text) {
      const r = await run(`umask 077; cat >> ${f(name)}`, text);
      if (r.status !== 0) throw new Error('could not write to Mac B over ssh');
    },
    async remove(name) {
      await run(`rm -f ${f(name)}`, '');
    },
  };
}

/**
 * Finds Mac B's newest waiting run under `<remoteOut>/<run>/sync/waiting`. Returns
 * { runId, nonce, syncDir } or undefined. `remoteOut` is validated by the caller (validRemotePath).
 */
export async function discoverWaiting(host, remoteOut, { ssh = 'ssh', exec = sshExec } = {}) {
  const r = await exec(
    ssh,
    sshArgs(host, `ls -1t ${remotePath(remoteOut)}/*/sync/waiting 2>/dev/null | head -n 1`),
    '',
  );
  const path = r.status === 0 ? r.stdout.trim() : '';
  const m = /\/(\d{8}-\d{6})\/sync\/waiting$/.exec(path);
  if (m === null) return undefined;
  const syncDir = `${remoteOut.replace(/\/+$/, '')}/${m[1]}/sync`;
  const t = sshTransport(host, syncDir, { ssh, exec });
  const parsed = parseWaiting(await t.read(FILES.waiting));
  if (parsed === undefined || parsed.runId !== m[1]) return undefined;
  return { ...parsed, syncDir };
}

// ---------------------------------------------------------------------------------------------
// Channel: sealed lines over a transport.

/**
 * `role` is 'a' or 'b'. send() appends to this side's status file; take() polls the other side's
 * file until a message matches (consumed once, in order), or the timeout passes.
 */
export function makeChannel({ transport, nonce, role, sleep, now = Date.now, intervalMs = 3000 }) {
  if (!NONCE.test(nonce)) throw new Error('bad nonce');
  const mine = role === 'a' ? FILES.a : FILES.b;
  const theirs = role === 'a' ? FILES.b : FILES.a;
  const pending = [];
  let seen = 0;
  const refresh = async () => {
    const all = parseStatusFile(await transport.read(theirs), nonce);
    if (all.length > seen) {
      pending.push(...all.slice(seen));
      seen = all.length;
    }
  };
  // Sends are queued in order (one ssh at a time), so a STEP can never overtake the one before it.
  let chain = Promise.resolve();
  return {
    /** Appends one sealed line; resolves when it is written (one retry; a failure is not thrown). */
    send(kind, ...fields) {
      const text = `${statusLine(nonce, kind, ...fields)}\n`;
      chain = chain.then(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await transport.append(mine, text);
            return;
          } catch {
            await sleep(intervalMs);
          }
        }
      });
      return chain;
    },
    /** First matching message (consumed), or 'timeout'. A failed read counts as "nothing yet". */
    async take(match, timeoutMs) {
      const deadline = now() + timeoutMs;
      for (;;) {
        try {
          await refresh();
        } catch {
          // ssh hiccup: try again until the deadline
        }
        const at = pending.findIndex(match);
        if (at !== -1) return pending.splice(at, 1)[0];
        if (now() >= deadline) return 'timeout';
        await sleep(intervalMs);
      }
    },
  };
}

/** The approve command to type in a second window on THIS Mac (shell-quoted). */
export const approveCommandText = (cmd, args) => [cmd, ...args].map(shq).join(' ');

export function approvalNoticeLocal(agent, approvalId, command, minutes) {
  const lines = [
    'OWNER APPROVAL NEEDED (on this Mac)',
    '',
    `Open a second terminal window on THIS Mac and type this, then the owner code of ${agent}:`,
    command,
    `Approval ${approvalId}. Waiting up to ${String(minutes)} minutes.`,
    'This script never approves, never sees the code, and no code crosses ssh.',
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const bar = `+${'-'.repeat(width + 2)}+`;
  return [bar, ...lines.map((l) => `| ${l.padEnd(width)} |`), bar].join('\n');
}
