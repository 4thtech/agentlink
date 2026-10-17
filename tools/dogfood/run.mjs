#!/usr/bin/env node
// M1-23: automated LOCAL dogfood on the owner's own computer (owner decision 2026-10-16).
//
// Drives two harnesses headless against two AgentLink agents of ONE owner: Claude Code (`claude -p`,
// the owner's subscription) as `cc-test` and OpenCode (`opencode run`, the model set in OpenCode) as
// `oc-test`. Runs docs/runbooks/dogfood-m1a.md section 5 and 6, saves transcripts and a results
// table outside the repository, and scans the folder for secrets.
//
// What this script NEVER does: approve anything, read the owner code, or call an owner command
// (`approve`, `deny`, `cancel`, `owner ...`). When a step needs the owner it prints the exact
// command for you to type in your own terminal, then watches the read-only approval state.
//
//   node tools/dogfood/run.mjs --dry-run
//   node tools/dogfood/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { createInterface } from 'node:readline';
import {
  OPENCODE_DENIED_PERMISSIONS,
  USAGE,
  buildSteps,
  handoffBox,
  manualBox,
  parseRemoteAnswer,
  remoteBox,
  sideOf,
  ambiguityProblem,
  sideOk,
  validInviteUrl,
  childEnv,
  parseApprovalResult,
  parseArgs,
  parseCommand,
  parseClaude,
  parseOpenCode,
  planText,
  renderResultsMd,
  runPlan,
  scanResults,
  waitForApproval,
} from './lib.mjs';
import {
  approvalNotice,
  approveInvocation,
  combineResults,
  combinedOk,
  encodeLine,
  makeInbox,
  harnessEnvVars,
  parseLine,
  plain,
  remoteRunCommand,
  renderCombinedMd,
  sealLine,
  sshArgs,
  sshPreflight,
  wireOutcome,
} from './remote.mjs';

// Hands-free Mac B: stdout carries only protocol lines; everything for humans goes to stderr.
const HANDS_FREE = process.argv.includes('--hands-free');
const log = (text) => (HANDS_FREE ? console.error(text) : console.log(text));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** The AgentLink program as `{ cmd, args }`; never split on whitespace, no shell involved. */
const splitCommand = parseCommand;

function versionOf(bin, args = ['--version']) {
  const { cmd, args: pre } = splitCommand(bin);
  const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: 20_000 });
  if (r.error || r.status !== 0) return undefined;
  return r.stdout.trim().split('\n')[0] || undefined;
}

function agentlinkRun(options, args) {
  const { cmd, args: pre } = splitCommand(options.agentlinkBin);
  const r = spawnSync(cmd, [...pre, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(process.env),
  });
  return { ok: !r.error && r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Preflight: the programs exist, both agents open, have a card and reach their relays. */
async function preflight(options, dir) {
  const side = sideOf(options.role);
  // Two-machine mode checks only this Mac's harness and agent.
  const versions = {
    agentlink: versionOf(options.agentlinkBin),
    claude: side === 'oc' || options.manual ? undefined : versionOf(options.claudeBin),
    opencode: options.manual ? undefined : versionOf(options.opencodeBin),
  };
  const problems = [];
  const viaOpenCode = options.ccVia === 'opencode';
  const needed = {
    agentlink: true,
    claude: !options.manual && side !== 'oc' && !viaOpenCode,
    opencode: !options.manual && (side !== 'cc' || viaOpenCode),
  };
  for (const [name, v] of Object.entries(versions)) {
    if (needed[name] && v === undefined) {
      problems.push(`${name} is not on PATH or does not answer --version`);
    }
  }
  if (versions.agentlink !== undefined) {
    const mine =
      side === 'cc'
        ? [options.ccAgent]
        : side === 'oc'
          ? [options.ocAgent]
          : [options.ccAgent, options.ocAgent];
    for (const agent of mine) {
      for (const sub of [['doctor'], ['status', '--brief']]) {
        const r = agentlinkRun(options, [...sub, '--agent', agent]);
        await writeFile(join(dir, `preflight.${agent}.${sub[0]}.txt`), r.text, { mode: 0o600 });
        if (!r.ok) {
          problems.push(
            `agentlink ${sub[0]} --agent ${agent} reported a problem (see preflight.${agent}.${sub[0]}.txt)`,
          );
        }
      }
    }
    // M1-23-c: two contacts with the peer's name make every name in a prompt ambiguous.
    const pairs =
      side === 'cc'
        ? [[options.ccAgent, options.ocAgent]]
        : side === 'oc'
          ? [[options.ocAgent, options.ccAgent]]
          : [
              [options.ccAgent, options.ocAgent],
              [options.ocAgent, options.ccAgent],
            ];
    for (const [agent, peer] of pairs) {
      const r = agentlinkRun(options, ['contacts', '--agent', agent]);
      if (!r.ok) continue;
      const problem = ambiguityProblem(r.text, agent, peer);
      if (problem !== undefined) problems.push(problem);
    }
  }
  return { versions, problems };
}

/** Runs one child to the end or the wall-clock limit; no retry. Output goes to files. */
function runChild(cmd, args, { cwd, env, transcript, stderr, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(transcript, { mode: 0o600 });
    const err = createWriteStream(stderr, { mode: 0o600 });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => err.end(() => resolve({ exitCode: code, timedOut })));
    });
  });
}

