// W4-FILES-SAVE (S2; 08 §1 "Save a received file"; 04 §2.5, §2.5.1 `file.save`, §4; D-118; I-1, I-4,
// I-5, I-7; proposed, owner confirms at merge): `POST /api/ui/files/save`, "Save to Inbox".
//
// - An owner route (`presence: true`): the central gate checks presence before the handler runs, and
//   the handler signs exactly one `file.save` that core prepared for this agent from the item ID.
// - The page sends only `{id}` (the received item's ID). Never a name, a folder or a path: anything
//   else is 400 `bad_request` before presence (precheck) and again after it; a traversal-shaped ID
//   never reaches core.
// - A file already saved is 409 `already_saved` before presence: nothing is signed, nothing written.
// - The signed object goes to the save port (core `saveReceivedFile`), which verifies it again and
//   saves with core's own fetch. Each outcome is one fixed answer of the shared ui-contract; no answer
//   carries a name, a folder, a path, a link or an error's text, and nothing is logged here.
import {
  FILE_SAVE_ANSWERS,
  FILE_SAVE_PATH,
  FILE_SAVE_SAMPLE_ID,
  type FileSaveOutcome,
} from '@4thtech-io/types/ui-contract/inbox';
import type { JsonObject } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiFileSaveResult } from '../context.js';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import type { LocalUiOwnerOperation, LocalUiOwnerRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { filesSaveRoute } from './files-save.js';

const AGENT = `0x${'42'.repeat(20)}`;
const ID = FILE_SAVE_SAMPLE_ID;
const ENVELOPE = ID.slice(0, 22);

interface World {
  readonly context: LocalUiContext;
  readonly prepared: string[];
  readonly saved: { body: JsonObject; sig: string }[];
  readonly savedNameCalls: string[];
}

function world(
  options: {
    savedName?: string | null;
    result?: LocalUiFileSaveResult | (() => Promise<LocalUiFileSaveResult>);
    prepare?: 'refused' | 'throws' | 'other-op';
    noClient?: boolean;
    noPort?: boolean;
  } = {},
): World {
  const prepared: string[] = [];
  const saved: { body: JsonObject; sig: string }[] = [];
  const savedNameCalls: string[] = [];
  const body = (id: string): JsonObject => ({
    v: 1,
    agent: AGENT,
    owner: 'ab'.repeat(32),
    op: options.prepare === 'other-op' ? 'agent.label' : 'file.save',
    params: { agent: AGENT, envelopeId: id.slice(0, 22), fileIndex: Number(id.slice(23)) },
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1,
    expiresAt: 601,
  });
  const client = {
    agentId: AGENT,
    filesIo: {
      savedName: (id: string) => {
        savedNameCalls.push(id);
        return Promise.resolve(options.savedName ?? null);
      },
      prepareSave: (id: string) => {
        prepared.push(id);
        if (options.prepare === 'throws') return Promise.reject(new Error('/home/u/secret path'));
        if (options.prepare === 'refused') {
          return Promise.resolve({ status: 'refused', op: 'file.save', reason: 'item_invalid' });
        }
        return Promise.resolve({ status: 'prepared', op: 'file.save', body: body(id), jcs: '' });
      },
    },
  };
  const result = options.result ?? { status: 'saved', name: 'brief.txt' };
  const context = {
    client: options.noClient === true ? undefined : client,
    ...(options.noPort === true
      ? {}
      : {
          fileSave: {
            save: (signed: { body: JsonObject; sig: string }) => {
              saved.push(signed);
              return typeof result === 'function' ? result() : Promise.resolve(result);
            },
          },
        }),
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('never: the save port applies')),
    now: () => 0,
  } as unknown as LocalUiContext;
  return { context, prepared, saved, savedNameCalls };
}

interface Owner {
  readonly operation: LocalUiOwnerOperation;
  readonly reviews: OwnerReview[];
  readonly requests: OwnerSignRequest[][];
}

function owner(): Owner {
  const reviews: OwnerReview[] = [];
  const requests: OwnerSignRequest[][] = [];
  return {
    reviews,
    requests,
    operation: {
      sign: (review, reqs) => {
        reviews.push(review);
        requests.push([...reqs]);
        return Promise.resolve(
          reqs.map((r) =>
            r.kind === 'owner-action'
              ? { kind: 'owner-action', signed: { body: r.action, sig: 'cd'.repeat(64) } }
              : { kind: 'typed-data', signature: '0x' },
          ),
        );
      },
    },
  };
}

const route = filesSaveRoute as LocalUiOwnerRoute;
const request = (input: unknown) => ({
  params: {},
  query: new URLSearchParams(),
  input: input as never,
});
const run = (w: World, o: Owner, input: unknown): Promise<LocalUiResult> =>
  route.handler(w.context, request(input), o.operation);
const precheck = (w: World, input: unknown): Promise<LocalUiResult | undefined> =>
  (route.precheck as NonNullable<LocalUiOwnerRoute['precheck']>)(w.context, request(input));
const answer = (o: FileSaveOutcome) => FILE_SAVE_ANSWERS[o];

describe('POST /api/ui/files/save is one presence route', () => {
  it('is registered once, as a POST owner route with a precheck, at the contract path', () => {
    const found = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path === FILE_SAVE_PATH);
    expect(found).toHaveLength(1);
    expect(found[0]?.method).toBe('POST');
    expect(found[0]?.presence).toBe(true);
    expect(typeof (found[0] as LocalUiOwnerRoute).precheck).toBe('function');
    expect((found[0] as { stub?: unknown }).stub).toBeUndefined();
  });
});

