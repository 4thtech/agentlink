// M1-13a LLM run: driving the two harnesses headless and reading what they did.
//
// - Claude Code: `claude -p` with `--output-format stream-json`, `--max-turns`, `--max-budget-usd`,
//   `--strict-mcp-config` and `--permission-prompts none` (an unanswered permission prompt is a
//   denial), in the agent's own HOME (its ~/.claude/settings.json and ~/.claude/skills).
// - Codex: `codex exec --json` with an OpenRouter model provider (~/.codex/config.toml in the agent's
//   own HOME; wire_api "responses"), stdin closed, skill in ~/.agents/skills.
//
// Each harness process gets only its own API key; the agents' MCP servers (agent-host.mjs) are
// started by the harness from the config written here. Every call has a wall-clock limit and is
// never retried. The raw event stream is the transcript (`<step>.transcript.jsonl`); stderr goes to
// `<step>.stderr.log`. Nothing is printed.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOST, SKILL_FILE, agentEnv, type TestAgent } from '../test/support.js';

/** The documented Claude Code permission and sandbox settings (M1-12b), single source. */
export const CLAUDE_SETTINGS = fileURLToPath(
  new URL('./claude-settings.linux.json', import.meta.url),
);

export type HarnessKind = 'claude' | 'codex';

export interface ToolCall {
  /** The AgentLink tool name without the harness prefix, or the built-in tool's name. */
  readonly name: string;
  readonly input: unknown;
  /** The result as the harness recorded it (text), and whether it was an error or a denial. */
  readonly result: string;
  readonly isError: boolean;
}

export interface HarnessRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly calls: readonly ToolCall[];
  readonly finalText: string;
  readonly transcript: string;
  /** Claude Code: its own cost estimate. Codex: tokens only (cost estimated by the caller). */
  readonly costUsd: number | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number | undefined;
}

export interface HarnessLimits {
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
}

export interface Harness {
  readonly kind: HarnessKind;
  readonly agent: TestAgent;
  /** The project folder the harness runs in. */
  readonly workspace: string;
  run(step: string, prompt: string): Promise<HarnessRun>;
}

const BASE_ENV = ['PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'TMPDIR'];

function harnessEnv(agent: TestAgent, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, HOME: agent.home, ...extra };
}

/** The AGENTS.md / CLAUDE.md snippet from the skill file, with the contacts to keep in sync. */
async function projectSnippet(keepInSync: string | undefined): Promise<string> {
  const skill = await readFile(SKILL_FILE, 'utf8');
  const match = /```markdown\n([\s\S]*?)```/.exec(skill);
  if (match?.[1] === undefined) throw new Error('the skill file has no AGENTS.md snippet');
  const snippet = match[1];
  if (keepInSync !== undefined) {
    return snippet.replace('<contact name>, <contact name>', keepInSync);
  }
  // No contact named: the line is left out, so no handoff may be offered.
  return snippet
    .split('\n')
    .filter((line) => !line.startsWith('- Keep in sync with:'))
    .join('\n');
}

function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    transcript: string;
    stderr: string;
    timeoutMs: number;
  },
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(options.transcript, { mode: 0o600 });
    const err = createWriteStream(options.stderr, { mode: 0o600 });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
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

function parseLines(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null)
        events.push(parsed as Record<string, unknown>);
    } catch {
      // not an event line
    }
  }
  return events;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c ? String(c.text) : JSON.stringify(c),
      )
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
};