/** The two harnesses, each with its own MCP config pointing at its own agent. */
async function makeHarnesses(options, dir) {
  const al = splitCommand(options.agentlinkBin);
  const mcpArgs = (agent) => [...al.args, 'mcp', '--agent', agent];
  const ccWork = join(dir, 'workspace-cc');
  const ocWork = join(dir, 'workspace-oc');
  await mkdir(ccWork, { recursive: true, mode: 0o700 });
  await mkdir(ocWork, { recursive: true, mode: 0o700 });
  const ccMcp = join(dir, 'cc.mcp.json');
  await writeFile(
    ccMcp,
    JSON.stringify({
      mcpServers: { agentlink: { command: al.cmd, args: mcpArgs(options.ccAgent) } },
    }),
    { mode: 0o600 },
  );
  // OpenCode: an inline config (highest precedence) that points `agentlink` at its own agent and
  // refuses the shell, web and outside-folder tools, so a hostile message cannot use them.
  const ocConfigFor = (agent) =>
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        agentlink: {
          type: 'local',
          command: [al.cmd, ...mcpArgs(agent)],
          enabled: true,
        },
      },
      // Denied: the shell, subagents, skills, web access and anything outside the project folder.
      // `read`, `edit`, `glob` and `grep` stay allowed on purpose: OpenCode's free tier refuses to run
      // at all ("free tier can only be used from within OpenCode") when the file tools are denied.
      // The project folder is the empty temp dir `workspace-oc`, and `external_directory` is what
      // refuses a read of ~/.agentlink (tested on the owner's Mac; step F1 asserts it on every run).
      permission: Object.fromEntries(OPENCODE_DENIED_PERMISSIONS.map((key) => [key, 'deny'])),
    });
  const ocEnvKeep =
    process.env.OPENROUTER_API_KEY === undefined
      ? {}
      : { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };

  const claude = async (step, prompt) => {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(options.maxTurns),
      '--mcp-config',
      ccMcp,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__agentlink',
      '--no-session-persistence',
      ...(options.ccModel === undefined ? [] : ['--model', options.ccModel]),
    ];
    const transcript = join(dir, `${step.id}.cc.transcript.jsonl`);
    // No API key in its environment: Claude Code uses the owner's subscription login.
    const res = await runChild(options.claudeBin, args, {
      cwd: ccWork,
      env: childEnv(process.env, { DISABLE_AUTOUPDATER: '1' }),
      transcript,
      stderr: join(dir, `${step.id}.cc.stderr.log`),
      timeoutMs: options.stepTimeoutMs,
    });
    return { ...res, ...parseClaude(await readFile(transcript, 'utf8')) };
  };

  const opencodeFor = (agent, tag) => async (step, prompt) => {
    const ocConfig = ocConfigFor(agent);
    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      ocWork,
      ...(options.ocModel === undefined ? [] : ['-m', options.ocModel]),
      prompt,
    ];
    const transcript = join(dir, `${step.id}.${tag}.transcript.jsonl`);
    const res = await runChild(options.opencodeBin, args, {
      cwd: ocWork,
      env: childEnv(process.env, { ...ocEnvKeep, OPENCODE_CONFIG_CONTENT: ocConfig }),
      transcript,
      stderr: join(dir, `${step.id}.${tag}.stderr.log`),
      timeoutMs: options.stepTimeoutMs,
    });
    return { ...res, ...parseOpenCode(await readFile(transcript, 'utf8')) };
  };

  // `--cc-via opencode`: the Claude Code side runs through OpenCode too (a Mac without the claude CLI).
  return {
    cc: options.ccVia === 'opencode' ? opencodeFor(options.ccAgent, 'cc') : claude,
    oc: opencodeFor(options.ocAgent, 'oc'),
  };
}

