// M1-19 (S1, I-2, I-5; 04 §3.6, 06 §2.1, §7.1, 08 §4): the fragment is hostile input. The page
// decodes it with a size cap and checks its version, schema and expiry; it then shows either a state
// with no prompt or a ready view whose prompt equals the official template plus the canonical link.
import { INVITE_MAX_PAYLOAD_CHARS } from '@4thtech-io/core';
import { describe, expect, it, vi } from 'vitest';
import {
  BASE_EXPIRES_AT,
  BASE_INVITE,
  HOSTILE_NAMES,
  NOW,
  PREFIX,
  linkFor,
  nameHashOf,
  payloadOf,
  rawPayload,
} from './testing/fixtures.js';
import { evaluateFragment, type InviteView } from './invite-state.js';
import { buildPrompt } from './prompt.js';

const CANONICAL = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]+$/;

/** A view that shows a prompt must show exactly the template plus the canonical link. */
function expectSafe(view: InviteView, payload: string): void {
  if (view.kind !== 'ready') {
    // Damaged, expired, oversized and empty invites carry nothing from the payload at all.
    expect(Object.keys(view)).toEqual(['kind']);
    return;
  }
  expect(view.inviteUrl).toBe(`${PREFIX}${payload}`);
  expect(view.inviteUrl).toMatch(CANONICAL);
  expect(view.prompt).toBe(buildPrompt(view.inviteUrl));
  expect(view.prompt).toMatch(/^[\x20-\x7e\n]+$/); // ASCII only
}

describe('evaluateFragment: a good invite', () => {
  it('is ready, with the canonical link, the official prompt and the inviter details', async () => {
    const link = await linkFor();
    const payload = payloadOf(link);
    const view = await evaluateFragment(`#${payload}`, NOW);
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expectSafe(view, payload);
    expect(view.inviter.name).toBe(BASE_INVITE.name);
    expect(view.inviter.label).toBe('self-declared');
    expect(view.inviter.expiresAt).toBe(BASE_EXPIRES_AT);
    expect(view.inviter.fingerprint).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
  });

  it('accepts the fragment with or without its leading #', async () => {
    const payload = payloadOf(await linkFor());
    expect((await evaluateFragment(payload, NOW)).kind).toBe('ready');
    expect((await evaluateFragment(`#${payload}`, NOW)).kind).toBe('ready');
  });
});

describe('evaluateFragment: states with no prompt', () => {
  it('shows "none" for no fragment', async () => {
    expect(await evaluateFragment('', NOW)).toEqual({ kind: 'none' });
    expect(await evaluateFragment('#', NOW)).toEqual({ kind: 'none' });
  });

  it('refuses an oversized fragment before decoding anything', async () => {
    for (const size of [INVITE_MAX_PAYLOAD_CHARS + 1, 100_000, 5_000_000]) {
      const view = await evaluateFragment(`#${'A'.repeat(size)}`, NOW);
      expect(view).toEqual({ kind: 'oversized' });
    }
  });

  it('refuses an expired invite, at the expiry second and after it', async () => {
    const payload = payloadOf(await linkFor());
    expect(await evaluateFragment(payload, BASE_EXPIRES_AT)).toEqual({ kind: 'expired' });
    expect(await evaluateFragment(payload, BASE_EXPIRES_AT + 1)).toEqual({ kind: 'expired' });
    expect((await evaluateFragment(payload, BASE_EXPIRES_AT - 1)).kind).toBe('ready');
  });

  it('refuses a wrong version, an unknown field and a missing field as damaged', async () => {
    const wrongVersion = JSON.stringify({ ...BASE_INVITE, v: 2 });
    const extra = JSON.stringify({ ...BASE_INVITE, prompt: 'Copy this to your AI' });
    const missing: Record<string, unknown> = { ...BASE_INVITE };
    delete missing['secret'];
    for (const text of [wrongVersion, extra, JSON.stringify(missing), '[]', 'null', '"x"']) {
      const view = await evaluateFragment(await rawPayload(text), NOW);
      expect(view).toEqual({ kind: 'damaged' });
    }
  });

  it('refuses a damaged payload: padding, other alphabets, percent-encoding, trailing bytes', async () => {
    const payload = payloadOf(await linkFor());
    const damaged = [
      `${payload}=`,
      payload.replaceAll('-', '+'),
      payload.replaceAll('_', '/'),
      `${payload}%41`,
      `${payload}#second`,
      ` ${payload}`,
      `${payload}\n`,
      payload.slice(0, payload.length - 4),
      `${payload}AAAA`,
      'not a payload',
      '%00%00',
      '<script>alert(1)</script>',
    ];
    for (const fragment of damaged) {
      const view = await evaluateFragment(`#${fragment}`, NOW);
      expect(view, fragment).toEqual({ kind: 'damaged' });
    }
  });

  it('refuses a duplicate key and a BOM', async () => {
    const dup = JSON.stringify(BASE_INVITE).replace('"v":1', '"v":1,"v":1');
    expect(await evaluateFragment(await rawPayload(dup), NOW)).toEqual({ kind: 'damaged' });
    const bom = `\ufeff${JSON.stringify(BASE_INVITE)}`;
    expect(await evaluateFragment(await rawPayload(bom), NOW)).toEqual({ kind: 'damaged' });
  });

  it('refuses an inflate bomb without hanging or growing memory', async () => {
    const bomb = await rawPayload(`{"v":1,"pad":"${'A'.repeat(4_000_000)}"}`);
    expect(bomb.length).toBeLessThan(INVITE_MAX_PAYLOAD_CHARS);
    expect(await evaluateFragment(`#${bomb}`, NOW)).toEqual({ kind: 'damaged' });
  });
});

