// M1-23-d: hands-free two-Mac dogfood over SSH. Pure helpers (no process is started here):
// the line protocol between the two run.mjs processes, the ssh command builders, the inbox that
// waits for protocol lines, and the combined table.
//
// Shape: Mac A runs `run.mjs --two-mac --remote <host>`. It runs role A itself and starts role B on
// Mac B as `ssh <host> ... run.mjs --role b --hands-free`. The two talk in lines that start with
// `@@AL `: B -> A on B's stdout, A -> B on B's stdin. Nothing secret is ever on a command line:
// the invite link goes over B's stdin only. Owner approvals are never part of the protocol; A runs
// the approve command with a real terminal and the person types the owner code there.
import { validInviteUrl } from './lib.mjs';

export const PROTOCOL_PREFIX = '@@AL ';

const STEP_ID = /^[A-Z][A-Z0-9]{0,5}$/;
const AGENT = /^[a-z][a-z0-9-]{0,31}$/;
const APPROVAL = /^apr_[A-Za-z0-9_-]{22}$/;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,200}$/;
const REMOTE_PATH = /^[A-Za-z0-9._/~+@=-]{1,300}$/;
const OUTCOMES = new Set(['ok', 'skip', 'fail']);
const MAX_FINAL = 200_000;

/** Mac B needs no build or global install: the published package through npx (override with --remote-agentlink). */
export const DEFAULT_REMOTE_AGENTLINK = '["npx","-y","@4thtech-io/agentlink@latest"]';

export const validHost = (v) => typeof v === 'string' && HOST.test(v);
export const validRemotePath = (v) => typeof v === 'string' && REMOTE_PATH.test(v);

/** Maps a result outcome to what the other Mac is told: ok | skip | fail. */
export function wireOutcome(outcome) {
  if (outcome === 'pass' || outcome === 'remote' || outcome === 'manual') return 'ok';
  return outcome === 'skip' ? 'skip' : 'fail';
}

/** One protocol line (no trailing newline). Throws on a value the parser would refuse. */
export function encodeLine(kind, ...fields) {
  const line = `${PROTOCOL_PREFIX}${[kind, ...fields].join(' ')}`;
  if (parseLine(line) === undefined) throw new Error(`bad protocol line ${kind}`);
  return line;
}

/**
 * Parses one line. Returns undefined for anything that is not a well-formed protocol line, so text
 * from the other Mac (untrusted) can never become a command: every field is validated.
 *   STEP <id> ok|skip|fail     a step finished on the sender's Mac
 *   READY                      B: preflight passed
 *   INVITE <url>               A -> B: the invite link (secret; stdin only)
 *   PAIRED                     A -> B: the agents were already paired
 *   ABORT                      A -> B: stop
 *   APPROVAL <oc|cc> <agent> <apr_...>   B -> A: an owner approval is waiting on B
 *   FINAL <json>               B -> A: B's results
 */
export function parseLine(line, nonce) {
  if (typeof line !== 'string') return undefined;
  if (nonce !== undefined) {
    // Mac B's stdout: only lines that carry this run's secret nonce count.
    const mark = `${PROTOCOL_PREFIX}${nonce} `;
    if (!line.startsWith(mark)) return undefined;
    line = PROTOCOL_PREFIX + line.slice(mark.length);
  }
  if (!line.startsWith(PROTOCOL_PREFIX)) return undefined;
  const rest = line.slice(PROTOCOL_PREFIX.length).replace(/\r?\n$/, '');
  const space = rest.indexOf(' ');
  const kind = space === -1 ? rest : rest.slice(0, space);
  const arg = space === -1 ? '' : rest.slice(space + 1);
  const words = arg === '' ? [] : arg.split(' ');
  switch (kind) {
    case 'NONCE':
      return words.length === 1 && /^[0-9a-f]{32}$/.test(words[0])
        ? { kind, nonce: words[0] }
        : undefined;
    case 'READY':
    case 'PAIRED':
    case 'ABORT':
      return words.length === 0 ? { kind } : undefined;
    case 'STEP':
      return words.length === 2 && STEP_ID.test(words[0]) && OUTCOMES.has(words[1])
        ? { kind, id: words[0], outcome: words[1] }
        : undefined;
    case 'INVITE':
      return words.length === 1 && validInviteUrl(words[0]) ? { kind, url: words[0] } : undefined;
    case 'APPROVAL':
      return words.length === 3 &&
        (words[0] === 'oc' || words[0] === 'cc') &&
        AGENT.test(words[1]) &&
        APPROVAL.test(words[2])
        ? { kind, harness: words[0], agent: words[1], approvalId: words[2] }
        : undefined;
    case 'FINAL': {
      if (arg.length === 0 || arg.length > MAX_FINAL) return undefined;
      let json;
      try {
        json = JSON.parse(arg);
      } catch {
        return undefined;
      }
      return sanitizeFinal(json) === undefined ? undefined : { kind, final: sanitizeFinal(json) };
    }
    default:
      return undefined;
  }
}

