// Cursor and Windsurf init targets (M1-36g; 06 §7): where each app keeps its MCP file, the exact
// entry, diff before write, and nothing written without a confirmed apply.
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_IDS,
  CONFIG_PATH_HARNESSES,
  applyHarness,
  configParts,
  detectHarnesses,
  displayPath,
  harnessById,
  isHarnessId,
  planHarness,
  type HarnessContext,
  type HarnessId,
} from './harnesses.js';

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-cw-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const ctx = (extra: Partial<HarnessContext> = {}): HarnessContext => ({
  home,
  env: {},
  now: 1_800_000_000,
  ...extra,
});
const ARGS = ['-y', '@4thtech-io/agentlink', 'mcp'];
const CURSOR = 'cursor' as HarnessId;
const WINDSURF = 'windsurf' as HarnessId;

describe('Cursor', () => {
  it('is a known harness with the global file ~/.cursor/mcp.json on every system', () => {
    expect(isHarnessId('cursor')).toBe(true);
    expect(HARNESS_IDS).toContain(CURSOR);
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(configParts(harnessById(CURSOR), platform)).toEqual(['.cursor', 'mcp.json']);
    }
    expect(displayPath(harnessById(CURSOR))).toBe('~/.cursor/mcp.json');
  });

  it('is detected by its folder', async () => {
    expect((await detectHarnesses(ctx())).map((d) => d.id)).not.toContain(CURSOR);
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    expect((await detectHarnesses(ctx())).map((d) => d.id)).toContain(CURSOR);
  });

  it('shows the diff and writes nothing until applied; then writes the stdio entry', async () => {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    const plan = await planHarness(harnessById(CURSOR), ctx());
    expect(plan.status).toBe('change');
    if (plan.status !== 'change') return;
    expect(plan.diff.join('\n')).toContain('+++ b/~/.cursor/mcp.json');
    expect(await readdir(join(home, '.cursor'))).toEqual([]);
    await applyHarness(plan, ctx());
    expect(JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { agentlink: { type: 'stdio', command: 'npx', args: ARGS } },
    });
  });

  it('keeps other servers, backs up, and appends --agent for a named agent', async () => {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const c = ctx({ agent: 'cursor' });
    const plan = await planHarness(harnessById(CURSOR), c);
    if (plan.status !== 'change') throw new Error('expected change');
    const { backup } = await applyHarness(plan, c);
    expect(backup).toBeDefined();
    const written = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.other).toEqual({ command: 'x' });
    expect(written.mcpServers.agentlink.args).toEqual([...ARGS, '--agent', 'cursor']);
  });

  it('leaves a different agentlink entry alone', async () => {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { agentlink: { command: 'evil' } } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect((await planHarness(harnessById(CURSOR), ctx())).status).toBe('conflict');
  });

  it('refuses malformed JSON without writing', async () => {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(join(home, '.cursor', 'mcp.json'), '{ nope', { mode: 0o600 });
    expect((await planHarness(harnessById(CURSOR), ctx())).status).toBe('blocked');
    expect(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{ nope');
  });
});

describe('Windsurf', () => {
  it('is a known harness; file is ~/.config/devin on macOS and Linux, AppData on Windows', () => {
    expect(isHarnessId('windsurf')).toBe(true);
    const def = harnessById(WINDSURF);
    expect(configParts(def, 'darwin')).toEqual(['.config', 'devin', 'mcp_config.json']);
    expect(configParts(def, 'linux')).toEqual(['.config', 'devin', 'mcp_config.json']);
    expect(configParts(def, 'win32')).toEqual(['AppData', 'Roaming', 'devin', 'mcp_config.json']);
    expect(displayPath(def, undefined, 'linux')).toBe('~/.config/devin/mcp_config.json');
  });

  it('allows --config for an older install that keeps the file elsewhere', () => {
    expect(CONFIG_PATH_HARNESSES).toContain(WINDSURF);
  });

  it('is detected by either the new or the older folder', async () => {
    const linux = ctx({ platform: 'linux' });
    expect((await detectHarnesses(linux)).map((d) => d.id)).not.toContain(WINDSURF);
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true, mode: 0o700 });
    expect((await detectHarnesses(linux)).map((d) => d.id)).toContain(WINDSURF);
  });

  it('shows the diff, writes nothing before apply, then writes command and args only', async () => {
    const c = ctx({ platform: 'linux' });
    const plan = await planHarness(harnessById(WINDSURF), c);
    if (plan.status !== 'change') throw new Error('expected change');
    expect(plan.diff.join('\n')).toContain('~/.config/devin/mcp_config.json');
    expect(await readdir(home)).toEqual([]);
    await applyHarness(plan, c);
    expect(
      JSON.parse(await readFile(join(home, '.config', 'devin', 'mcp_config.json'), 'utf8')),
    ).toEqual({ mcpServers: { agentlink: { command: 'npx', args: ARGS } } });
  });

  it('does not follow XDG_CONFIG_HOME', async () => {
    const c = ctx({ platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/elsewhere' } });
    const plan = await planHarness(harnessById(WINDSURF), c);
    expect(plan.status).toBe('change');
    if (plan.status === 'change') expect(plan.diff.join('\n')).not.toContain('elsewhere');
  });
});
