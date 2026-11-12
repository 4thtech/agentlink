// @vitest-environment jsdom
// REL051-UF2 (R1-UI-13, S0): a failed read of the passkey state is "couldn't check", never "passkeys
// aren't available in this browser". The client says `unknown`; the notice says so with Try again.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApprovalsClient } from './client.js';
import { OwnerPanel } from './index.js';
import { APPROVAL_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (status: number, body: unknown = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the approvals client: passkey()', () => {
  it('says unknown when the server errors, does not answer or answers garbage', async () => {
    expect(await createApprovalsClient({ fetch: answer(500), token: 't' }).passkey()).toEqual({
      kind: 'unknown',
    });
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await createApprovalsClient({ fetch: down, token: 't' }).passkey()).toEqual({
      kind: 'unknown',
    });
    expect(await createApprovalsClient({ fetch: answer(401), token: 't' }).passkey()).toEqual({
      kind: 'unknown',
    });
  });

  it('still says no owner on 503 and "no passkey here" on a real answer', async () => {
    expect(await createApprovalsClient({ fetch: answer(503), token: 't' }).passkey()).toEqual({
      kind: 'needs_owner',
    });
    expect(
      await createApprovalsClient({
        fetch: answer(200, { passkey: { rpId: 'example.org' } }),
        token: 't',
      }).passkey(),
    ).toEqual({ kind: 'ready', offered: false });
  });
});

describe('OwnerPanel with a failed read', () => {
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

  it('shows a retry notice and never claims passkeys are missing', () => {
    const retry = vi.fn();
    act(() =>
      root.render(
        h(OwnerPanel, {
          owner: { ready: true, offered: false, unknown: true, retry },
          canPasskey: true,
        }),
      ),
    );
    const text = host.textContent ?? '';
    expect(text).toContain(S.checkFailedTitle);
    expect(text).not.toContain(S.noPasskeys);
    expect(text).not.toContain(S.firstRunTitle);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === S.retry);
    act(() => button?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