/** Text with control characters (CR, LF, ESC ...) replaced: it ends up in tables and terminals. */
// eslint-disable-next-line no-control-regex -- the point is to remove control characters
export const plain = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const str = (v, max) => plain(v).slice(0, max);

/** A protocol line for Mac B's stdout: the run's nonce right after the prefix. */
export const sealLine = (line, nonce) =>
  `${PROTOCOL_PREFIX}${nonce} ${line.slice(PROTOCOL_PREFIX.length)}`;

/** B's final report with fixed fields and bounded strings; undefined when the shape is wrong. */
export function sanitizeFinal(json) {
  if (typeof json !== 'object' || json === null || !Array.isArray(json.results)) return undefined;
  const results = [];
  for (const r of json.results.slice(0, 100)) {
    if (typeof r !== 'object' || r === null || !STEP_ID.test(String(r.id))) return undefined;
    results.push({
      id: String(r.id),
      title: str(r.title, 200),
      harness: r.harness === 'cc' ? 'cc' : 'oc',
      local: r.local === true,
      benign: r.benign === true,
      outcome: str(r.outcome, 20),
      seconds: Number.isFinite(Number(r.seconds)) ? Math.round(Number(r.seconds)) : 0,
      notes: (Array.isArray(r.notes) ? r.notes : []).slice(0, 10).map((n) => str(n, 300)),
    });
  }
  const findings = (Array.isArray(json.findings) ? json.findings : []).slice(0, 50).map((f) => ({
    file: str(f?.file, 200),
    name: str(f?.name, 100),
  }));
  const versions = {};
  for (const k of ['agentlink', 'opencode', 'claude']) {
    versions[k] = json.versions?.[k] === undefined ? undefined : str(json.versions[k], 100);
  }
  return {
    results,
    findings,
    versions,
    scan: str(json.scan, 100),
    dir: str(json.dir, 300),
  };
}

/**
 * A queue of parsed messages with waiters. `take(match, timeoutMs)` resolves with the first queued
 * message that matches (removing it), or 'timeout', or 'ended' when the stream closed first.
 */
