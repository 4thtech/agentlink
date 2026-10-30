// W4-SHORT-INVITE (S2; D-139, 04 §3.6.2, 08 §4): a short link (`i#2.<43>`) is resolved in the page
// with exactly one GET of the invite object, then runs the same checks as a long link. Only lookupId
// leaves the page; the key, the link and the decrypted invite never do. A 404 is "no longer
// available", a failed fetch can be tried again, anything else is damaged; none of these carries a
// command or a sentence. The command and the sentence carry the short link itself.
import { CoreError, clearShortInviteCache } from '@4thtech-io/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteFetcher } from './drop-fetch.js';
import { evaluateFragment } from './invite-state.js';
import { ASK_AI_TEMPLATE, JOIN_COMMAND_TEMPLATE } from './prompt.js';
import { strings } from './strings.js';
import {
  BASE_EXPIRES_AT,
  BASE_INVITE,
  NOW,
  dropResponse,
  linkFor,
  payloadOf,
  shortFor,
} from './testing/fixtures.js';

const SHORT = /^https:\/\/agentlink\.4thtech\.io\/i#2\.[A-Za-z0-9_-]{43}$/;

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

/** A browser fetch double that serves `answer` and records every request. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  return vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => answer());
}

beforeEach(() => {
  // core keeps resolved short links in memory for a while; each test starts with none.
  clearShortInviteCache();
});

describe('evaluateFragment: a short link', () => {
  it('is ready after exactly one GET to the drop host, with the exact request options', async () => {
    const short = await shortFor();
    const fetch = fakeFetch(() => dropResponse(short.object));
    const view = await evaluateFragment(`#${short.code}`, NOW, inviteFetcher(fetch));
    expect(view.kind).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://drop.agentlink.4thtech.io/v1/i/${short.lookupId}`);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
    if (view.kind !== 'ready') return;
    expect(view.inviter.name).toBe(BASE_INVITE.name);
    expect(view.inviter.expiresAt).toBe(BASE_EXPIRES_AT);
  });

  it('sends only the 22-character lookupId: never the key, the link or the invite', async () => {
    const short = await shortFor();
    const fetch = fakeFetch(() => dropResponse(short.object));
    await evaluateFragment(short.code, NOW, inviteFetcher(fetch));
    const sent = JSON.stringify(fetch.mock.calls.map(([url, init]) => [String(url), init]));
    expect(String(fetch.mock.calls[0]?.[0]).split('/').at(-1)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sent).toContain(short.lookupId);
    expect(sent).not.toContain(short.secretText);
    expect(sent).not.toContain(short.code);
    expect(sent).not.toContain(payloadOf(await linkFor()).slice(0, 40));
    expect(sent).not.toContain('agentlink.4thtech.io/i');
  });

  it('the command and the sentence carry the short link itself, never the resolved invite', async () => {
    const short = await shortFor();
    const view = await evaluateFragment(
      `#${short.code}`,
      NOW,
      inviteFetcher(fakeFetch(() => dropResponse(short.object))),
    );
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.inviteUrl).toBe(short.link);
    expect(view.inviteUrl).toMatch(SHORT);
    expect(view.command).toBe(JOIN_COMMAND_TEMPLATE.replace('{inviteUrl}', short.link));
    expect(view.sentence).toBe(ASK_AI_TEMPLATE.replace('{inviteUrl}', short.link));
    expect(view.command).toBe(`npx -y @4thtech-io/agentlink join '${short.link}'`);
  });

  it('accepts the fragment with or without its leading #', async () => {
    const short = await shortFor();
    const get = inviteFetcher(fakeFetch(() => dropResponse(short.object)));
    expect((await evaluateFragment(short.code, NOW, get)).kind).toBe('ready');
    clearShortInviteCache();
    expect((await evaluateFragment(`#${short.code}`, NOW, get)).kind).toBe('ready');
  });

  it('runs the same checks on the resolved invite: expiry and the name commitment', async () => {
    const short = await shortFor();
    const get = inviteFetcher(fakeFetch(() => dropResponse(short.object)));
    expect(await evaluateFragment(short.code, BASE_EXPIRES_AT, get)).toEqual({
      kind: 'expired',
      name: BASE_INVITE.name,
    });
    const swapped = await shortFor({ name: 'Mallory', card: BASE_INVITE.card }, 8);
    const view = await evaluateFragment(
      swapped.code,
      NOW,
      inviteFetcher(fakeFetch(() => dropResponse(swapped.object))),
    );
    expect(view).toEqual({ kind: 'damaged' });
  });
});

describe('evaluateFragment: a short link that does not resolve (no command, no sentence)', () => {
  it('404: "no longer available", and nothing else', async () => {
    const short = await shortFor();
    const view = await evaluateFragment(
      short.code,
      NOW,
      inviteFetcher(fakeFetch(() => dropResponse(null, 404, {}))),
    );
    expect(view).toEqual({ kind: 'unavailable' });
  });

  it('503, 429 or a network failure: the retryable state', async () => {
    const short = await shortFor();
    for (const status of [503, 429]) {
      clearShortInviteCache();
      const view = await evaluateFragment(
        short.code,
        NOW,
        inviteFetcher(fakeFetch(() => dropResponse(null, status, {}))),
      );
      expect(view, String(status)).toEqual({ kind: 'unreachable' });
    }
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await evaluateFragment(short.code, NOW, inviteFetcher(offline))).toEqual({
      kind: 'unreachable',
    });
  });

  it('a redirect (refused by the browser under redirect: error) never resolves', async () => {
    const short = await shortFor();
    const redirected = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect mode is set to error');
    });
    const view = await evaluateFragment(short.code, NOW, inviteFetcher(redirected));
    expect(['unreachable', 'damaged']).toContain(view.kind);
    expect(Object.keys(view)).toEqual(['kind']);
    const status302 = await evaluateFragment(
      short.code,
      NOW,
      inviteFetcher(
        fakeFetch(() => dropResponse(null, 302, { location: 'https://evil.example/' })),
      ),
    );
    expect(status302).toEqual({ kind: 'damaged' });
  });

  it('a tampered object, or one sealed under another link, is damaged', async () => {
    const short = await shortFor();
    for (const at of [0, 4, 10, 20, short.object.length - 1]) {
      clearShortInviteCache();
      const tampered = new Uint8Array(short.object);
      tampered[at] = (tampered[at] ?? 0) ^ 1;
      const view = await evaluateFragment(
        short.code,
        NOW,
        inviteFetcher(fakeFetch(() => dropResponse(tampered))),
      );
      expect(view, String(at)).toEqual({ kind: 'damaged' });
    }
    clearShortInviteCache();
    const other = await shortFor({}, 9);
    const view = await evaluateFragment(
      short.code,
      NOW,
      inviteFetcher(fakeFetch(() => dropResponse(other.object))),
    );
    expect(view).toEqual({ kind: 'damaged' });
  });

  it('an oversize body is refused as damaged', async () => {
    const short = await shortFor();
    const big = new Uint8Array(17_442);
    big.set(short.object);
    const view = await evaluateFragment(
      short.code,
      NOW,
      inviteFetcher(fakeFetch(() => dropResponse(big))),
    );
    expect(view).toEqual({ kind: 'damaged' });
  });

  it('without a fetcher a short link is damaged, as before D-139', async () => {
    const short = await shortFor();
    expect(await evaluateFragment(short.code, NOW)).toEqual({ kind: 'damaged' });
  });

  it('a malformed short link is damaged and fetches nothing', async () => {
    const short = await shortFor();
    const fetch = fakeFetch(() => dropResponse(short.object));
    const secret = short.code.slice(2);
    for (const bad of [
      `2.${secret.slice(1)}`,
      `2.${secret}A`,
      `2.${secret}=`,
      `2.${secret.slice(0, -1)}+`,
      `2.${secret.slice(0, -1)}/`,
      `2.${secret}#x`,
      `2.${secret.slice(0, -1)}%41`,
      `3.${secret}`,
      '2.',
    ]) {
      expect(await evaluateFragment(`#${bad}`, NOW, inviteFetcher(fetch)), bad).toEqual({
        kind: 'damaged',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a fetcher that throws something unexpected to the retryable state', async () => {
    const short = await shortFor();
    const odd = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await evaluateFragment(short.code, NOW, odd)).toEqual({ kind: 'unreachable' });
    clearShortInviteCache();
    const gone = vi.fn(async () => {
      throw new CoreError('invite_unavailable', 'x');
    });
    expect(await evaluateFragment(short.code, NOW, gone)).toEqual({ kind: 'unavailable' });
  });
});

describe('evaluateFragment: long links are unchanged', () => {
  it('a long link is ready and fetches nothing', async () => {
    const payload = payloadOf(await linkFor());
    const fetch = fakeFetch(() => dropResponse(null, 500, {}));
    const view = await evaluateFragment(`#${payload}`, NOW, inviteFetcher(fetch));
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready')
      expect(view.inviteUrl).toBe(`https://agentlink.4thtech.io/i#${payload}`);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the copy for the new states (11 §5)', () => {
  it('has the exact words', () => {
    expect(strings.states.unavailable).toBe(
      'This invite is no longer available. It may have expired, been used or been cancelled. Ask the person who sent it for a new one.',
    );
    expect(strings.states.unreachable).toBe(
      "Couldn't get the invite right now. Check your connection, then try again.",
    );
    expect(strings.retry).toBe('Try again');
  });
});
