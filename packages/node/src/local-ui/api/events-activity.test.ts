// TRAY-WIDGET-API (D-155; 08 §1 `GET /api/ui/events`, event `activity`): the stream says when the
// open ID's notification items, activity head or newest exchange changed, so the widget reads
// `GET /api/ui/widget` and `GET /api/ui/activity` again. Content-free: the event carries only `at`;
// the host's opaque mark (widget.ts widgetActivityMark) is compared in the hub and never sent; a
// switch to another ID is a `generation` event, never an `activity` one. Stream limits unchanged.
import { describe, expect, it } from 'vitest';
import type { LiveAgentRecord } from '../live-status.js';
import { LiveEvents, type LiveEventSink, type LiveSnapshot } from './events.js';

class Sink implements LiveEventSink {
  text = '';
  buffered = 0;
  write(chunk: string): void {
    this.text += chunk;
  }
  end(): void {}
  onClose(): void {}
  events(): { event: string; data: Record<string, unknown> }[] {
    return this.text
      .split('\n\n')
      .filter((b) => b.includes('event: '))
      .map((block) => {
        const lines = block.split('\n');
        const event = (lines.find((l) => l.startsWith('event: ')) ?? '').slice(7);
        const data = JSON.parse((lines.find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6));
        return { event, data: data as Record<string, unknown> };
      });
  }
}

const agent = (name: string): LiveAgentRecord => ({
  name,
  label: name,
  current: name === 'default',
  removing: false,
  state: 'offline',
  apps: [],
});

function world() {
  let snapshot: LiveSnapshot = {
    generation: 1,
    current: 'default',
    agents: [agent('default')],
    contactsMark: 'cmark-1',
    activityMark: 'amark-1',
  };
  const hub = new LiveEvents({
    read: () => Promise.resolve(snapshot),
    now: () => 1_800_000_000_000,
    sessionLive: () => true,
    boot: () => 'BOOTboot',
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return {
    hub,
    set(next: Partial<LiveSnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
  };
}

describe('the activity event (TRAY-WIDGET-API)', () => {
  it('is sent once when the mark changes, with only `at`', async () => {
    const w = world();
    const sink = new Sink();
    expect(await w.hub.open(sink, 's1')).toBe('ok');
    await w.hub.tick();
    expect(sink.events().map((e) => e.event)).toEqual(['snapshot']);
    w.set({ activityMark: 'amark-2' });
    await w.hub.tick();
    await w.hub.tick();
    const activity = sink.events().filter((e) => e.event === 'activity');
    expect(activity).toHaveLength(1);
    expect(Object.keys(activity[0]?.data ?? {})).toEqual(['at']);
    expect(sink.text).not.toContain('amark-');
    expect(sink.text).not.toContain('activityMark');
    // Independent of the contacts event.
    expect(sink.events().filter((e) => e.event === 'contacts')).toHaveLength(0);
  });

  it('is not sent for a switch to another ID (that is a generation event)', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ generation: 2, current: 'work', activityMark: 'amark-9' });
    await w.hub.tick();
    const names = sink.events().map((e) => e.event);
    expect(names).toContain('generation');
    expect(names).not.toContain('activity');
    w.set({ activityMark: 'amark-10' });
    await w.hub.tick();
    expect(sink.events().filter((e) => e.event === 'activity')).toHaveLength(1);
  });

  it('is not sent when the mark cannot be read (and not when it comes back unchanged)', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ activityMark: undefined });
    await w.hub.tick();
    w.set({ activityMark: 'amark-1' });
    await w.hub.tick();
    expect(sink.events().filter((e) => e.event === 'activity')).toHaveLength(0);
  });

  it('comes with the contacts event when both marks change', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ activityMark: 'amark-2', contactsMark: 'cmark-2' });
    await w.hub.tick();
    const names = sink.events().map((e) => e.event);
    expect(names.filter((n) => n === 'activity')).toHaveLength(1);
    expect(names.filter((n) => n === 'contacts')).toHaveLength(1);
  });

  it('is replayed from Last-Event-ID like every other event', async () => {
    const w = world();
    const first = new Sink();
    await w.hub.open(first, 's1');
    const lastId = /id: (\S+)/.exec(first.text)?.[1];
    w.set({ activityMark: 'amark-3' });
    await w.hub.tick();
    const again = new Sink();
    await w.hub.open(again, 's1', lastId);
    expect(again.events().map((e) => e.event)).toEqual(['activity']);
  });
});
