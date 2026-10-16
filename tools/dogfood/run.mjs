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
import process from 'node:process';
import {
  OPENCODE_DENIED_PERMISSIONS,
  USAGE,
  buildSteps,
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

const log = (text) => console.log(text);
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
  const versions = {
    agentlink: versionOf(options.agentlinkBin),
    claude: versionOf(options.claudeBin),
    opencode: versionOf(options.opencodeBin),
  };
  const problems = [];
  for (const [name, v] of Object.entries(versions)) {
    if (v === undefined) problems.push(`${name} is not on PATH or does not answer --version`);
  }
  if (versions.agentlink !== undefined) {
    for (const agent of [options.ccAgent, options.ocAgent]) {
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
  const ocConfig = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      agentlink: {
        type: 'local',
        command: [al.cmd, ...mcpArgs(options.ocAgent)],
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

  const opencode = async (step, prompt) => {
    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      ocWork,
      ...(options.ocModel === undefined ? [] : ['-m', options.ocModel]),
      prompt,
    ];
    const transcript = join(dir, `${step.id}.oc.transcript.jsonl`);
    const res = await runChild(options.opencodeBin, args, {
      cwd: ocWork,
      env: childEnv(process.env, { ...ocEnvKeep, OPENCODE_CONFIG_CONTENT: ocConfig }),
      transcript,
      stderr: join(dir, `${step.id}.oc.stderr.log`),
      timeoutMs: options.stepTimeoutMs,
    });
    return { ...res, ...parseOpenCode(await readFile(transcript, 'utf8')) };
  };

  return { cc: claude, oc: opencode };
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
  const runId = stamp();
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

  const harnesses = await makeHarnesses(options, dir);
  const pollers = {
    cc: approvalPoller(options, options.ccAgent),
    oc: approvalPoller(options, options.ocAgent),
  };
  const agentOf = (h) => (h === 'cc' ? options.ccAgent : options.ocAgent);
  const { results } = await runPlan(
    steps,
    {
      now: () => Date.now(),
      log,
      agentOf,
      // Read-only: the contact list of the first agent, as the owner's CLI prints it.
      confirmPaired: (agent, other) =>
        Promise.resolve(agentlinkRun(options, ['contacts', '--agent', agent])).then(
          (r) => r.ok && r.text.includes(other),
        ),
      approvalMinutes: options.approvalTimeoutMs / 60_000,
      async run(harness, step, prompt) {
        log(`-> ${step.id} (${harness === 'cc' ? 'Claude Code' : 'OpenCode'}) ${step.title}`);
        const run = await harnesses[harness](step, prompt);
        await writeFile(join(dir, `${step.id}.${harness}.prompt.txt`), `${prompt}\n`, {
          mode: 0o600,
        });
        return run;
      },
      waitApproval: (harness, approvalId) =>
        waitForApproval({
          poll: () => pollers[harness].state(approvalId),
          now: () => Date.now(),
          sleep,
          timeoutMs: options.approvalTimeoutMs,
          intervalMs: options.approvalIntervalMs,
        }),
    },
    options.only,
  );
  pollers.cc.close();
  pollers.oc.close();

  for (const agent of [options.ccAgent, options.ocAgent]) {
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
  const allPass = results.every((r) => r.outcome === 'pass');
  return allPass && scan.findings.length === 0 ? 0 : 1;
}

process.exitCode = await main();
