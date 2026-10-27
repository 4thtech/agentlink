// MSG-FILES-IO-h: the Show in Finder handler (08 §1; 04 §2.5, §4; D-134; I-4, I-7).
//
// - It gets only the item ID the server's gate checked; it reads the sealed saved name from the
//   store (core `filesIo.savedName`) and the Inbox folder from the rules in force, and hands just
//   those two store values to the checked reveal. Nothing from the request is a name or a path.
// - No saved name: 404 `not_found`, and nothing is revealed. Rules that fail closed or a store that
//   does not answer: 503 `unavailable`. Each reveal outcome maps to one fixed answer.
// - Answers never carry the name, the folder or an error's text; nothing is logged here.
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import { UI_NOT_SET_UP, type LocalUiRevealRoute } from '../route-types.js';
import { REVEAL_PATH } from '../routes.js';
import type { RevealOutcome } from '../reveal-file.js';
import { filesRevealRoute } from './files-io.js';

const ID = `${'a1'.repeat(32)}.00`;
const INBOX = '~/AgentLink/Inbox';
const SAVED = 'report (1).pdf';

interface Seen {
  savedName: string[];
  reveal: [string, string][];
}

function setup(
  options: {
    saved?: (id: string) => Promise<string | null>;
    policy?: () => Promise<unknown>;
    outcome?: RevealOutcome;
    noClient?: boolean;
  } = {},
): { context: LocalUiContext; seen: Seen; run: () => ReturnType<LocalUiRevealRoute['handler']> } {
  const seen: Seen = { savedName: [], reveal: [] };
  const client = {
    agentId: 'a',
    filesIo: {
      savedName: (id: string) => {
        seen.savedName.push(id);
        return options.saved === undefined ? Promise.resolve(SAVED) : options.saved(id);
      },
    },
    policy: {
      load:
        options.policy ??
        (() =>
          Promise.resolve({
            mode: 'signed',
            version: 3,
            policy: { files: { inboxFolder: INBOX } },
          })),
    },
  } as unknown as LocalUiReadClient;
  const context: LocalUiContext = {
    client: options.noClient === true ? undefined : client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
  const reveal = (folder: string, name: string): Promise<RevealOutcome> => {
    seen.reveal.push([folder, name]);
    return Promise.resolve(options.outcome ?? 'shown');
  };
  return { context, seen, run: () => filesRevealRoute.handler(context, ID, reveal) };
}

describe('Show in Finder handler (MSG-FILES-IO-h)', () => {
  it('is the reveal kind at the fixed path, a POST', () => {
    expect(filesRevealRoute).toMatchObject({
      method: 'POST',
      path: REVEAL_PATH,
      presence: 'reveal',
    });
  });

  it('reveals the stored saved name inside the rules Inbox folder, by item ID only', async () => {
    const { seen, run } = setup();
    expect(await run()).toEqual({ status: 200, body: { status: 'shown' } });
    expect(seen.savedName).toEqual([ID]);
    expect(seen.reveal).toEqual([[INBOX, SAVED]]);
  });

  it('uses the default rules Inbox folder too', async () => {
    const { seen, run } = setup({
      policy: () =>
        Promise.resolve({ mode: 'defaults', policy: { files: { inboxFolder: '~/In' } } }),
    });
    expect((await run()).status).toBe(200);
    expect(seen.reveal).toEqual([['~/In', SAVED]]);
  });

  it('answers not_set_up without an agent', async () => {
    const { seen, run } = setup({ noClient: true });
    expect(await run()).toBe(UI_NOT_SET_UP);
    expect(seen.reveal).toHaveLength(0);
  });

  it('answers 404 not_found when the store has no saved name for the item', async () => {
    const { seen, run } = setup({ saved: () => Promise.resolve(null) });
    expect(await run()).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(seen.reveal).toHaveLength(0);
  });

  it('answers 503 unavailable when the store or the rules do not answer, or fail closed', async () => {
    for (const options of [
      { saved: () => Promise.reject(new Error(`/Users/x/${SAVED}`)) },
      { policy: () => Promise.reject(new Error('policy')) },
      { policy: () => Promise.resolve({ mode: 'fail_closed', problem: 'tampered' }) },
      { policy: () => Promise.resolve({ mode: 'signed', version: 1, policy: { files: {} } }) },
    ]) {
      const { seen, run } = setup(options);
      const result = await run();
      expect(result).toEqual({ status: 503, body: { error: 'unavailable' } });
      expect(JSON.stringify(result)).not.toContain(SAVED);
      expect(seen.reveal).toHaveLength(0);
    }
  });

  it('maps each reveal outcome to one fixed answer, never the name or the folder', async () => {
    const cases: [RevealOutcome, number, Record<string, string>][] = [
      ['shown', 200, { status: 'shown' }],
      ['not_found', 404, { error: 'not_found' }],
      ['refused', 403, { error: 'refused' }],
      ['unavailable', 503, { error: 'unavailable' }],
      ['not_opened', 502, { error: 'not_opened' }],
    ];
    for (const [outcome, status, body] of cases) {
      const result = await setup({ outcome }).run();
      expect(result, outcome).toEqual({ status, body });
      expect(JSON.stringify(result)).not.toMatch(/Inbox|report/);
    }
  });
});
