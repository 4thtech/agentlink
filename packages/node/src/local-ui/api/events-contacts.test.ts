// W5-INVITE-FEEDBACK (08 §1 `GET /api/ui/events`, event `contacts`): the stream also says when the
// open agent's contacts or invites changed (an invite was accepted, a pairing completed, a re-pair,
// a cancel), so both sides of an invite update with no reload. The event carries only `at`: the page
// reads the contacts and invites again through the usual reads. The host compares an opaque mark of
// the store (core `pairing.changeMark`) and never sends it; a switch to another agent is a
// `generation` event, never a `contacts` one.
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
    contactsMark: 'mark-1',
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

describe('the contacts event (W5-INVITE-FEEDBACK)', () => {
  it('is sent once when the mark changes, with only `at`', async () => {
    const w = world();
    const sink = new Sink();
    expect(await w.hub.open(sink, 's1')).toBe('ok');
    await w.hub.tick();
    expect(sink.events().map((e) => e.event)).toEqual(['snapshot']);
    w.set({ contactsMark: 'mark-2' });
    await w.hub.tick();
    await w.hub.tick();
    const contacts = sink.events().filter((e) => e.event === 'contacts');
    expect(contacts).toHaveLength(1);
    expect(Object.keys(contacts[0]?.data ?? {})).toEqual(['at']);
    // The mark itself never leaves, and the snapshot does not carry it either.
    expect(sink.text).not.toContain('mark-');
    expect(sink.text).not.toContain('contactsMark');
  });

  it('is not sent for a switch to another agent (that is a generation event)', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ generation: 2, current: 'work', contactsMark: 'mark-9' });
    await w.hub.tick();
    const names = sink.events().map((e) => e.event);
    expect(names).toContain('generation');
    expect(names).not.toContain('contacts');
    // After the switch, a change of the new agent's contacts is announced again.
    w.set({ contactsMark: 'mark-10' });
    await w.hub.tick();
    expect(sink.events().filter((e) => e.event === 'contacts')).toHaveLength(1);
  });

  it('is not sent when the mark cannot be read (and not when it comes back unchanged)', async () => {
    const w = world();
    const sink = new Sink();
    await w.hub.open(sink, 's1');
    w.set({ contactsMark: undefined });
    await w.hub.tick();
    w.set({ contactsMark: 'mark-1' });
    await w.hub.tick();
    expect(sink.events().filter((e) => e.event === 'contacts')).toHaveLength(0);
  });

  it('is replayed from Last-Event-ID like every other event', async () => {
    const w = world();
    const first = new Sink();
    await w.hub.open(first, 's1');
    const lastId = /id: (\S+)/.exec(first.text)?.[1];
    w.set({ contactsMark: 'mark-3' });
    await w.hub.tick();
    const again = new Sink();
    await w.hub.open(again, 's1', lastId);
    expect(again.events().map((e) => e.event)).toEqual(['contacts']);
  });
});
