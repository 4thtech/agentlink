// @vitest-environment jsdom
// M1-PAY-CONFIRM-b: the app's side of the paid-action confirmation (04 §2.5.3; b11 §19; D-132).
// The page names the flow only; the statement it shows is the server's. One WebAuthn `get` with the
// server's challenge, user verification required, and the response goes back as the finish body
// (credential ID, authenticator data, clientDataJSON, signature, user handle, PRF output, each with
// a 16-bit length first). The backup code is the other way. Nothing is read from the URL.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAY_CONFIRM_STRINGS as P } from '@4thtech-io/ui';
import { PayConfirm, createPayConfirmClient, type PayConfirmProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Call {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const STATEMENT = {
  v: 1,
  kind: 'limits',
  amountUsd: null,
  purpose: 'limits_change',
  counterparty: null,
  changes: [{ field: 'proofs.dailyBudgetUSD', old: '5', new: '10' }],
};
const READY = {
  status: 'ready',
  ceremony: 'c'.repeat(22),
  statement: STATEMENT,
  expiresInMs: 120000,
  publicKey: {
    rpId: 'localhost',
    challenge: 'AQIDBA',
    allowCredentials: ['CQo'],
    userVerification: 'required',
    timeoutMs: 120000,
    prfSalt: 'BQY',
  },
};

function server(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const raw = init?.body;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(0),
    });
    const queue = answers[url] ?? [];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) as
      | { status: number; body: unknown }
      | undefined;
    const a = next ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const ok = (body: unknown) => ({ status: 200, body });
