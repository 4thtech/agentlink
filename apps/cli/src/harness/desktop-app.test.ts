// WP-D7 (S2; plan 2026-11-12 Decision 2 "AI apps", "Translocation (M3)"): the desktop app's layout
// constants, where it is found, and the places an AI app must never be pointed at.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CLI_PARTS,
  BUNDLED_HOST_PARTS,
  BUNDLED_NODE_PARTS,
  appLocationProblem,
  appMcpWords,
  appStartAt,
  installedResources,
  locateDesktopApp,
  quotablePath,
  resourcesOfExecPath,
} from './desktop-app.js';

describe('layout (the WP-D4 build, one module)', () => {
  it('bundled node per system, the CLI and the host inside the installed package', () => {
    expect(BUNDLED_NODE_PARTS.darwin).toEqual(['node', 'bin', 'node']);
    expect(BUNDLED_NODE_PARTS.win32).toEqual(['node', 'node.exe']);
    expect(BUNDLED_CLI_PARTS.join('/')).toBe(
      'core/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
    );
    expect(BUNDLED_HOST_PARTS.join('/')).toBe(
      'core/node_modules/@4thtech-io/agentlink/dist/desktop-host.js',
    );
  });

  it('macOS: the app form points at the bundled node and the CLI, never the host', () => {
    const start = appStartAt('/Applications/AgentLink.app/Contents/Resources', 'darwin');
    expect(start).toEqual({
      node: '/Applications/AgentLink.app/Contents/Resources/node/bin/node',
      cli: '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
    });
    expect(start?.cli).not.toContain('desktop-host');
  });

  it('Windows: node.exe itself, no cmd /c, no .cmd', () => {
    const res = 'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources';
    const start = appStartAt(res, 'win32');
    expect(start?.node).toBe(`${res}\\node\\node.exe`);
    expect(start?.cli).toBe(
      `${res}\\core\\node_modules\\@4thtech-io\\agentlink\\dist\\agentlink.js`,
    );
    const words = appMcpWords(start as NonNullable<typeof start>, 'work');
    expect(words.command).toBe(`${res}\\node\\node.exe`);
    expect(words.args).toEqual([start?.cli, 'mcp', '--agent', 'work']);
    expect([words.command, ...words.args].join(' ')).not.toMatch(/\bcmd\b|\.cmd\b|npx/);
  });

  it('no app on Linux (last); default install places per system', () => {
    expect(appStartAt('/opt/AgentLink/resources', 'linux')).toBeUndefined();
    expect(installedResources('/Users/ana', 'darwin')).toEqual([
      '/Applications/AgentLink.app/Contents/Resources',
      '/Users/ana/Applications/AgentLink.app/Contents/Resources',
    ]);
    expect(installedResources('C:\\Users\\ana', 'win32')).toEqual([
      'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources',
    ]);
    expect(installedResources('/home/ana', 'linux')).toEqual([]);
  });

  it('the running app is recognised from its bundled node only', () => {
    expect(
      resourcesOfExecPath('/Applications/AgentLink.app/Contents/Resources/node/bin/node', 'darwin'),
    ).toBe('/Applications/AgentLink.app/Contents/Resources');
    expect(resourcesOfExecPath('/usr/local/bin/node', 'darwin')).toBeUndefined();
    expect(resourcesOfExecPath('/opt/x/Resources/node/bin/node', 'darwin')).toBeUndefined();
    expect(
      resourcesOfExecPath(
        'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources\\node\\node.exe',
        'win32',
      ),
    ).toBe('C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources');
    expect(resourcesOfExecPath('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBeUndefined();
  });
});

describe('appLocationProblem: never point an AI app at a passing copy', () => {
  const mac = { platform: 'darwin' as const, tmpDir: '/var/folders/ab/T', home: '/Users/ana' };
  const win = {
    platform: 'win32' as const,
    tmpDir: 'C:\\Users\\ana\\AppData\\Local\\Temp',
    home: 'C:\\Users\\ana',
  };

  it('translocated (macOS App Translocation)', () => {
    expect(
      appLocationProblem(
        '/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/AgentLink.app/Contents/Resources/node/bin/node',
        mac,
      ),
    ).toBe('translocated');
  });

  it('a read-only mounted disk image; a writable external disk is fine', () => {
    const p = '/Volumes/AgentLink/AgentLink.app/Contents/Resources/node/bin/node';
    expect(appLocationProblem(p, { ...mac, writable: () => false })).toBe('read_only');
    expect(appLocationProblem(p, { ...mac, writable: () => true })).toBeUndefined();
  });

  it('temporary folders (this process, macOS per-user, /tmp, Windows Temp, npx cache)', () => {
    expect(appLocationProblem('/var/folders/ab/T/x/AgentLink.app/n', mac)).toBe('temporary');
    expect(appLocationProblem('/private/var/folders/zz/q/AgentLink.app/n', mac)).toBe('temporary');
    expect(appLocationProblem('/tmp/AgentLink.app/n', mac)).toBe('temporary');
    expect(appLocationProblem('/private/tmp/AgentLink.app/n', mac)).toBe('temporary');
    expect(appLocationProblem('/Users/ana/.npm/_npx/abc/node_modules/x', mac)).toBe('temporary');
    expect(
      appLocationProblem(
        'C:\\Users\\ana\\AppData\\Local\\Temp\\AgentLink\\resources\\node\\node.exe',
        win,
      ),
    ).toBe('temporary');
    expect(appLocationProblem('c:\\users\\ANA\\appdata\\local\\temp\\x\\node.exe', win)).toBe(
      'temporary',
    );
  });

  it('the installed places are fine', () => {
    expect(
      appLocationProblem('/Applications/AgentLink.app/Contents/Resources/node/bin/node', mac),
    ).toBeUndefined();
    expect(
      appLocationProblem(
        'C:\\Users\\ana\\AppData\\Local\\Programs\\AgentLink\\resources\\node\\node.exe',
        win,
      ),
    ).toBeUndefined();
    // A folder that only starts like the temp folder is not inside it.
    expect(appLocationProblem('/tmpfoo/AgentLink.app/n', mac)).toBeUndefined();
  });

  it('paths that a shell or a .cmd line would read differently are not used', () => {
    expect(quotablePath('/Applications/AgentLink.app/x', 'darwin')).toBe(true);
    expect(quotablePath('/Users/a b/Applications/AgentLink.app/x', 'darwin')).toBe(true);
    for (const bad of ['/x/"y', "/x/'y", '/x/$y', '/x/`y', '/x/%y%', '/x/\ny', '/x\\y', '']) {
      expect(quotablePath(bad, 'darwin')).toBe(false);
    }
    expect(quotablePath('C:\\Users\\ana\\x', 'win32')).toBe(true);
    expect(quotablePath('C:\\Users\\%USERNAME%\\x', 'win32')).toBe(false);
    expect(quotablePath('C:\\Users\\a&b\\x', 'win32')).toBe(false);
  });
});

describe('locateDesktopApp (a fake bundle on disk)', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-desktop-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fake AgentLink.app below `dir`; returns its resources folder. */
  async function bundle(dir: string, name = '@4thtech-io/agentlink'): Promise<string> {
    const res = join(dir, 'AgentLink.app', 'Contents', 'Resources');
    await mkdir(join(res, 'node', 'bin'), { recursive: true });
    await writeFile(join(res, 'node', 'bin', 'node'), 'node');
    const pkg = join(res, 'core', 'node_modules', '@4thtech-io', 'agentlink');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(join(pkg, 'dist', 'agentlink.js'), '// cli');
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name }));
    return res;
  }
  // The test folders live in the real temp folder: tell the check another one.
  const base = {
    platform: 'darwin' as const,
    tempRoots: ['/nonexistent-tmp'],
    execPath: '/usr/bin/node',
  };

  it('finds an installed copy and gives the real paths of its node and CLI', async () => {
    const res = await bundle(join(root, 'Applications'));
    const found = await locateDesktopApp({ ...base, home: root, candidates: [res] });
    expect(found).toEqual({
      status: 'ok',
      resources: res,
      start: appStartAt(res, 'darwin'),
    });
  });

  it('the app this process runs from comes first', async () => {
    const running = await bundle(join(root, 'Running'));
    const other = await bundle(join(root, 'Applications'));
    const found = await locateDesktopApp({
      ...base,
      home: root,
      execPath: join(running, 'node', 'bin', 'node'),
      candidates: [other],
    });
    expect(found?.resources).toBe(running);
  });

  it('none: no files, or not the AgentLink package', async () => {
    expect(await locateDesktopApp({ ...base, home: root, candidates: [join(root, 'x')] })).toBe(
      undefined,
    );
    const res = await bundle(join(root, 'Fake'), 'not-agentlink');
    expect(await locateDesktopApp({ ...base, home: root, candidates: [res] })).toBeUndefined();
  });

  it('a translocated or temporary copy is found but refused', async () => {
    const trans = await bundle(join(root, 'AppTranslocation', 'ABCD', 'd'));
    expect(await locateDesktopApp({ ...base, home: root, candidates: [trans] })).toMatchObject({
      status: 'refused',
      reason: 'translocated',
    });
    const res = await bundle(join(root, 'Downloads'));
    expect(
      await locateDesktopApp({ ...base, tempRoots: [root], home: root, candidates: [res] }),
    ).toMatchObject({ status: 'refused', reason: 'temporary' });
  });
});