/**
 * A read-only MCP client for `agentlink_get_approval` on one agent: newline-delimited JSON-RPC over
 * the agent's own `agentlink mcp` process. It can only read an approval's state.
 */
function approvalPoller(options, agent) {
  const al = splitCommand(options.agentlinkBin);
  let child;
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  const start = async () => {
    child = spawn(al.cmd, [...al.args, 'mcp', '--agent', agent], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: childEnv(process.env),
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        } catch {
          // not a response line
        }
      }
    });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentlink-dogfood', version: '0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  };
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('mcp timeout'));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    async state(approvalId) {
      if (child === undefined) await start();
      const result = await rpc('tools/call', {
        name: 'agentlink_get_approval',
        arguments: { approvalId },
      });
      return parseApprovalResult(result);
    },
    close() {
      child?.kill();
    },
  };
}

/** One shared line reader for the hand-off prompts; a closed input answers `undefined`, never hangs. */
function makeAsker() {
  let rl;
  let closed = false;
  return {
    ask(question) {
      return new Promise((resolve) => {
        if (rl === undefined) {
          rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.on('close', () => {
            closed = true;
          });
        }
        if (closed) return resolve(undefined);
        const onClose = () => resolve(undefined);
        rl.once('close', onClose);
        rl.question(question, (answer) => {
          rl.off('close', onClose);
          resolve(answer);
        });
      });
    },
    close() {
      rl?.close();
    },
  };
}

/** Asks until `accept(answer)` returns a value; a closed input gives `accept(undefined)` once. */
async function askUntil(asker, question, accept) {
  for (;;) {
    const answer = await asker.ask(question);
    const value = accept(answer);
    if (value !== undefined || answer === undefined) return value;
  }
}

async function listFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

/** One protocol line to stdout (Mac B, hands-free). */
let runNonce; // Mac B: the secret Mac A sent over stdin; every line B emits carries it
const emit = (kind, ...fields) =>
  process.stdout.write(`${sealLine(encodeLine(kind, ...fields), runNonce)}\n`);

/** Feeds lines from a readable into the inbox; other lines go to `other`. */
function pumpLines(readable, inbox, other, parse = parseLine) {
  const rl = createInterface({ input: readable });
  rl.on('line', (line) => {
    const message = parse(line);
    if (message !== undefined) inbox.push(message);
    else other(plain(line.startsWith('@@AL ') ? '(ignored an unsigned protocol line)' : line));
  });
  return rl;
}

