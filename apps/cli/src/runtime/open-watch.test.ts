// F40 (Windows 11, 0.4.10 via the installer): the CLI said "Your browser opened…" when no browser
// opened (explorer.exe exits 1 either way). The line now says "Opening…", and the CLI watches the
// one thing the server knows for sure: whether a one-shot link was used. When none was within the
// check time, one follow-up asks the person to press Enter, which opens a fresh one-shot link. The
// link never reaches the terminal.
import { describe, expect, it } from 'vitest';
import {
  OPEN_CHECK_MS,
  OPEN_TEXT,
  openAndWatch,
  presenceWord,
  setupOpenedLine,
  type OpenWatchDeps,
} from './open-watch.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(opens: readonly boolean[] = [true], over: Partial<OpenWatchDeps> = {}) {
  const out: string[] = [];
  let used = 0;
  let opened = 0;
  let press: (() => void) | undefined;
  let subscribed = 0;
  let unsubscribed = 0;
  const deps: OpenWatchDeps = {
    open: () => {
      const ok = opens[Math.min(opened, opens.length - 1)] ?? true;
      opened += 1;
      return Promise.resolve(ok);
    },
    linksUsed: () => used,
    print: (line) => out.push(line),
    onEnter: (p) => {
      subscribed += 1;
      press = p;
      return () => {
        unsubscribed += 1;
        press = undefined;
      };
    },
    checkMs: 10,
    ...over,
  };
  return {
    deps,
    out,
    use: () => {
      used += 1;
    },
    enter: () => press?.(),
    get opened() {
      return opened;
    },
    get subscribed() {
      return subscribed;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    get listening() {
      return press !== undefined;
    },
  };
}

const LINES = { opened: 'OPENED', failed: 'FAILED' };

describe('openAndWatch (F40)', () => {
  it('a link used in time: the opened line only, no follow-up, Enter never listened for', async () => {
    const r = rig();
    const watch = await openAndWatch(r.deps, LINES);
    expect(watch.opened).toBe(true);
    r.use();
    await tick(40);
    expect(r.out).toEqual(['OPENED']);
    expect(r.subscribed).toBe(0);
    watch.stop();
  });

  it('no link used: one follow-up, then Enter opens a fresh link (a new open call)', async () => {
    const r = rig();
    const watch = await openAndWatch(r.deps, LINES);
    await tick(40);
    expect(r.out).toEqual(['OPENED', OPEN_TEXT.notOpened]);
    expect(r.listening).toBe(true);
    r.enter();
    await tick(1);
    expect(r.opened).toBe(2);
    expect(r.listening).toBe(false);
    expect(r.out).toEqual(['OPENED', OPEN_TEXT.notOpened, OPEN_TEXT.retrying]);
    // This time it loads: nothing more is said.
    r.use();
    await tick(40);
    expect(r.out).toHaveLength(3);
    watch.stop();
  });

  it('still not loaded after a retry: the follow-up again, and Enter again works', async () => {
    const r = rig();
    const watch = await openAndWatch(r.deps, LINES);
    await tick(40);
    r.enter();
    await tick(40);
    expect(r.out).toEqual([
      'OPENED',
      OPEN_TEXT.notOpened,
      OPEN_TEXT.retrying,
      OPEN_TEXT.notOpened,
    ]);
    r.enter();
    await tick(1);
    expect(r.opened).toBe(3);
    watch.stop();
  });

  it('the opener fails: the failed line, the Enter hint, and Enter retries', async () => {
    const r = rig([false, true]);
    const watch = await openAndWatch(r.deps, LINES);
    expect(watch.opened).toBe(false);
    expect(r.out).toEqual(['FAILED', OPEN_TEXT.retryHint]);
    r.enter();
    await tick(1);
    expect(r.opened).toBe(2);
    expect(r.out.at(-1)).toBe(OPEN_TEXT.retrying);
    watch.stop();
  });

  it('a retry whose opener fails says so and keeps listening', async () => {
    const r = rig([true, false]);
    const watch = await openAndWatch(r.deps, LINES);
    await tick(40);
    r.enter();
    await tick(1);
    expect(r.out.at(-1)).toBe(OPEN_TEXT.retryFailed);
    expect(r.listening).toBe(true);
    watch.stop();
  });

  it('no failed line given (init): a failed opener prints nothing and is not retried', async () => {
    const r = rig([false]);
    const watch = await openAndWatch(r.deps, { opened: 'OPENED' });
    expect(watch.opened).toBe(false);
    expect(r.out).toEqual([]);
    expect(r.subscribed).toBe(0);
    watch.stop();
  });

  it('a throwing opener counts as not opened', async () => {
    const r = rig([true], { open: () => Promise.reject(new Error('spawn')) });
    const watch = await openAndWatch(r.deps, LINES);
    expect(watch.opened).toBe(false);
    watch.stop();
  });

  it('without linksUsed or Enter there is no follow-up (nothing to act on)', async () => {
    for (const over of [{ linksUsed: undefined }, { onEnter: undefined }]) {
      const r = rig([true], over);
      const watch = await openAndWatch(r.deps, LINES);
      await tick(40);
      expect(r.out).toEqual(['OPENED']);
      watch.stop();
    }
  });

  it('stop() ends the watch: no later follow-up, Enter unsubscribed', async () => {
    const r = rig();
    const watch = await openAndWatch(r.deps, LINES);
    watch.stop();
    await tick(40);
    expect(r.out).toEqual(['OPENED']);
    const r2 = rig();
    const watch2 = await openAndWatch(r2.deps, LINES);
    await tick(40);
    expect(r2.listening).toBe(true);
    watch2.stop();
    expect(r2.unsubscribed).toBe(1);
    expect(r2.listening).toBe(false);
  });

  it('the check time is about 15 seconds', () => {
    expect(OPEN_CHECK_MS).toBe(15_000);
  });

  it('no line holds a link, a token or a local address', () => {
    const all = [
      ...Object.values(OPEN_TEXT),
      setupOpenedLine('darwin'),
      setupOpenedLine('win32'),
      setupOpenedLine('linux'),
    ].join('\n');
    expect(all).not.toMatch(/https?:\/\/|\?t=|localhost|127\.0\.0\.1/);
    expect(OPEN_TEXT.notOpened).toBe(
      "Your browser didn't open AgentLink. Press Enter here to try again.",
    );
  });
});

// F41: no "setup page"; the platform's own word for the gesture (11 §5: "Approve with your
// passkey / Touch ID"; the first-run page's labels).
describe('setupOpenedLine (F41)', () => {
  it.each([
    ['darwin', 'Touch ID'],
    ['win32', 'Windows Hello'],
    ['linux', 'a passkey'],
  ] as const)('on %s names %s', (platform, word) => {
    expect(presenceWord(platform)).toBe(word);
    const line = setupOpenedLine(platform);
    expect(line).toContain(`with ${word}.`);
    expect(line.startsWith('Opening AgentLink in your browser')).toBe(true);
    expect(line).not.toMatch(/setup page|wallet|seed/i);
  });
});