describe('the input is only the item ID (04 §4: no path from the page)', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'x',
    [],
    {},
    { id: '' },
    { id: 42 },
    { id: ENVELOPE },
    { id: `${ENVELOPE}.16` },
    { id: `${ENVELOPE}.0` },
    { id: `../${ID}` },
    { id: `${ID}/../../etc/passwd` },
    { id: '/etc/passwd' },
    { id: '..%2F..%2Fetc' },
    { id: `${ID}\u0000` },
    { id: ID, path: '/tmp/x' },
    { id: ID, name: 'x.txt' },
    { id: ID, folder: '/tmp' },
  ];

  it('precheck refuses anything else with 400 before presence; nothing reaches core', async () => {
    for (const input of bad) {
      const w = world();
      expect(await precheck(w, input), JSON.stringify(input)).toEqual(answer('bad_request'));
      expect(w.prepared).toEqual([]);
      expect(w.savedNameCalls).toEqual([]);
    }
  });

  it('the handler refuses it again after presence, signing nothing', async () => {
    for (const input of bad) {
      const w = world();
      const o = owner();
      expect(await run(w, o, input), JSON.stringify(input)).toEqual(answer('bad_request'));
      expect(o.requests).toEqual([]);
      expect(w.saved).toEqual([]);
    }
  });

  it('precheck lets a well-formed, not yet saved item on', async () => {
    expect(await precheck(world(), { id: ID })).toBeUndefined();
  });
});

describe('Save signs one file.save and hands it to the save port', () => {
  it('saves: one owner-action request for exactly the prepared body, fixed review text, 200', async () => {
    const w = world();
    const o = owner();
    expect(await run(w, o, { id: ID })).toEqual(answer('saved'));
    expect(w.prepared).toEqual([ID]);
    expect(o.requests).toHaveLength(1);
    const reqs = o.requests[0] ?? [];
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.kind).toBe('owner-action');
    const action = (reqs[0] as { action: JsonObject }).action;
    expect(action['op']).toBe('file.save');
    expect(action['params']).toEqual({ agent: AGENT, envelopeId: ENVELOPE, fileIndex: 0 });
    expect(w.saved).toEqual([{ body: action, sig: 'cd'.repeat(64) }]);
    // The review is fixed text: never the sender's file name (I-5).
    expect(o.reviews).toEqual([{ lines: ['Save a received file to your Inbox folder'] }]);
  });

  it('the answer never carries the saved name, a folder or a path', async () => {
    const w = world({ result: { status: 'saved', name: 'brief (1).txt' } });
    const out = await run(w, owner(), { id: ID });
    expect(JSON.stringify(out)).not.toContain('brief');
  });

  it('already saved: 409 before presence and after it; nothing is signed', async () => {
    const w = world({ savedName: 'brief.txt' });
    expect(await precheck(w, { id: ID })).toEqual(answer('already_saved'));
    const o = owner();
    expect(await run(w, o, { id: ID })).toEqual(answer('already_saved'));
    expect(o.requests).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  it('signs nothing when core refuses to prepare, or prepares anything but this file.save', async () => {
    for (const prepare of ['refused', 'other-op'] as const) {
      const w = world({ prepare });
      const o = owner();
      expect(await run(w, o, { id: ID }), prepare).toEqual(answer('bad_request'));
      expect(o.requests).toEqual([]);
    }
    const w = world({ prepare: 'throws' });
    const out = await run(w, owner(), { id: ID });
    expect(out).toEqual(answer('unavailable'));
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('not set up: 409 not_set_up; no save port: 503 unavailable; nothing signed', async () => {
    const o = owner();
    expect(await run(world({ noClient: true }), o, { id: ID })).toEqual(answer('not_set_up'));
    expect(await precheck(world({ noClient: true }), { id: ID })).toEqual(answer('not_set_up'));
    expect(await run(world({ noPort: true }), o, { id: ID })).toEqual(answer('unavailable'));
    expect(o.requests).toEqual([]);
  });

  it('maps each save outcome to its one fixed contract answer', async () => {
    const cases: [LocalUiFileSaveResult, FileSaveOutcome][] = [
      [{ status: 'already_saved' }, 'already_saved'],
      [{ status: 'not_found' }, 'not_found'],
      [{ status: 'rejected', code: 'FILE_TOO_LARGE' }, 'too_large'],
      [{ status: 'rejected', code: 'INTEGRITY_FAILED' }, 'integrity_failed'],
      [{ status: 'rejected', code: 'LINK_EXPIRED' }, 'expired'],
      [{ status: 'rejected', code: 'URL_REFUSED' }, 'location_refused'],
      [{ status: 'rejected', code: 'POLICY_DENIED' }, 'policy_denied'],
      [{ status: 'failed', code: 'inbox_unavailable' }, 'inbox_unavailable'],
      [{ status: 'failed', code: 'file_download_failed' }, 'download_failed'],
      [{ status: 'failed', code: 'files_unavailable' }, 'unavailable'],
      [{ status: 'refused', reason: 'nonce_used' }, 'refused'],
    ];
    for (const [result, outcome] of cases) {
      expect(await run(world({ result }), owner(), { id: ID }), outcome).toEqual(answer(outcome));
    }
    const thrown = await run(
      world({ result: () => Promise.reject(new Error('https://drop.example/secret-link')) }),
      owner(),
      { id: ID },
    );
    expect(thrown).toEqual(answer('unavailable'));
    expect(JSON.stringify(thrown)).not.toContain('drop.example');
  });
});
