// W4-LIVE-STATUS: the live status contract (packages/types ui-contract/live.ts) against the real
// allowlist and hub. The page side (U1-b, apps/local-ui api/live.ts) reads the same samples.
import {
  EVENTS_PATH,
  LIVE_AGENT_FIELDS,
  LIVE_APP_FIELDS,
  LIVE_SAMPLE,
} from '@4thtech-io/types/ui-contract/live';
import { describe, expect, it } from 'vitest';
import { EVENTS_PATH as SERVER_EVENTS_PATH, LiveEvents, type LiveEventSink } from './api/events.js';
import {
  LIVE_AGENT_FIELDS as SERVER_AGENT_FIELDS,
  LIVE_APP_FIELDS as SERVER_APP_FIELDS,
  liveAgentRecord,
} from './live-status.js';

describe('contract (server): live AI app status (08 §1)', () => {
  it('the path and the allowlist are the same on both sides', () => {
    expect(SERVER_EVENTS_PATH).toBe(EVENTS_PATH);
    expect([...SERVER_AGENT_FIELDS]).toEqual([...LIVE_AGENT_FIELDS]);
    expect([...SERVER_APP_FIELDS]).toEqual([...LIVE_APP_FIELDS]);
  });

  it('the real hub writes the sample stream for the sample states', async () => {
    const [snapshot, change] = LIVE_SAMPLE.events;
    let state = snapshot.data;
    let ms = snapshot.data.at * 1000;
    const hub = new LiveEvents({
      read: () =>
        Promise.resolve({
          generation: 1,
          current: 'default',
          agents: state.agents.map(liveAgentRecord),
        }),
      now: () => ms,
      sessionLive: () => true,
      boot: () => 'AAAAAAAA',
      timers: { setInterval: () => 0, clearInterval: () => undefined },
    });
    let text = '';
    const sink: LiveEventSink = {
      write: (chunk) => {
        text += chunk;
      },
      end: () => undefined,
      buffered: 0,
      onClose: () => undefined,
    };
    await hub.open(sink, 's');
    ms += 15_000;
    await hub.tick();
    state = { ...snapshot.data, agents: change.data.agents } as never;
    ms = change.data.at * 1000;
    await hub.tick();
    expect(text).toBe(LIVE_SAMPLE.text);
  });
});