export function makeInbox() {
  const items = [];
  const waiters = [];
  let ended = false;
  const settle = () => {
    for (let w = 0; w < waiters.length; w += 1) {
      const waiter = waiters[w];
      const at = items.findIndex(waiter.match);
      if (at !== -1) {
        const [message] = items.splice(at, 1);
        waiters.splice(w, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        w -= 1;
      } else if (ended) {
        waiters.splice(w, 1);
        clearTimeout(waiter.timer);
        waiter.resolve('ended');
        w -= 1;
      }
    }
  };
  return {
    push(message) {
      items.push(message);
      settle();
    },
    end() {
      ended = true;
      settle();
    },
    take(match, timeoutMs) {
      return new Promise((resolve) => {
        const waiter = { match, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          resolve('timeout');
        }, timeoutMs);
        waiters.push(waiter);
        settle();
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ssh commands

/** Single-quotes a value for a POSIX shell. */
export const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** A remote path for the remote shell: a leading `~/` becomes "$HOME" so it expands inside quotes. */
export function remotePath(path) {
  if (!validRemotePath(path))
    throw new Error('the remote path has characters that are not allowed');
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

/**
 * The remote command line: a login shell (so node and agentlink are on PATH as in Mac B's own
 * terminal) running `script`. Nothing secret is ever put into `script`.
 */
export function remoteShell(script) {
  const withPath = `PATH=/opt/homebrew/bin:/usr/local/bin:"$PATH"; export PATH; ${script}`;
  return `exec "$SHELL" -lc ${shq(withPath)}`;
}

/** Names of AI-harness variables present in `env` (the approve guard looks for these on Mac A). */
const HARNESS_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'GEMINI_CLI',
  'OPENCODE',
  'OPENCODE_CONFIG_CONTENT',
  'ANTIGRAVITY_AGENT',
  'CURSOR_AGENT',
];
export const harnessEnvVars = (env) =>
  HARNESS_ENV.filter((name) => env[name] !== undefined && env[name] !== '');

/**
 * The ssh arguments. `tty: true` is for the interactive approve (a real terminal on both ends);
 * every other call uses BatchMode so it can never stop at a password prompt. No environment
 * variable is passed on the command line, and ssh forwards none unless your ssh config says so.
 */
export function sshArgs(host, remoteCommand, { tty = false } = {}) {
  if (!validHost(host)) throw new Error('--remote is not a valid ssh host');
  return [
    ...(tty ? ['-t'] : ['-o', 'BatchMode=yes']),
    '-o',
    'ConnectTimeout=15',
    '--',
    host,
    remoteCommand,
  ];
}

/** The remote AgentLink argv as a quoted shell fragment (`agentlink` or from --remote-agentlink). */
function remoteAgentlinkWords(options, parse) {
  const { cmd, args } = parse(options.remoteAgentlink ?? DEFAULT_REMOTE_AGENTLINK);
  return [cmd, ...args].map(shq).join(' ');
}

/** What runs on Mac B: role b, hands-free. The invite is NOT here; it arrives on stdin. */
export function remoteRunCommand(options, runId) {
  const parts = [
    `cd ${remotePath(options.remoteRepo)} && exec node tools/dogfood/run.mjs --role b --hands-free`,
    `--run-id ${runId}`,
    `--cc-agent ${options.ccAgent} --oc-agent ${options.ocAgent}`,
    ...(options.sameOwner ? ['--same-owner'] : []),
    `--agentlink ${shq(options.remoteAgentlink ?? DEFAULT_REMOTE_AGENTLINK)}`,
    ...(options.remoteOpencode === undefined ? [] : [`--opencode ${shq(options.remoteOpencode)}`]),
    ...(options.ocModel === undefined ? [] : [`--oc-model ${shq(options.ocModel)}`]),
    ...(options.only === undefined ? [] : [`--only ${shq(options.only.join(','))}`]),
    `--step-timeout ${String(options.stepTimeoutMs / 1000)}`,
    `--approval-timeout ${String(options.approvalTimeoutMs / 60_000)}`,
    `--approval-interval ${String(options.approvalIntervalMs / 1000)}`,
  ];
  return remoteShell(parts.join(' '));
}

/**
 * The approve command, run with the person's own terminal (stdio inherited, a tty for ssh). The
 * script never supplies the owner code and never captures the terminal. `where` is 'local' or
 * 'remote'. Agent name and approval ID are validated, so nothing from the other Mac reaches a shell.
 */
export function approveInvocation(options, where, agent, approvalId, parse) {
  if (!AGENT.test(agent)) throw new Error('bad agent name');
  if (!APPROVAL.test(approvalId)) throw new Error('bad approval ID');
  if (where === 'local') {
    const { cmd, args } = parse(options.agentlinkBin);
    return { cmd, args: [...args, 'approve', '--agent', agent, approvalId], stdio: 'inherit' };
  }
  const script = `${remoteAgentlinkWords({ remoteAgentlink: options.remoteAgentlink }, parse)} approve --agent ${agent} ${approvalId}`;
  return {
    cmd: 'ssh',
    args: sshArgs(options.remoteHost, remoteShell(script), { tty: true }),
    stdio: 'inherit',
  };
}

/** The ssh reachability check, and what to do when it fails. */
export const sshCheckArgs = (host) => sshArgs(host, 'true');

export function sshSetupHelp(host) {
  return [
    `Cannot reach ${host} over ssh without a password prompt. One-time setup:`,
    '  1. On Mac B: System Settings > General > Sharing > Remote Login: on (allow your user).',
    '  2. On Mac A: ssh-keygen -t ed25519   (skip if ~/.ssh/id_ed25519 exists)',
    `  3. On Mac A: ssh-copy-id ${host}      (asks for Mac B's login password once)`,
    `  4. On Mac A: ssh -o BatchMode=yes ${host} true   (must print nothing and succeed)`,
  ].join('\n');
}

export function approvalNotice(where, host, agent, approvalId) {
  const lines = [
    'OWNER APPROVAL NEEDED',
    '',
    where === 'remote'
      ? `Mac B (${host}) is waiting for the owner of agent ${agent}.`
      : `Mac A is waiting for the owner of agent ${agent}.`,
    `Approval ${approvalId}: the approve command runs below in this terminal.`,
    'Type the owner code of that Mac when asked. This script never sees or supplies it.',
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const bar = `+${'-'.repeat(width + 2)}+`;
  return [bar, ...lines.map((l) => `| ${l.padEnd(width)} |`), bar].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Combined result

/**
 * One row per step from the Mac that ran it: A's local results and B's local results, in step order.
 * A step that has no result on its own Mac gets a failure row.
 */
export function combineResults(stepIds, aResults, bResults) {
  return stepIds.map((id) => {
    const a = aResults.find((r) => r.id === id && r.local === true);
    const b = bResults?.find((r) => r.id === id && r.local === true);
    const found = a ?? b;
    if (found === undefined) {
      return {
        id,
        title: id,
        mac: '?',
        outcome: 'fail',
        seconds: 0,
        notes: ['no result from either Mac'],
        benign: false,
      };
    }
    return { ...found, mac: a === undefined ? 'B' : 'A' };
  });
}

/** Exit rule: every row passed (or is a benign skip) and both secret scans are clean. */
export function combinedOk(rows, aFindings, bFinal) {
  return (
    bFinal !== undefined &&
    aFindings.length === 0 &&
    bFinal.findings.length === 0 &&
    rows.every((r) => r.outcome === 'pass' || (r.outcome === 'skip' && r.benign === true))
  );
}

export function renderCombinedMd(meta, rows) {
  const esc = (s) => plain(s).replace(/\|/g, '\\|');
  const pass = rows.filter((r) => r.outcome === 'pass').length;
  return [
    `# AgentLink two-Mac dogfood (hands-free) ${meta.startedAt}`,
    '',
    `Agents: ${meta.ccAgent} (Mac A, Claude Code ${meta.versionsA.claude ?? '-'}), ${meta.ocAgent} (Mac B ${meta.host}, OpenCode ${meta.versionsB?.opencode ?? '-'}); AgentLink A ${meta.versionsA.agentlink ?? '-'}, B ${meta.versionsB?.agentlink ?? '-'}`,
    `Passed ${String(pass)} of ${String(rows.length)}; secret scan: Mac A ${meta.scanA}, Mac B ${meta.scanB}`,
    `Results folders: Mac A ${meta.dirA}; Mac B ${meta.dirB ?? 'unknown'} (on ${meta.host})`,
    '',
    '| Step | What | Mac | Harness | Result | Time | Notes |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${esc(r.title)} | ${r.mac} | ${r.harness === 'cc' ? 'Claude Code' : 'OpenCode'} | ${r.outcome} | ${String(r.seconds)} s | ${esc(r.notes.join('; '))} |`,
    ),
    '',
  ].join('\n');
}
