// NET-UI-B: a mocked `ServersApi` whose answers match the 08 §1 shapes exactly, until the backend
// routes land (NET-PRECHECK, NET-OWNER-SET). Used by the page tests and the screenshot harness;
// production code never imports it. Outcomes follow the words in the address, so a test can ask for
// each state: "slow", "members" (needs sign-in), "write-only", "lossy", "gone", "paid", "tiny",
// a private address (not allowed) or anything not starting with wss:// (invalid).
import type {
  Done,
  NetworkStatus,
  Out,
  Progress,
  Review,
  ServersApi,
  ServersInput,
  TestResult,
} from './api.js';

const hostOf = (url: string): string => url.replace(/^wss:\/\//, '').split('/')[0] ?? url;

export function mockTest(url: string): TestResult {
  const host = hostOf(url);
  const base = { host, signInRequired: false, paymentRequired: false };
  const refused = (reason: NonNullable<TestResult['reason']>): TestResult => ({
    ...base,
    outcome: 'refused',
    reason,
    roundTripMs: null,
  });
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(host)) return refused('not_allowed');
  if (!url.startsWith('wss://')) return refused('invalid');
  if (host.includes('write-only')) return refused('not_accepted');
  if (host.includes('lossy')) return refused('not_kept');
  if (host.includes('gone')) return refused('unreachable');
  if (host.includes('tiny')) return refused('too_small');
  if (host.includes('slow')) return { ...base, outcome: 'slow', reason: null, roundTripMs: 1400 };
  if (host.includes('members')) {
    return { ...base, outcome: 'sign_in', reason: null, roundTripMs: 90, signInRequired: true };
  }
  return {
    ...base,
    outcome: 'ready',
    reason: null,
    roundTripMs: host.includes('primal') ? 62 : 82,
    paymentRequired: host.includes('paid'),
  };
}

export interface MockOptions {
  readonly status?: NetworkStatus;
  readonly progress?: Progress | undefined;
  /** Fixes the answer of the next calls (an error path). */
  readonly confirm?: Out<Done>;
  readonly review?: Out<Review>;
  readonly test?: Out<readonly TestResult[]>;
  /** Waits before answering (ms), so a "testing" or "reading" state can be seen. */
  readonly delayMs?: number;
  /** The leaving servers (their end is 30 days after `now`). */
  readonly leaving?: readonly string[];
  readonly now?: number;
}

export const MOCK_STATUS: NetworkStatus = {
  agent: 'running',
  mode: 'automatic',
  ownCount: 5,
  mixIn: true,
  announceDefault: true,
  change: null,
  previousUntil: null,
};

const DAY = 86_400;

export function createMockServersApi(options: MockOptions = {}): ServersApi {
  const now = options.now ?? 1_795_000_000;
  const wait = async (): Promise<void> => {
    if (options.delayMs !== undefined && options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  };
  const reviewOf = (input: ServersInput): Review => ({
    servers: [
      ...input.servers.map((u) => ({
        host: hostOf(u),
        role: 'own' as const,
        outcome: mockTest(u).outcome,
      })),
      ...(input.automatic
        ? [
            {
              host: 'relay.agentlink.example',
              role: 'automatic' as const,
              outcome: 'ready' as const,
            },
            {
              host: 'relay2.agentlink.example',
              role: 'automatic' as const,
              outcome: 'ready' as const,
            },
          ]
        : []),
    ],
    leaving: (options.leaving ?? ['old1.agentlink.example', 'old2.agentlink.example']).map(
      (host) => ({ host, until: now + 30 * DAY }),
    ),
    contacts: 16,
  });
  return {
    async status() {
      await wait();
      return { kind: 'ok', value: options.status ?? MOCK_STATUS };
    },
    async test(urls) {
      await wait();
      return options.test ?? { kind: 'ok', value: urls.map(mockTest) };
    },
    async review(input) {
      await wait();
      return options.review ?? { kind: 'ok', value: reviewOf(input) };
    },
    async set() {
      await wait();
      return (
        options.confirm ?? { kind: 'ok', value: { contacts: 16, leavingUntil: now + 30 * DAY } }
      );
    },
    async resetReview() {
      await wait();
      return (
        options.review ?? {
          kind: 'ok',
          value: reviewOf({ servers: [], automatic: true, announce: true }),
        }
      );
    },
    async reset() {
      await wait();
      return (
        options.confirm ?? { kind: 'ok', value: { contacts: 16, leavingUntil: now + 30 * DAY } }
      );
    },
    async progress() {
      await wait();
      return { kind: 'ok', value: options.progress };
    },
  };
}
