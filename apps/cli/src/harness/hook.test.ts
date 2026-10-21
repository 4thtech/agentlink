// The SessionStart hook editor and the installed-binary resolver (M1-29; 06 §7, D-53): the hook is
// added as an exact, additive edit of Claude Code's settings, and only a pinned, absolute command is
// ever written (never `npx`).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessError } from './errors.js';
import { addJsonSessionHook, sessionHookEntry } from './hook.js';
import { resolveInstalledCli } from './installed-cli.js';

const COMMAND = '"/opt/node/bin/node" "/opt/agentlink/dist/agentlink.js" status --brief';

describe('sessionHookEntry', () => {
  it('is one command hook with a short timeout', () => {
    expect(sessionHookEntry(COMMAND)).toEqual({
      matcher: 'startup|resume',
      hooks: [{ type: 'command', command: COMMAND, timeout: 5 }],
    });
  });
});

describe('addJsonSessionHook', () => {
  it('creates the file content when there is none', () => {
    const edit = addJsonSessionHook(undefined, COMMAND);
    expect(edit.status).toBe('change');
    if (edit.status !== 'change') return;
    expect(JSON.parse(edit.text)).toEqual({ hooks: { SessionStart: [sessionHookEntry(COMMAND)] } });
    expect(edit.text.endsWith('\n')).toBe(true);
  });

  it('keeps everything the user wrote and only adds the hook', () => {
    const before = `${JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [] }] } }, null, 2)}\n`;
    const edit = addJsonSessionHook(before, COMMAND);
    expect(edit.status).toBe('change');
    if (edit.status !== 'change') return;
    const after = JSON.parse(edit.text) as Record<string, unknown>;
    expect(after['model']).toBe('x');
    expect((after['hooks'] as Record<string, unknown>)['Stop']).toEqual([{ hooks: [] }]);
    expect((after['hooks'] as Record<string, unknown>)['SessionStart']).toEqual([
      sessionHookEntry(COMMAND),
    ]);
  });

  it('puts the hook before the user own SessionStart hooks', () => {
    const own = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
    const before = `${JSON.stringify({ hooks: { SessionStart: [own] } }, null, 2)}\n`;
    const edit = addJsonSessionHook(before, COMMAND);
    if (edit.status !== 'change') throw new Error('expected change');
    const list = (JSON.parse(edit.text) as { hooks: { SessionStart: unknown[] } }).hooks
      .SessionStart;
    expect(list).toEqual([sessionHookEntry(COMMAND), own]);
  });

  it('reports present when the exact hook is already there', () => {
    const first = addJsonSessionHook(undefined, COMMAND);
    if (first.status !== 'change') throw new Error('expected change');
    expect(addJsonSessionHook(first.text, COMMAND)).toEqual({ status: 'present' });
  });

  it('leaves a different status --brief hook alone (conflict)', () => {
    const other = '"/old/node" "/old/agentlink.js" status --brief';
    const first = addJsonSessionHook(undefined, other);
    if (first.status !== 'change') throw new Error('expected change');
    expect(addJsonSessionHook(first.text, COMMAND)).toEqual({ status: 'conflict' });
  });

  it('refuses malformed JSON and text it could not reproduce exactly', () => {
    expect(() => addJsonSessionHook('{ not json', COMMAND)).toThrow(HarnessError);
    expect(() => addJsonSessionHook('{"a":   1}', COMMAND)).toThrow(HarnessError);
    expect(() => addJsonSessionHook('[]', COMMAND)).toThrow(HarnessError);
    expect(() => addJsonSessionHook('{"hooks":[]}', COMMAND)).toThrow(HarnessError);
    expect(() => addJsonSessionHook('{"hooks":{"SessionStart":{}}}', COMMAND)).toThrow(
      HarnessError,
    );
  });
});

describe('resolveInstalledCli', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-cli-')));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function install(...parts: string[]): Promise<string> {
    const dir = join(root, ...parts);
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@4thtech-io/agentlink', version: '1.2.3' }),
    );
    const script = join(dir, 'dist', 'agentlink.js');
    await writeFile(script, '// cli');
    return script;
  }

  it('returns the quoted absolute node and script of an installed copy', async () => {
    const script = await install('lib', 'node_modules', '@4thtech-io', 'agentlink');
    const prefix = await resolveInstalledCli(script, '/usr/bin/node');
    expect(prefix).toBe(`"/usr/bin/node" "${script}"`);
  });

  it('refuses the temporary npx copy, a relative path and a missing script', async () => {
    const cached = await install(
      '.npm',
      '_npx',
      'abc123',
      'node_modules',
      '@4thtech-io',
      'agentlink',
    );
    expect(await resolveInstalledCli(cached, '/usr/bin/node')).toBeUndefined();
    expect(await resolveInstalledCli('dist/agentlink.js', '/usr/bin/node')).toBeUndefined();
    expect(await resolveInstalledCli(join(root, 'nope.js'), '/usr/bin/node')).toBeUndefined();
    expect(await resolveInstalledCli(undefined, '/usr/bin/node')).toBeUndefined();
  });

  it('refuses a script that is not the AgentLink package', async () => {
    const script = await install('other');
    await writeFile(join(root, 'other', 'package.json'), JSON.stringify({ name: 'other' }));
    expect(await resolveInstalledCli(script, '/usr/bin/node')).toBeUndefined();
  });

  it('refuses paths that cannot be quoted safely', async () => {
    const script = await install('has"quote');
    expect(await resolveInstalledCli(script, '/usr/bin/node')).toBeUndefined();
  });
});