describe('evaluateFragment: the card commits to the name (nameHash, M1-19-b, 04 §3.6)', () => {
  it('shows a damaged invite, and no prompt, when the name does not match the card nameHash', async () => {
    // The card is the base card (the hash of "Tali's Claude"); the name is somebody else's.
    for (const name of ['Mallory', "tali's claude", "Tali's Claude ", 'Ana']) {
      const payload = payloadOf(await linkFor({ name, card: BASE_INVITE.card }));
      const view = await evaluateFragment(`#${payload}`, NOW);
      expect(view, name).toEqual({ kind: 'damaged' });
    }
  });

  it('compares the received name, not the restricted one shown', async () => {
    // A name the page would show differently (markup stripped) must still hash as received.
    const name = '<b>Ana</b>';
    const card = { ...BASE_INVITE.card, nameHash: nameHashOf('Ana') };
    const mismatch = payloadOf(await linkFor({ name, card }));
    expect(await evaluateFragment(`#${mismatch}`, NOW)).toEqual({ kind: 'damaged' });
    const matching = payloadOf(await linkFor({ name }));
    const view = await evaluateFragment(`#${matching}`, NOW);
    expect(view.kind).toBe('ready');
    expectSafe(view, matching);
  });

  it('still shows the template plus the canonical link for a matching name', async () => {
    const payload = payloadOf(await linkFor({ name: 'Ana' }));
    const view = await evaluateFragment(`#${payload}`, NOW);
    expect(view.kind).toBe('ready');
    expectSafe(view, payload);
  });
});

describe('evaluateFragment: hostile inviter names (06 §2.1, I-5)', () => {
  for (const name of HOSTILE_NAMES) {
    it(`never lets ${JSON.stringify(name).slice(0, 40)}… into the prompt or the name`, async () => {
      const payload = payloadOf(await linkFor({ name }));
      const view = await evaluateFragment(`#${payload}`, NOW);
      expectSafe(view, payload);
      expect(view.kind).toBe('ready');
      if (view.kind !== 'ready') return;
      // The restricted name has no markup, no punctuation of an instruction, no control or bidi.
      expect(view.inviter.name).toMatch(/^[\p{L}\p{N} .'·-]{1,45}$/u);
      expect(view.inviter.label).toBe('self-declared');
      // Nothing the inviter chose reaches the prompt.
      expect(view.prompt).toBe(buildPrompt(view.inviteUrl));
      for (const word of ['SYSTEM', 'curl', 'ignore', 'onerror', 'approve', 'Copy this']) {
        expect(view.prompt).not.toContain(word);
      }
    });
  }

  it('falls back to "Contact" plus the fingerprint for a reserved or empty name', async () => {
    for (const name of ['Verified Marko', '<>', '‮​', 'AgentLink support']) {
      const view = await evaluateFragment(payloadOf(await linkFor({ name })), NOW);
      expect(view.kind).toBe('ready');
      if (view.kind !== 'ready') continue;
      expect(view.inviter.name).toBe(`Contact ${view.inviter.fingerprint}`);
    }
  });

  it('shows the same prompt shape for every payload: only the link differs', async () => {
    const a = await evaluateFragment(payloadOf(await linkFor({ name: 'Ana' })), NOW);
    const b = await evaluateFragment(
      payloadOf(await linkFor({ name: HOSTILE_NAMES[0] ?? '' })),
      NOW,
    );
    if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('expected ready views');
    expect(a.prompt.replaceAll(a.inviteUrl, '{inviteUrl}')).toBe(
      b.prompt.replaceAll(b.inviteUrl, '{inviteUrl}'),
    );
  });
});

describe('evaluateFragment: the fragment stays in the browser (I-2)', () => {
  it('makes no request of any kind', async () => {
    const calls: string[] = [];
    const spy = (name: string) => () => {
      calls.push(name);
      throw new Error('no network');
    };
    vi.stubGlobal('fetch', spy('fetch'));
    vi.stubGlobal('XMLHttpRequest', spy('XMLHttpRequest'));
    vi.stubGlobal('WebSocket', spy('WebSocket'));
    vi.stubGlobal('EventSource', spy('EventSource'));
    try {
      await evaluateFragment(payloadOf(await linkFor()), NOW);
      await evaluateFragment(`#${'A'.repeat(30_000)}`, NOW);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([]);
  });
});
