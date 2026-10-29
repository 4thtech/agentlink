// @vitest-environment node
// W4-SHORT-INVITE / W4-INVITES-LIST CONTRACT, page side: the invite client against the shared samples
// (@4thtech-io/types/ui-contract/invites). The server side
// (packages/node/src/local-ui/ui-contract-invites.test.ts) runs the REAL route handlers on the same
// samples. Here the client must build exactly each sample request and read each sample answer as the
// outcome word next to it. apps/local-ui never imports packages/node.
import {
  INVITE_CANCEL,
  INVITE_CANCEL_PATH,
  INVITE_CREATE,
  INVITES_LIST,
  INVITES_PATH,
  INVITES_WORLD,
  SHORT_INVITE_REFUSALS,
  type InvitesAnswer,
} from '@4thtech-io/types/ui-contract/invites';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import {
  INVITE_CANCEL_PATH as PAGE_CANCEL_PATH,
  INVITE_CREATE_PATH as PAGE_CREATE_PATH,
  INVITES_LIST_PATH,
  createInviteApi,
  parseOpenInvites,
} from './invite-api.js';

interface Sent {
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function answering(answer: InvitesAnswer) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const raw = init?.body;
    sent.push({
      path: url.pathname,
      search: url.search,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body:
        raw === undefined || raw === null
          ? ''
          : ArrayBuffer.isView(raw)
            ? new TextDecoder().decode(raw)
            : String(raw),
    });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

const shortAnswer = INVITE_CREATE.short.answer;
const longLink =
  'https://agentlink.4thtech.io/i#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-SeCrEtPaYlOaD';
const longAnswer: InvitesAnswer = {
  status: 200,
  body: {
    ...shortAnswer.body,
    inviteUrl: longLink,
    shareText: `Add my AI agent on AgentLink: ${longLink}`,
    format: 'long',
  },
};

describe('the page and the contract agree on the paths', () => {
  it('uses the contract paths', () => {
    expect(PAGE_CREATE_PATH).toBe(INVITES_PATH);
    expect(INVITES_LIST_PATH).toBe(INVITES_PATH);
    expect(PAGE_CANCEL_PATH).toBe(INVITE_CANCEL_PATH);
  });
});

describe('create', () => {
  it('sends {} for the short link and reads format short', async () => {
    const s = answering(shortAnswer);
    const out = await createInviteApi({ fetch: s.fetch, token: 't' }).create(undefined);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.method).toBe('POST');
    expect(s.sent[0]?.path).toBe(INVITES_PATH);
    expect(s.sent[0]?.search).toBe('');
    expect(s.sent[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(s.sent[0]?.headers.get('x-agentlink-csrf')).toBe('t');
    expect(s.sent[0]?.headers.get('x-agentlink-input')).toBeNull();
    expect(JSON.parse(s.sent[0]?.body ?? '')).toEqual(INVITE_CREATE.short.body);
    expect(out.kind).toBe(INVITE_CREATE.short.outcome);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.invite.inviteUrl).toBe(INVITES_WORLD.shortLink);
    expect(out.invite.format).toBe('short');
    expect(out.invite.expiresAt).toBe(Date.parse(INVITES_WORLD.expiresAt));
  });

  it('sends {long: true} only when asked, with or without the name', async () => {
    const s = answering(longAnswer);
    const api = createInviteApi({ fetch: s.fetch, token: 't' });
    const out = await api.create(undefined, { long: true });
    await api.create('Bo', { long: true });
    await api.create('Bo', { long: false });
    expect(JSON.parse(s.sent[0]?.body ?? '')).toEqual(INVITE_CREATE.long.body);
    expect(JSON.parse(s.sent[1]?.body ?? '')).toEqual({ label: 'Bo', long: true });
    expect(JSON.parse(s.sent[2]?.body ?? '')).toEqual({ label: 'Bo' });
    expect(out.kind).toBe(INVITE_CREATE.long.outcome);
    if (out.kind === 'ok') expect(out.invite.format).toBe('long');
  });

  it('reads the automatic fallback (a long link when short was asked) as ok', async () => {
    const s = answering(longAnswer);
    const out = await createInviteApi({ fetch: s.fetch, token: 't' }).create(undefined);
    expect(JSON.parse(s.sent[0]?.body ?? '')).toEqual({});
    expect(out.kind).toBe('ok');
  });

  it('refuses a short link of the wrong shape and a missing or odd format', async () => {
    for (const mutate of [
      { inviteUrl: 'https://agentlink.4thtech.io/i#2.tooshort', format: 'short' },
      { inviteUrl: INVITES_WORLD.shortLink.replace('/i#', '/x#'), format: 'short' },
      { format: undefined },
      { format: 'tiny' },
    ]) {
      const body = { ...shortAnswer.body, ...mutate };
      const s = answering({ status: 200, body: { ...body, shareText: `x ${body.inviteUrl}` } });
      const out = await createInviteApi({ fetch: s.fetch, token: 't' }).create(undefined);
      expect(out.kind).toBe('failed');
    }
  });
});

describe('open invites (the list)', () => {
  it('reads the samples through the allowlist', () => {
    expect(parseOpenInvites(INVITES_LIST.empty.answer.body)).toEqual([]);
    expect(parseOpenInvites(INVITES_LIST.two.answer.body)).toEqual([
      {
        inviteId: INVITES_WORLD.inviteId,
        name: 'Bo',
        expiresAt: Date.parse(INVITES_WORLD.expiresAt),
      },
      {
        inviteId: INVITES_WORLD.otherInviteId,
        name: null,
        expiresAt: Date.parse(INVITES_WORLD.expiresAt),
      },
    ]);
  });

  it('leaves out a row of another shape and refuses a body of another shape', () => {
    const good = INVITES_LIST.two.answer.body.invites[0];
    expect(
      parseOpenInvites({
        invites: [
          good,
          { ...good, inviteId: '../x' },
          { ...good, expiresAt: 'tomorrow' },
          { ...good, name: 7 },
          { ...good, name: 'x'.repeat(200) },
          'nope',
        ],
      }),
    ).toEqual([
      {
        inviteId: INVITES_WORLD.inviteId,
        name: 'Bo',
        expiresAt: Date.parse(INVITES_WORLD.expiresAt),
      },
    ]);
    expect(parseOpenInvites({})).toBeUndefined();
    expect(parseOpenInvites({ invites: 'x' })).toBeUndefined();
    expect(parseOpenInvites(null)).toBeUndefined();
  });

  it('never carries a link: a link field in a row is not read', () => {
    const row = { ...INVITES_LIST.two.answer.body.invites[0], inviteUrl: INVITES_WORLD.shortLink };
    const [read] = parseOpenInvites({ invites: [row] }) ?? [];
    expect(JSON.stringify(read)).not.toContain('agentlink.4thtech.io');
  });

  it('is read with a plain GET through the same-origin client', async () => {
    const s = answering(INVITES_LIST.two.answer);
    const res = await createApiClient({ fetch: s.fetch, token: 't' }).get(INVITES_LIST_PATH);
    expect(s.sent[0]?.method).toBe('GET');
    expect(s.sent[0]?.path).toBe(INVITES_PATH);
    expect(res.kind).toBe(INVITES_LIST.two.outcome);
  });
});

describe('cancel', () => {
  it.each([
    ['cancelled', INVITE_CANCEL.cancelled],
    ['gone', INVITE_CANCEL.gone],
  ] as const)('builds the sample request and reads %s', async (_name, sample) => {
    const s = answering(sample.answer);
    const out = await createInviteApi({ fetch: s.fetch, token: 't' }).cancel(sample.body.inviteId);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.method).toBe('POST');
    expect(s.sent[0]?.path).toBe(INVITE_CANCEL_PATH);
    expect(s.sent[0]?.search).toBe('');
    expect(s.sent[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(s.sent[0]?.headers.get('x-agentlink-csrf')).toBe('t');
    expect(s.sent[0]?.headers.get('x-agentlink-input')).toBeNull();
    expect(s.sent[0]?.headers.get('x-agentlink-presence')).toBeNull();
    expect(JSON.parse(s.sent[0]?.body ?? '')).toEqual(sample.body);
    expect(out.kind).toBe(sample.outcome);
  });

  it('reads an expired session, and any other answer as failed', async () => {
    const api = (a: InvitesAnswer) =>
      createInviteApi({ fetch: answering(a).fetch, token: 't' }).cancel(INVITES_WORLD.inviteId);
    expect((await api({ status: 401, body: {} })).kind).toBe('session_expired');
    expect((await api({ status: 500, body: {} })).kind).toBe('failed');
    expect((await api({ status: 200, body: { status: 'what' } })).kind).toBe('failed');
  });

  it('never sends an ID of another shape', async () => {
    const s = answering(INVITE_CANCEL.cancelled.answer);
    const out = await createInviteApi({ fetch: s.fetch, token: 't' }).cancel('../../x');
    expect(s.sent).toEqual([]);
    expect(out.kind).toBe('failed');
  });
});

describe('check and accept: short link refusals', () => {
  const proof = { kind: 'code', code: '123456' } as const;

  it('sends the short link as it is and reads unavailable_invite as a refusal', async () => {
    const s = answering(SHORT_INVITE_REFUSALS.unavailable.answer);
    const out = await createInviteApi({ fetch: s.fetch, token: 't' }).check(
      INVITES_WORLD.shortLink,
    );
    expect(JSON.parse(s.sent[0]?.body ?? '')).toEqual({ invite: INVITES_WORLD.shortLink });
    expect(out).toEqual({ kind: 'refused', why: SHORT_INVITE_REFUSALS.unavailable.outcome });
    const a = answering(SHORT_INVITE_REFUSALS.unavailable.answer);
    const acc = await createInviteApi({ fetch: a.fetch, token: 't' }).accept(
      INVITES_WORLD.shortLink,
      proof,
    );
    expect(acc).toEqual({ kind: 'refused', why: 'unavailable' });
  });

  it('reads 503 try_again as a retryable outcome', async () => {
    const s = answering(SHORT_INVITE_REFUSALS.retry.answer);
    const api = createInviteApi({ fetch: s.fetch, token: 't' });
    expect((await api.check(INVITES_WORLD.shortLink)).kind).toBe(
      SHORT_INVITE_REFUSALS.retry.outcome,
    );
    expect((await api.accept(INVITES_WORLD.shortLink, proof)).kind).toBe('try_again');
  });
});
