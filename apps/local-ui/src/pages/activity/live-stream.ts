// W4-SETTINGS-ADVANCED: where the live stream's lines come from. THE SEAM FOR U1-b: the page reads a
// `StreamSource`; today `createPollingSource()` makes lines from the changes between two answers of
// api/live.ts (the 5 s polling of the agents). When K1's `GET /api/ui/events` (SSE) is wired into
// api/live.ts, or a source of its own is written, only the source changes; the page does not.
// A line holds a kind and a short text of owner-chosen names (agent, AI app) and states. Never a
// message, key, file name or address. Names are cleaned by the page before they are shown (I-5).
import { LIVE_STREAM_STRINGS as S } from './live-strings.js';
import { getLive, subscribeLive, type LiveSnapshot } from '../../api/live.js';

/** The most lines kept (the oldest drop first). */
export const MAX_STREAM_LINES = 200;

export type StreamKind = 'heartbeat' | 'state';

/** A line as a source reports it. */
export interface RawLine {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly kind: StreamKind;
  readonly text: string;
}

/** A line as the page keeps it. */
export interface StreamLine extends RawLine {
  readonly id: number;
}

export interface StreamSource {
  /** Starts listening; returns the stop. */
  subscribe(onLine: (line: RawLine) => void): () => void;
}

/** App · agent · state, with the key that says whether it changed. */
function entries(s: LiveSnapshot): Map<string, { text: string; state: string }> {
  const out = new Map<string, { text: string; state: string }>();
  for (const a of s.agents) {
    for (const app of a.apps) {
      out.set(`${a.name}\u0000${app.app}`, {
        text: `${app.app} · ${a.label} · ${app.word}`,
        state: app.state,
      });
    }
  }
  return out;
}

/**
 * The lines for the step from `prev` to `next`: on the first answer where every AI app stands
 * (heartbeat); afterwards one line per app whose state changed, appeared or went away (state).
 */
export function diffLines(
  prev: LiveSnapshot | undefined,
  next: LiveSnapshot,
  at: number,
): RawLine[] {
  const now = entries(next);
  if (prev === undefined) {
    return [...now.values()].map((e) => ({ at, kind: 'heartbeat' as const, text: e.text }));
  }
  const before = entries(prev);
  const lines: RawLine[] = [];
  for (const [key, e] of now) {
    if (before.get(key)?.state !== e.state) lines.push({ at, kind: 'state', text: e.text });
  }
  for (const key of before.keys()) {
    if (now.has(key)) continue;
    const [name, app] = key.split('\u0000') as [string, string];
    const label = prev.agents.find((a) => a.name === name)?.label ?? name;
    lines.push({ at, kind: 'state', text: `${app} · ${label} · ${S.notSetUp}` });
  }
  return lines;
}

export interface PollingSeam {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => LiveSnapshot;
  readonly now: () => number;
}

const production: PollingSeam = {
  subscribe: (listener) => subscribeLive(listener),
  get: getLive,
  now: () => Date.now(),
};

/** Today's source: the changes between two answers of the shared live store. */
export function createPollingSource(seam: PollingSeam = production): StreamSource {
  return {
    subscribe(onLine) {
      let prev: LiveSnapshot | undefined;
      const handle = (): void => {
        const snapshot = seam.get();
        // Nothing is said before the first answer.
        if (snapshot.list === undefined && snapshot.agents.length === 0) return;
        const lines = diffLines(prev, snapshot, seam.now());
        prev = snapshot;
        for (const line of lines) onLine(line);
      };
      const stop = seam.subscribe(handle);
      handle();
      return stop;
    },
  };
}