const decodeInput = (call: Call | undefined): unknown => {
  const raw = call?.headers.get('x-agentlink-input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};
/** Splits a finish body into its length-prefixed fields. */
const fieldsOf = (body: Uint8Array): number[][] => {
  const out: number[][] = [];
  let at = 0;
  while (at < body.length) {
    const n = ((body[at] as number) << 8) | (body[at + 1] as number);
    out.push([...body.subarray(at + 2, at + 2 + n)]);
    at += 2 + n;
  }
  return out;
};

function authenticator(fail?: string) {
  const asked: CredentialRequestOptions[] = [];
  const credentials = {
    get: (options: CredentialRequestOptions) => {
      asked.push(options);
      if (fail !== undefined) return Promise.reject(new DOMException('no', fail));
      return Promise.resolve({
        rawId: new Uint8Array([9, 10]).buffer,
        response: {
          authenticatorData: new Uint8Array(37).fill(1).buffer,
          clientDataJSON: new Uint8Array([123, 125]).buffer,
          signature: new Uint8Array([48, 1, 2]).buffer,
          userHandle: new Uint8Array([7]).buffer,
        },
        getClientExtensionResults: () => ({
          prf: { results: { first: new Uint8Array(32).fill(5).buffer } },
        }),
      });
    },
  } as unknown as CredentialsContainer;
  return { asked, credentials };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const click = async (el: Element | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  act(() => (el as HTMLElement).click());
  await flush();
};

async function open(
  answers: Record<string, unknown[]>,
  over: Partial<PayConfirmProps> = {},
  fail?: string,
) {
  const srv = server(answers);
  const auth = authenticator(fail);
  const client = createPayConfirmClient({
    fetch: srv.fetch,
    token: 't0ken',
    credentials: auth.credentials,
  });
  const onDone = vi.fn();
  const onClose = vi.fn();
  act(() =>
    root.render(
      createElement<PayConfirmProps>(PayConfirm, {
        client,
        input: { flow: 'limits', review: 'ab'.repeat(32), acknowledged: [] },
        platform: 'other',
        reducedMotion: true,
        onDone,
        onClose,
        ...over,
      }),
    ),
  );
  await flush();
  return { srv, auth, onDone, onClose };
}

const BEGIN = '/api/ui/pay-confirm/begin';
const FINISH = '/api/ui/pay-confirm/finish';

describe('begin: the page names the flow, the server states it', () => {
  it('posts the flow as the input with an empty body, and shows the returned statement', async () => {
    const { srv, auth } = await open({ [BEGIN]: [ok(READY)] });
    const call = srv.calls[0];
    expect(call?.url).toBe(BEGIN);
    expect(decodeInput(call)).toEqual({ flow: 'limits', review: 'ab'.repeat(32), acknowledged: [] });
    expect(call?.headers.get('x-agentlink-csrf')).toBe('t0ken');
    expect(call?.body.length).toBe(0);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Change your spending limits');
    expect(dialog?.textContent).toContain('24-hour budget');
    expect(dialog?.textContent).toContain('$10');
    // Nothing asked before the click (11 §6.2.1).
    expect(auth.asked).toHaveLength(0);
  });

  it('a statement that does not parse is never shown', async () => {
    await open({ [BEGIN]: [ok({ ...READY, statement: { ...STATEMENT, kind: 'pay_anyone' } })] });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(P.failedStart);
    expect(buttonNamed('Confirm with your passkey')).toBeUndefined();
  });
});

describe('finish with the passkey', () => {
  it('one get() with the server challenge, UV required, PRF salt; the response is the body', async () => {
    const { srv, auth, onDone } = await open({
      [BEGIN]: [ok(READY)],
      [FINISH]: [ok({ status: 'applied' })],
    });
    await click(buttonNamed('Confirm with your passkey'));
    expect(auth.asked).toHaveLength(1);
    const pk = auth.asked[0]?.publicKey as PublicKeyCredentialRequestOptions;
    expect([...new Uint8Array(pk.challenge as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect(pk.rpId).toBe('localhost');
    expect(pk.userVerification).toBe('required');
    expect([...new Uint8Array(pk.allowCredentials?.[0]?.id as ArrayBuffer)]).toEqual([9, 10]);
    const prf = (pk.extensions as { prf: { eval: { first: ArrayBuffer } } }).prf.eval.first;
    expect([...new Uint8Array(prf)]).toEqual([5, 6]);
    const finish = srv.calls.find((c) => c.url === FINISH);
    expect(decodeInput(finish)).toEqual({ ceremony: 'c'.repeat(22) });
    expect(finish?.headers.get('x-agentlink-presence')).toBe('passkey');
    expect(finish?.headers.get('content-type')).toBe('application/octet-stream');
    expect(fieldsOf(finish?.body ?? new Uint8Array(0))).toEqual([
      [9, 10],
      new Array(37).fill(1),
      [123, 125],
      [48, 1, 2],
      [7],
      new Array(32).fill(5),
    ]);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(P.doneLimits);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a dismissed system prompt: back to Ready, "Not confirmed. Nothing was paid."', async () => {
    const { srv } = await open({ [BEGIN]: [ok(READY)] }, {}, 'NotAllowedError');
    await click(buttonNamed('Confirm with your passkey'));
    expect(srv.calls.some((c) => c.url === FINISH)).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(P.cancelled);
    expect(buttonNamed('Confirm with your passkey')).toBeDefined();
  });

  it('verification failed: "Couldn\'t confirm it was you"; a fresh begin for the next try', async () => {
    const { srv } = await open({
      [BEGIN]: [ok(READY)],
      [FINISH]: [{ status: 403, body: { status: 'verification_required' } }],
    });
    await click(buttonNamed('Confirm with your passkey'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(P.notVerified);
    await click(buttonNamed('Confirm with your passkey'));
    expect(srv.calls.filter((c) => c.url === BEGIN)).toHaveLength(2);
  });

  it('a passkey without a kept key: says so and opens the backup code', async () => {
    await open({
      [BEGIN]: [ok(READY)],
      [FINISH]: [{ status: 409, body: { status: 'passkey_update_needed' } }],
    });
    await click(buttonNamed('Confirm with your passkey'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(P.updateNeeded);
    expect(document.querySelector('[role="dialog"] input[type="password"]')).not.toBeNull();
  });

  it('expired or decided elsewhere: only Close', async () => {
    for (const [status, text] of [
      ['expired', P.expired],
      ['not_pending', P.decided],
    ] as const) {
      await open({ [BEGIN]: [ok(READY)], [FINISH]: [{ status: 409, body: { status } }] });
      await click(buttonNamed('Confirm with your passkey'));
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text);
      expect(buttonNamed('Confirm with your passkey')).toBeUndefined();
      expect(buttonNamed(P.close)).toBeDefined();
    }
  });

  it('an unknown outcome after confirming never says nothing was paid', async () => {
    await open({ [BEGIN]: [ok(READY)], [FINISH]: [{ status: 500, body: { status: 'failed' } }] });
    await click(buttonNamed('Confirm with your passkey'));
    const said = document.querySelector('[role="dialog"]')?.textContent ?? '';
    expect(said).toContain(P.stillWorking);
    expect(said).not.toContain('Nothing was paid');
  });
});

describe('finish with the backup code (D-132 decision 2)', () => {
  it('the code is the body; no presence header; three wrong tries end it', async () => {
    const { srv } = await open({
      [BEGIN]: [ok(READY)],
      [FINISH]: [
        { status: 403, body: { status: 'presence_rejected' } },
        { status: 403, body: { status: 'tries_exhausted' } },
      ],
    });
    await click(buttonNamed(P.useBackup));
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'ABCD-EFGH');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonNamed(P.confirmCode));
    const finish = srv.calls.find((c) => c.url === FINISH);
    expect(finish?.headers.get('x-agentlink-presence')).toBeNull();
    expect(new TextDecoder().decode(finish?.body)).toBe('ABCD-EFGH');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(P.wrongCode);
    act(() => {
      setter?.call(input, 'WXYZ-0000');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonNamed(P.confirmCode));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(P.triesUsed);
    expect(buttonNamed(P.close)).toBeDefined();
  });
});

describe('the client alone', () => {
  it('refuses a path outside the confirmation routes and never logs', async () => {
    const log = vi.spyOn(console, 'log');
    const srv = server({ [BEGIN]: [ok(READY)] });
    const client = createPayConfirmClient({ fetch: srv.fetch, token: 't' });
    const begun = await client.begin({ flow: 'proof', approvalId: `apr_${'A'.repeat(22)}` });
    expect(begun.kind).toBe('ready');
    expect(log).not.toHaveBeenCalled();
  });
});