/** Starts role B on Mac B over ssh. The invite link goes over its stdin, never its arguments. */
function startRemote(options, runId, inbox) {
  const child = spawn('ssh', sshArgs(options.remoteHost, remoteRunCommand(options, runId)), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdin.on('error', () => {});
  // Only lines that carry this run's nonce are protocol; Mac B's other output cannot forge one.
  const nonce = randomBytes(16).toString('hex');
  pumpLines(
    child.stdout,
    inbox,
    (line) => log(`[Mac B] ${line}`),
    (line) => parseLine(line, nonce),
  );
  createInterface({ input: child.stderr }).on('line', (line) =>
    console.error(`[Mac B] ${plain(line)}`),
  );
  child.stdin.write(`${encodeLine('NONCE', nonce)}\n`);
  child.on('error', () => inbox.end());
  child.on('close', () => inbox.end());
  process.on('exit', () => child.kill());
  return {
    send(kind, ...fields) {
      if (child.stdin.writable) child.stdin.write(`${encodeLine(kind, ...fields)}\n`);
    },
    async stop() {
      child.stdin.end();
      await Promise.race([new Promise((r) => child.once('close', r)), delay(5_000)]);
      child.kill();
    },
  };
}

/**
 * Runs the approve command with this terminal (stdio inherited; ssh -t for Mac B), so the owner
 * types the code themself. The script passes no code, captures nothing, and adds no harness
 * variable: the AI-app guard of `approve` sees this terminal's own environment.
 */
function runApprove(options, where, agent, approvalId) {
  const inv = approveInvocation(options, where, agent, approvalId, splitCommand);
  return new Promise((resolve) => {
    const child = spawn(inv.cmd, inv.args, { stdio: inv.stdio, env: process.env });
    const timer = setTimeout(() => child.kill(), options.approvalTimeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const side = sideOf(options.role);
  const asker = makeAsker();
  const hf = options.handsFree;
  const tm = options.twoMac;
  const inbox = makeInbox();
  const hfLines = hf ? pumpLines(process.stdin, inbox, () => {}) : undefined;
  hfLines?.on('close', () => inbox.end());
  // Mac B uses Mac A's run ID, so both sides name this run's offer the same way.
  let runId = options.role === 'b' ? options.runId : stamp();
  if (runId === undefined && !options.dryRun && !hf) {
    runId = await askUntil(asker, 'Run ID printed on Mac A (like 20261017-101500): ', (v) =>
      v !== undefined && /^\d{8}-\d{6}$/.test(v.trim()) ? v.trim() : undefined,
    );
    if (runId === undefined) {
      console.error('Mac B needs the run ID that Mac A printed (--run-id).');
      return 2;
    }
  }
  runId ??= stamp();
  const pairing = options.only === undefined || options.only.includes('P2');
  let invite = options.invite;
  if (
    options.role === 'b' &&
    !hf &&
    !options.paired &&
    pairing &&
    invite === undefined &&
    !options.dryRun
  ) {
    invite = await askUntil(asker, 'Invite link printed on Mac A: ', (v) =>
      v !== undefined && validInviteUrl(v.trim()) ? v.trim() : undefined,
    );
    if (invite === undefined) {
      console.error('Mac B needs the invite link that Mac A printed (--invite), unless --paired.');
      return 2;
    }
  }
  const dir = join(options.out, runId);
  const steps = buildSteps({
    cc: options.ccAgent,
    oc: options.ocAgent,
    runId,
    workspace: join(dir, 'workspace-oc'),
  });
  if (options.dryRun) {
    log(planText(options, steps));
    return 0;
  }

  if (tm) {
    // L1: approvals need your own terminal, and Mac B's approve guard cannot see Mac A's environment.
    const inAiApp = harnessEnvVars(process.env);
    if (!process.stdin.isTTY || inAiApp.length > 0) {
      console.error(
        `--two-mac must run from your own terminal (a real TTY, not inside an AI app${inAiApp.length > 0 ? `; found ${inAiApp.join(', ')}` : ''}): you type the owner codes there.`,
      );
      return 1;
    }
    // Key login only (BatchMode): a password prompt would hang the run.
    const check = sshPreflight(options.remoteHost);
    if (!check.ok) {
      console.error(`PREFLIGHT: ${check.help}`);
      console.error('Nothing was started.');
      return 1;
    }
  }
  const startedAt = new Date().toISOString();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  log(`Results: ${dir}`);

  const pre = await preflight(options, dir);
  log(
    `Versions: agentlink ${pre.versions.agentlink ?? '?'}, claude ${pre.versions.claude ?? '?'}, opencode ${pre.versions.opencode ?? '?'}`,
  );
  if (pre.problems.length > 0) {
    for (const p of pre.problems) console.error(`PREFLIGHT: ${p}`);
    console.error('Fix these and run again. Nothing was started.');
    return 1;
  }

  let remote;
  let handsPaired = false;
  if (tm) {
    remote = startRemote(options, runId, inbox);
    log(`Starting Mac B on ${options.remoteHost} (run ID ${runId})...`);
    const ready = await inbox.take((m) => m.kind === 'READY', 180_000);
    if (ready === 'timeout' || ready === 'ended') {
      console.error(
        `Mac B did not become ready (${ready === 'ended' ? 'it stopped; see the [Mac B] lines above' : 'timed out'}). Nothing was started.`,
      );
      await remote.stop();
      return 1;
    }
  }
  if (hf) {
    const first = await inbox.take((m) => m.kind === 'NONCE', 60_000);
    if (typeof first === 'string') {
      console.error('Mac A did not send the run nonce.');
      return 1;
    }
    runNonce = first.nonce;
    emit('READY');
    if (pairing) {
      const got = await inbox.take(
        (m) => m.kind === 'INVITE' || m.kind === 'PAIRED' || m.kind === 'ABORT',
        options.stepTimeoutMs + 120_000,
      );
      if (got === 'timeout' || got === 'ended' || got.kind === 'ABORT') {
        console.error('Mac A did not send the invite (its pairing step failed or it stopped).');
        return 1;
      }
      if (got.kind === 'INVITE') invite = got.url;
      else handsPaired = true;
    }
  }
  const initialCtx = {};
  if (invite !== undefined) initialCtx.inviteUrl = invite;
  if (options.role === 'b' && (options.paired || handsPaired)) {
    const r = agentlinkRun(options, ['contacts', '--agent', options.ocAgent]);
    if (!r.ok || !r.text.includes(options.ccAgent)) {
      console.error(
        `--paired: ${options.ocAgent} has no contact ${options.ccAgent}. Nothing was started.`,
      );
      return 1;
    }
    initialCtx.alreadyPaired = true;
  }
  if (options.role !== undefined) {
    log(
      `Mac ${options.role.toUpperCase()}: ${options.sameOwner ? 'same owner on both Macs' : 'a different owner per Mac'}. Approvals are typed on the Mac that owns the agent; agents never approve.`,
    );
    if (options.role === 'a' && !tm) log(`Run ID for Mac B: ${runId}`);
  }

  const harnesses = await makeHarnesses(options, dir);
  const pollers = {
    cc: approvalPoller(options, options.ccAgent),
    oc: approvalPoller(options, options.ocAgent),
  };
  const agentOf = (h) => (h === 'cc' ? options.ccAgent : options.ocAgent);
  const maxWait = (step) =>
    options.stepTimeoutMs + 120_000 + (step.approval ? options.approvalTimeoutMs : 0);
  const { results } = await runPlan(
    steps,
    {
      now: () => Date.now(),
      log,
      quietApproval: tm || hf,
      onResult(result) {
        if (result.local !== true) return;
        if (tm) remote.send('STEP', result.id, wireOutcome(result.outcome));
        if (hf) emit('STEP', result.id, wireOutcome(result.outcome));
      },
      agentOf,
      // Read-only: the contact list of the first agent, as the owner's CLI prints it.
      confirmPaired: (agent, other) =>
        Promise.resolve(agentlinkRun(options, ['contacts', '--agent', agent])).then(
          (r) => r.ok && r.text.includes(other),
        ),
      side,
      initialCtx,
      manual: options.manual,
      async manualStep(step, prompt) {
        log(`\n${manualBox(step, prompt, options.sameOwner)}`);
        const answer = await askUntil(asker, '> ', parseRemoteAnswer);
        if (answer !== 'ok') return answer;
        // State check through the agentlink CLI only: after the pairing steps the contact must exist.
        if (step.id === 'P3' || step.id === 'P4') {
          const [mine, other] =
            side === 'cc' ? [options.ccAgent, options.ocAgent] : [options.ocAgent, options.ccAgent];
          const r = agentlinkRun(options, ['contacts', '--agent', mine]);
          if (!r.ok || !r.text.includes(other)) return 'unconfirmed';
        }
        return 'ok';
      },
      async waitRemote(step, info) {
        if (!tm && !hf) {
          log(`\n${remoteBox(step, info, options.sameOwner)}`);
          return askUntil(asker, '> ', parseRemoteAnswer);
        }
        // Hands-free: wait for the other Mac's status line for this step; no Enter.
        log(`... waiting for the other Mac: ${step.id} ${step.title}`);
        for (;;) {
          const m = await inbox.take(
            (x) =>
              x.kind === 'ABORT' ||
              (tm && x.kind === 'APPROVAL') ||
              (x.kind === 'STEP' && x.id === step.id),
            maxWait(step),
          );
          if (m === 'timeout' || m === 'ended' || m.kind === 'ABORT') {
            log(
              `The other Mac ${m === 'timeout' ? `did not finish ${step.id} in time` : 'stopped'}; counting ${step.id} as failed.`,
            );
            return 'fail';
          }
          if (m.kind === 'APPROVAL') {
            // Mac B's owner approval: typed here, in this terminal, over ssh -t.
            log(`\n${approvalNotice('remote', options.remoteHost, m.agent, m.approvalId)}`);
            await runApprove(options, 'remote', m.agent, m.approvalId);
            continue;
          }
          return m.outcome === 'ok' ? 'ok' : m.outcome === 'skip' ? 'skip' : 'fail';
        }
      },
      afterStep(step, ctx, result) {
        // Mac A hands the invite to Mac B by hand: printed once, to the terminal only.
        if (tm && step.id === 'P1') {
          // The invite goes to Mac B over the ssh stdin only: never printed, logged or in argv.
          if (result.outcome !== 'pass') remote.send('ABORT');
          else if (ctx.alreadyPaired) remote.send('PAIRED');
          else if (validInviteUrl(ctx.inviteUrl)) remote.send('INVITE', ctx.inviteUrl);
          else remote.send('ABORT');
          return;
        }
        if (options.role !== 'a' || step.id !== 'P1' || result.outcome !== 'pass') return;
        if (ctx.alreadyPaired) {
          log('\nThe agents are already paired. On Mac B add --paired and no --invite.');
        } else if (validInviteUrl(ctx.inviteUrl) && !ctx.inviteUrl.includes("'")) {
          log(`\n${handoffBox(options, runId, ctx.inviteUrl)}`);
        }
      },
      approvalMinutes: options.approvalTimeoutMs / 60_000,
      async run(harness, step, prompt) {
        log(`-> ${step.id} (${harness === 'cc' ? 'Claude Code' : 'OpenCode'}) ${step.title}`);
        const run = await harnesses[harness](step, prompt);
        // The invite link is a secret: it is not kept in the prompt file.
        const shown = invite === undefined ? prompt : prompt.split(invite).join('<invite link>');
        await writeFile(join(dir, `${step.id}.${harness}.prompt.txt`), `${shown}\n`, {
          mode: 0o600,
        });
        return run;
      },
      async waitApproval(harness, approvalId) {
        if (hf) emit('APPROVAL', harness, agentOf(harness), approvalId);
        let timeoutMs = options.approvalTimeoutMs;
        if (tm) {
          // Mac A's own approval: the approve command runs in this terminal; you type the code.
          log(`\n${approvalNotice('local', '', agentOf(harness), approvalId)}`);
          await runApprove(options, 'local', agentOf(harness), approvalId);
          timeoutMs = 30_000; // then just read the decision back
        }
        return waitForApproval({
          poll: () => pollers[harness].state(approvalId),
          now: () => Date.now(),
          sleep,
          timeoutMs,
          intervalMs: options.approvalIntervalMs,
        });
      },
    },
    options.only,
  );
  pollers.cc.close();
  pollers.oc.close();
  asker.close();

  const finalAgents =
    side === 'cc'
      ? [options.ccAgent]
      : side === 'oc'
        ? [options.ocAgent]
        : [options.ccAgent, options.ocAgent];
  for (const agent of finalAgents) {
    const r = agentlinkRun(options, ['status', '--agent', agent]);
    await writeFile(join(dir, `final.${agent}.status.txt`), r.text, { mode: 0o600 });
  }

  const scan = await scanResults(dir, process.env, {
    files: listFiles,
    read: (file) => readFile(file, 'utf8'),
  });
  const scanText =
    scan.findings.length === 0
      ? `clean (${String(scan.scanned)} files)`
      : `${String(scan.findings.length)} FINDINGS`;
  const meta = {
    startedAt,
    ccAgent: options.ccAgent,
    ocAgent: options.ocAgent,
    versions: pre.versions,
    scan: scanText,
    role: options.role,
    sameOwner: options.sameOwner,
  };
  await writeFile(
    join(dir, 'results.json'),
    `${JSON.stringify({ meta, results, findings: scan.findings }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(dir, 'results.md'), renderResultsMd(meta, results), { mode: 0o600 });

  log(`\n${renderResultsMd(meta, results)}`);
  for (const f of scan.findings) {
    console.error(`SECRET SCAN: "${f.name}" found in ${f.file}. Do not share this folder.`);
  }
  log(`Saved to ${dir}`);
  if (hf) {
    emit(
      'FINAL',
      JSON.stringify({
        results,
        findings: scan.findings,
        versions: pre.versions,
        scan: scanText,
        dir,
      }),
    );
    hfLines?.close();
    process.stdin.pause();
  }
  if (tm) {
    // One combined table: each step from the Mac that ran it, plus both secret scans.
    const f = await inbox.take((m) => m.kind === 'FINAL', 180_000);
    await remote.stop();
    const bFinal = typeof f === 'object' ? f.final : undefined;
    if (bFinal === undefined)
      console.error('Mac B did not send its results; counting the run as failed.');
    const rows = combineResults(
      steps.map((x) => x.id),
      results,
      bFinal?.results ?? [],
    );
    const combinedMeta = {
      startedAt,
      ccAgent: options.ccAgent,
      ocAgent: options.ocAgent,
      host: options.remoteHost,
      dirA: dir,
      dirB: bFinal?.dir,
      scanA: scanText,
      scanB: bFinal?.scan ?? 'no result',
      versionsA: pre.versions,
      versionsB: bFinal?.versions,
    };
    const combined = renderCombinedMd(combinedMeta, rows);
    await writeFile(join(dir, 'combined.md'), combined, { mode: 0o600 });
    await writeFile(
      join(dir, 'combined.json'),
      `${JSON.stringify({ meta: combinedMeta, rows, findingsB: bFinal?.findings ?? [] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    log(`\n${combined}`);
    for (const x of bFinal?.findings ?? []) {
      console.error(
        `SECRET SCAN (Mac B): "${x.name}" found in ${x.file}. Do not share that folder.`,
      );
    }
    return combinedOk(rows, scan.findings, bFinal) ? 0 : 1;
  }
  const allPass = side === undefined ? results.every((r) => r.outcome === 'pass') : sideOk(results);
  return allPass && scan.findings.length === 0 ? 0 : 1;
}

process.exitCode = await main();