/** Reads Claude Code's stream-json events (`assistant` tool_use, `user` tool_result, `result`). */
export function parseClaude(
  transcript: string,
): Omit<HarnessRun, 'exitCode' | 'timedOut' | 'transcript'> {
  const uses = new Map<string, { name: string; input: unknown }>();
  const order: string[] = [];
  const results = new Map<string, { text: string; isError: boolean }>();
  let finalText = '';
  let costUsd: number | undefined;
  let turns: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of parseLines(transcript)) {
    const message = event['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as Record<string, unknown>[])
      : [];
    if (event['type'] === 'assistant') {
      for (const block of content) {
        if (block['type'] === 'tool_use') {
          const id = String(block['id']);
          uses.set(id, {
            name: String(block['name']).replace(/^mcp__agentlink__/, ''),
            input: block['input'],
          });
          order.push(id);
        }
      }
    } else if (event['type'] === 'user') {
      for (const block of content) {
        if (block['type'] === 'tool_result') {
          results.set(String(block['tool_use_id']), {
            text: textOf(block['content']),
            isError: block['is_error'] === true,
          });
        }
      }
    } else if (event['type'] === 'result') {
      finalText = typeof event['result'] === 'string' ? event['result'] : '';
      costUsd = typeof event['total_cost_usd'] === 'number' ? event['total_cost_usd'] : undefined;
      turns = typeof event['num_turns'] === 'number' ? event['num_turns'] : undefined;
      const usage = (event['usage'] ?? {}) as Record<string, unknown>;
      inputTokens =
        Number(usage['input_tokens'] ?? 0) +
        Number(usage['cache_read_input_tokens'] ?? 0) +
        Number(usage['cache_creation_input_tokens'] ?? 0);
      outputTokens = Number(usage['output_tokens'] ?? 0);
    }
  }
  const calls = order.map((id) => {
    const use = uses.get(id) as { name: string; input: unknown };
    const result = results.get(id);
    return {
      name: use.name,
      input: use.input,
      result: result?.text ?? '',
      isError: result?.isError ?? true,
    };
  });
  return { calls, finalText, costUsd, turns, inputTokens, outputTokens };
}

/**
 * Harness-internal tool-loading calls: Claude Code loads deferred MCP tool schemas through its own
 * `ToolSearch` before the first AgentLink call. They are not part of the agent's behaviour under
 * test, so first-call checks skip them. An explicit allowlist: any other call still counts.
 * Codex discovers MCP tools without a tool call, so it has no entry.
 */
export const HARNESS_TOOL_LOADING_CALLS: ReadonlySet<string> = new Set(['ToolSearch']);

/** The first call that is not a harness tool-loading call, or undefined when there is none. */
export function firstSubstantiveCall(run: {
  readonly calls: readonly ToolCall[];
}): ToolCall | undefined {
  return run.calls.find((call) => !HARNESS_TOOL_LOADING_CALLS.has(call.name));
}

/** Reads `codex exec --json` events (`item.completed` mcp_tool_call / agent_message, `turn.completed`). */
export function parseCodex(
  transcript: string,
): Omit<HarnessRun, 'exitCode' | 'timedOut' | 'transcript'> {
  const calls: ToolCall[] = [];
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  for (const event of parseLines(transcript)) {
    if (event['type'] === 'turn.completed') {
      turns += 1;
      const usage = (event['usage'] ?? {}) as Record<string, unknown>;
      inputTokens += Number(usage['input_tokens'] ?? 0);
      outputTokens += Number(usage['output_tokens'] ?? 0);
    }
    if (event['type'] !== 'item.completed') continue;
    const item = (event['item'] ?? {}) as Record<string, unknown>;
    if (item['type'] === 'mcp_tool_call') {
      const error = item['error'];
      calls.push({
        name: String(item['tool']),
        input: item['arguments'],
        result: JSON.stringify(item['result'] ?? null),
        isError: item['status'] === 'failed' || (error !== null && error !== undefined),
      });
    } else if (item['type'] === 'command_execution') {
      calls.push({
        name: 'shell',
        input: item['command'],
        result: String(item['aggregated_output'] ?? ''),
        isError: item['status'] !== 'completed',
      });
    } else if (item['type'] === 'agent_message') {
      finalText = String(item['text'] ?? '');
    }
  }
  return { calls, finalText, costUsd: undefined, turns, inputTokens, outputTokens };
}

