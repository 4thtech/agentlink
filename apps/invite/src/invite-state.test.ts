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
import {
  ASK_AI_TEMPLATE,
  JOIN_COMMAND_TEMPLATE,
  MAX_COMMAND_CHARS,
  buildAskAi,
  buildJoinCommand,
} from './prompt.js';

const CANONICAL = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]{1,21846}$/;

/** A ready view must show exactly the templates plus the canonical link (08 §4, U3-invite). */
function expectSafe(view: InviteView, payload: string): void {
  if (view.kind !== 'ready') {
    // Damaged, oversized and empty invites carry nothing from the payload at all; an expired one
    // at most the restricted name.
    expect(Object.keys(view).filter((k) => k !== 'name')).toEqual(['kind']);
    return;
  }
  expect(view.inviteUrl).toBe(`${PREFIX}${payload}`);
  expect(view.inviteUrl).toMatch(CANONICAL);
  expect(view.command).toBe(JOIN_COMMAND_TEMPLATE.replace('{inviteUrl}', view.inviteUrl));
  expect(view.command).toBe(buildJoinCommand(view.inviteUrl));
  expect(view.command).toBe(`npx -y @4thtech-io/agentlink join '${view.inviteUrl}'`);
  expect(view.sentence).toBe(ASK_AI_TEMPLATE.replaceAll('{inviteUrl}', view.inviteUrl));
  expect(view.sentence).toBe(buildAskAi(view.inviteUrl));
  for (const text of [view.command ?? '', view.sentence]) {
    expect(text).toMatch(/^[\x20-\x7e]+$/); // ASCII only, no line break anywhere
    expect(text.endsWith('\n')).toBe(false);
  }
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
    const expired = { kind: 'expired', name: BASE_INVITE.name };
    expect(await evaluateFragment(payload, BASE_EXPIRES_AT)).toEqual(expired);
    expect(await evaluateFragment(payload, BASE_EXPIRES_AT + 1)).toEqual(expired);
    expect((await evaluateFragment(payload, BASE_EXPIRES_AT - 1)).kind).toBe('ready');
  });

  it('an expired invite names only the restricted name, and none on the fallback (b11 §33.1)', async () => {
    const hostile = await evaluateFragment(
      payloadOf(await linkFor({ name: '<img src=x onerror=alert(1)>' })),
      BASE_EXPIRES_AT,
    );
    expect(hostile.kind).toBe('expired');
    if (hostile.kind === 'expired') expect(hostile.name).toMatch(/^[\p{L}\p{N} .'·-]{1,45}$/u);
    const reserved = await evaluateFragment(
      payloadOf(await linkFor({ name: 'AgentLink support' })),
      BASE_EXPIRES_AT,
    );
    expect(reserved).toEqual({ kind: 'expired' });
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
      // Nothing the inviter chose reaches the command or the sentence.
      for (const text of [view.command ?? '', view.sentence]) {
        for (const word of ['SYSTEM', 'curl', 'ignore', 'onerror', 'approve', 'Copy this']) {
          expect(text).not.toContain(word);
        }
      }
      // The heading says "Someone" exactly when the name rule fell back.
      expect(view.inviter.fallback).toBe(
        view.inviter.name === `Contact ${view.inviter.fingerprint}`,
      );
    });
  }

  it('falls back to "Contact" plus the fingerprint for a reserved or empty name', async () => {
    for (const name of ['Verified Marko', '<>', '‮​', 'AgentLink support']) {
      const view = await evaluateFragment(payloadOf(await linkFor({ name })), NOW);
      expect(view.kind).toBe('ready');
      if (view.kind !== 'ready') continue;
      expect(view.inviter.name).toBe(`Contact ${view.inviter.fingerprint}`);
      // The heading then reads "Someone invites you…" (b11 §33.1).
      expect(view.inviter.fallback).toBe(true);
    }
  });

  it('shows the same command and sentence for every payload: only the link differs', async () => {
    const a = await evaluateFragment(payloadOf(await linkFor({ name: 'Ana' })), NOW);
    const b = await evaluateFragment(
      payloadOf(await linkFor({ name: HOSTILE_NAMES[0] ?? '' })),
      NOW,
    );
    if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('expected ready views');
    expect(a.command?.replaceAll(a.inviteUrl, '{inviteUrl}')).toBe(JOIN_COMMAND_TEMPLATE);
    expect(b.command?.replaceAll(b.inviteUrl, '{inviteUrl}')).toBe(JOIN_COMMAND_TEMPLATE);
    expect(a.sentence.replaceAll(a.inviteUrl, '{inviteUrl}')).toBe(ASK_AI_TEMPLATE);
    expect(b.sentence.replaceAll(b.inviteUrl, '{inviteUrl}')).toBe(ASK_AI_TEMPLATE);
  });
});

describe('U3-invite: crafted fragments give the damaged state, with no command and no sentence (08 §4)', () => {
  it('refuses quotes, spaces, line breaks and every shell metacharacter around a good payload', async () => {
    const payload = payloadOf(await linkFor());
    const injected = [
      "'",
      '"',
      ' ',
      '\n',
      '\r\n',
      '\t',
      ';',
      '$(id)',
      '`id`',
      '%',
      '%27',
      '&',
      '&&calc',
      '|',
      '^',
      '!',
      '\\',
      '#second',
      '<',
      '>',
      '(',
      ')',
      '{',
      '*',
      ' ',
      '​',
      ' ',
      'а', // Cyrillic a, a confusable letter
      '＇', // fullwidth apostrophe
    ];
    for (const bad of injected) {
      for (const fragment of [
        `${payload}${bad}`,
        `${bad}${payload}`,
        `${payload.slice(0, 20)}${bad}${payload.slice(20)}`,
      ]) {
        const view = await evaluateFragment(`#${fragment}`, NOW);
        expect(view, JSON.stringify(bad)).toEqual({ kind: 'damaged' });
      }
    }
  });

  it('refuses a percent-encoded payload and a look-alike host spelled into the fragment', async () => {
    const payload = payloadOf(await linkFor());
    const encoded = [...payload.slice(0, 10)]
      .map((c) => `%${c.charCodeAt(0).toString(16)}`)
      .join('');
    for (const fragment of [
      `${encoded}${payload.slice(10)}`,
      encodeURIComponent(`https://agentlink.4thtech.io/i#${payload}`),
      `https://agentIink.4thtech.io/i#${payload}`,
      `//evil.example/i#${payload}`,
    ]) {
      expect(await evaluateFragment(`#${fragment}`, NOW)).toEqual({ kind: 'damaged' });
    }
  });

  it('builds the link from its own prefix only, never from the address the page was opened at', async () => {
    const payload = payloadOf(await linkFor());
    const view = await evaluateFragment(`#${payload}`, NOW);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.inviteUrl.startsWith('https://agentlink.4thtech.io/i#')).toBe(true);
  });

  it('offers only the sentence when the command would pass 8 000 characters (cmd.exe)', async () => {
    const link = `${PREFIX}${'A'.repeat(MAX_COMMAND_CHARS)}`;
    expect(buildJoinCommand(link)).toBeUndefined();
    expect(buildAskAi(link)).toContain(link);
    const fits = `${PREFIX}${'A'.repeat(100)}`;
    expect(buildJoinCommand(fits)).toBe(`npx -y @4thtech-io/agentlink join '${fits}'`);
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
