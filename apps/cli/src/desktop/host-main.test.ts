// WP-D3: started without the app's pipe on fd 3 (or by an AI app), the desktop host prints one
// fixed line and exits 1: no pipe is opened, no agent, no server, no link.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_HOST_TEXT, desktopHostMain, type DesktopHostMainDeps } from './host-main.js';
import type { PipeProbe } from './pipe.js';

function deps(probe: PipeProbe, env: Record<string, string> = {}) {
  const errors: string[] = [];
  const openPipe = vi.fn();
  const run = vi.fn(() => Promise.resolve(0));
  const main: DesktopHostMainDeps = {
    env,
    probe: () => probe,
    printError: (line) => errors.push(line),
    openPipe: openPipe as never,
    hostDeps: (() => ({})) as never,
    run: run as never,
  };
  return { main, errors, openPipe, run };
}

describe('desktopHostMain', () => {
  it.each<PipeProbe>(['missing', 'refused'])(
    'fd 3 %s: the fixed line, exit 1, nothing started',
    async (probe) => {
      const d = deps(probe);
      await expect(desktopHostMain(d.main)).resolves.toBe(1);
      expect(d.errors).toEqual([DESKTOP_HOST_TEXT.notInApp]);
      expect(d.openPipe).not.toHaveBeenCalled();
      expect(d.run).not.toHaveBeenCalled();
    },
  );

  it('an AI app marker: the same fixed line, even with a pipe', async () => {
    const d = deps('ok', { CLAUDECODE: '1' });
    await expect(desktopHostMain(d.main)).resolves.toBe(1);
    expect(d.errors).toEqual([DESKTOP_HOST_TEXT.notInApp]);
    expect(d.openPipe).not.toHaveBeenCalled();
  });

  it('with the pipe: opens it and runs the host', async () => {
    const d = deps('ok');
    await expect(desktopHostMain(d.main)).resolves.toBe(0);
    expect(d.errors).toEqual([]);
    expect(d.openPipe).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it('opening the pipe throws (not a pipe after all): the fixed line, exit 1, nothing run', async () => {
    const d = deps('ok');
    d.openPipe.mockImplementation(() => {
      throw Object.assign(new TypeError('Unsupported fd type: FILE'), {
        code: 'ERR_INVALID_FD_TYPE',
      });
    });
    await expect(desktopHostMain(d.main)).resolves.toBe(1);
    expect(d.errors).toEqual([DESKTOP_HOST_TEXT.notInApp]);
    expect(d.run).not.toHaveBeenCalled();
  });

  // macOS: with fd 3 absent, the child's fd 3 is the process's own kqueue, which stats as a FIFO,
  // so the probe says `ok`; then net.Socket throws ENOTTY. That must end in the fixed line and
  // exit 1 (no stack trace with install paths), with nothing run.
  it('fd 3 stats as a FIFO but opening it throws ENOTTY (macOS kqueue): the fixed line, exit 1', async () => {
    const d = deps('ok');
    d.openPipe.mockImplementation(() => {
      throw Object.assign(new Error('open ENOTTY'), { code: 'ENOTTY', syscall: 'open' });
    });
    await expect(desktopHostMain(d.main)).resolves.toBe(1);
    expect(d.errors).toEqual([DESKTOP_HOST_TEXT.notInApp]);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('the fixed line names no command, path or link', () => {
    expect(DESKTOP_HOST_TEXT.notInApp).not.toMatch(/`|http|\/|agentlink ui/);
  });
});

describe('host.ts entry', () => {
  it('is hidden: not a bin and not a dispatcher command', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { bin: Record<string, string> };
    expect(Object.values(pkg.bin)).toEqual(['./dist/agentlink.js']);
    const dispatch = readFileSync(
      fileURLToPath(new URL('../dispatch.ts', import.meta.url)),
      'utf8',
    );
    expect(dispatch).not.toMatch(/desktop/i);
  });
});