/** Claude Code for one agent: settings, skill, project snippet and MCP config in its own HOME. */
export async function claudeHarness(options: {
  agent: TestAgent;
  bin: string;
  model: string;
  apiKey: string;
  relayMap: Readonly<Record<string, number>>;
  keepInSync: string | undefined;
  limits: HarnessLimits;
  artifacts: string;
}): Promise<Harness> {
  const { agent } = options;
  const workspace = join(agent.home, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'CLAUDE.md'), await projectSnippet(options.keepInSync));
  // The skill file, unchanged (M1-12a acceptance), as a user skill.
  await mkdir(join(agent.home, '.claude', 'skills', 'agentlink'), { recursive: true });
  await copyFile(SKILL_FILE, join(agent.home, '.claude', 'skills', 'agentlink', 'SKILL.md'));
  // The M1-12b permission guidance for Linux (D-67, D-68 (3)): guards, not a security boundary.
  // `allow` only lets the scenario run without prompts (an unanswered prompt is a denial).
  // The documented M1-12b Claude Code configuration for Linux (permission deny rules plus the Bash
  // sandbox with `filesystem.denyRead` for ~/.agentlink), read from its single source
  // `claude-settings.linux.json`. The scenario adds only `allow` entries so it runs without
  // prompts (an unanswered prompt is a denial); deny rules win over allow rules.
  const documented = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as {
    permissions: { deny: string[] };
    sandbox: Record<string, unknown>;
  };
  const settings = {
    ...documented,
    permissions: {
      ...documented.permissions,
      allow: [
        'mcp__agentlink',
        'Read(~/notes/**)',
        'Bash(cat ~/notes/*)',
        'Bash(cat ~/.agentlink/*)',
      ],
    },
  };
  await writeFile(
    join(agent.home, '.claude', 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  const mcpConfig = join(agent.home, 'mcp.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        agentlink: {
          command: process.execPath,
          args: [HOST, 'mcp', '--home', agent.home],
          env: agentEnv(agent, options.relayMap),
        },
      },
    }),
  );
  return {
    kind: 'claude',
    agent,
    workspace,
    async run(step, prompt) {
      const transcript = join(options.artifacts, `${step}.transcript.jsonl`);
      const args = [
        '-p',
        prompt,
        '--model',
        options.model,
        '--max-turns',
        String(options.limits.maxTurns),
        '--max-budget-usd',
        String(options.limits.maxBudgetUsd),
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        mcpConfig,
        '--strict-mcp-config',
        '--permission-prompts',
        'none',
        '--no-session-persistence',
      ];
      const { exitCode, timedOut } = await runProcess(options.bin, args, {
        cwd: workspace,
        env: harnessEnv(agent, {
          ANTHROPIC_API_KEY: options.apiKey,
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        }),
        transcript,
        stderr: join(options.artifacts, `${step}.stderr.log`),
        timeoutMs: options.limits.timeoutMs,
      });
      const text = await readFile(transcript, 'utf8');
      return { exitCode, timedOut, transcript, ...parseClaude(text) };
    },
  };
}

/** Codex for one agent: config.toml (OpenRouter provider, AgentLink MCP server) in its own HOME. */
export async function codexHarness(options: {
  agent: TestAgent;
  bin: string;
  model: string;
  apiKey: string;
  relayMap: Readonly<Record<string, number>>;
  keepInSync: string | undefined;
  limits: HarnessLimits;
  artifacts: string;
}): Promise<Harness> {
  const { agent } = options;
  const workspace = join(agent.home, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), await projectSnippet(options.keepInSync));
  // The skill file, unchanged (M1-12a acceptance), as a user skill ($HOME/.agents/skills).
  await mkdir(join(agent.home, '.agents', 'skills', 'agentlink'), { recursive: true });
  await copyFile(SKILL_FILE, join(agent.home, '.agents', 'skills', 'agentlink', 'SKILL.md'));
  const env = agentEnv(agent, options.relayMap);
  const toml = (value: string): string => JSON.stringify(value);
  const config = [
    `model = ${toml(options.model)}`,
    'model_provider = "openrouter"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'check_for_update_on_startup = false',
    '',
    // Shell commands get only the core variables (no API key) in their own environment.
    '[shell_environment_policy]',
    'inherit = "core"',
    'exclude = ["*KEY*", "*TOKEN*", "*SECRET*"]',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[history]',
    'persistence = "none"',
    '',
    '[mcp_servers.agentlink]',
    `command = ${toml(process.execPath)}`,
    `args = [${[HOST, 'mcp', '--home', agent.home].map(toml).join(', ')}]`,
    'required = true',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.agentlink.env]',
    ...Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`),
    '',
  ].join('\n');
  await mkdir(join(agent.home, '.codex'), { recursive: true });
  await writeFile(join(agent.home, '.codex', 'config.toml'), config);
  return {
    kind: 'codex',
    agent,
    workspace,
    async run(step, prompt) {
      const transcript = join(options.artifacts, `${step}.transcript.jsonl`);
      const { exitCode, timedOut } = await runProcess(
        options.bin,
        ['exec', '--json', '--skip-git-repo-check', prompt],
        {
          cwd: workspace,
          env: harnessEnv(agent, { OPENROUTER_API_KEY: options.apiKey, NO_COLOR: '1' }),
          transcript,
          stderr: join(options.artifacts, `${step}.stderr.log`),
          timeoutMs: options.limits.timeoutMs,
        },
      );
      const text = await readFile(transcript, 'utf8');
      return { exitCode, timedOut, transcript, ...parseCodex(text) };
    },
  };
}
