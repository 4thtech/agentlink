// NET-ROUTE (08 §1 `GET /api/ui/events`, event `network`): the stream says when the open ID's
// message-network facts changed (a finished check or new per-server counters), so Advanced › Message
// network reads `GET /api/ui/network` again. Content-free: the event carries only `at`; the host's
// opaque mark (network-view.ts) is compared in the hub and never sent; a switch to another ID is a
// `generation` event, never a `network` one.
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
    networkMark: 'nmark-1',
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

describe('the network event (NET-ROUTE)', () => {
  it('is sent once when the mark changes, with only `at`', async () => {
    const w = world();
    const sink = new Sink();
    expect(await w.hub.open(sink, 's1')).toBe('ok');
    await w.hub.tick();
    w.set({ networkMark: 'nmark-2' });
    await w.hub.tick();
    await w.hub.tick();
    const network = sink.events().filter((e) => e.event === 'network');
    expect(network).toHaveLength(1);
    expect(Object.keys(network[0]?.data ?? {})).toEqual(['at']);
    expect(sink.text).not.toContain('nmark-');
    expect(sink.text).not.toContain('networkMark');
  });

  it('is not sent for a switch, nor when the mark cannot be read', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ generation: 2, current: 'work', networkMark: 'nmark-9' });
    await w.hub.tick();
    expect(sink.events().map((e) => e.event)).not.toContain('network');
    w.set({ networkMark: undefined });
    await w.hub.tick();
    w.set({ networkMark: 'nmark-9' });
    await w.hub.tick();
    expect(sink.events().filter((e) => e.event === 'network')).toHaveLength(0);
  });
});
