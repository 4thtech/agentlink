// HOTFIX-045-REMOVE-FIRSTRUN (S2; 04 §2.5 "Removing an agent"; 06 §6 "Open agents and removal";
// 08 §1; D-138): a fresh user installs, runs first run, and removes the agent in the SAME app
// session that first run started. That session is the no-agent app host (`startUiWelcome`, apps/cli
// ui-host.ts); before this fix it got no removal port, so `POST /api/ui/agents/remove` answered 501
// until `agentlink ui` was restarted.
//
// Real host, real folder: the shipped CLI modules (startUiWelcome, openUiHostAgent, uiRemovalPort,
// the agent directory and its folder lock) on a temp home, the real approval server with a recording
// opener, the keychain stand-in file and the in-memory relay (app-world.ts). The owner's passkey is
// the virtual PRF authenticator; the request carries every guard the page sends (session cookie,
// CSRF, Host, Origin, fetch metadata, octet-stream, generation) and the one passkey gesture signs
// `agent.revoke`, recorded in the owner's revoked list. Nothing on the failing step is faked.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { decodeBase64url, encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePasskeyAssertion } from '../../packages/node/dist/owner-passkey.js';
import { encodeSetupRegistration } from '../../packages/node/dist/owner-setup.js';
import { VirtualPrfAuthenticator } from '../../packages/node/src/passkey-authenticator.fixture.js';
import { newComputer, uiDepsOf } from './app-world.js';

/** The shell's index.html with the empty CSRF meta the server fills in (no script: HTTP only). */
const APP = new Map<string, Uint8Array>([
  [
    'index.html',
    encodeUtf8(
      '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
        '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
        '<body><div id="root"></div></body></html>',
    ),
  ],
]);

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${String(port)}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const input = (value: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(value)));

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

describe('Remove in the session first run started (HOTFIX-045-REMOVE-FIRSTRUN)', () => {
  it('first run creates the agent; Remove in the same session completes with one passkey gesture', async () => {
    const pc = await newComputer();
    const deps = uiDepsOf(pc, APP);
    // `agentlink ui` on a home with no agent at all: the no-agent app host (Welcome).
    const welcome = await deps.startWelcome?.();
    if (welcome === undefined) throw new Error('the welcome host did not start');
    closers.push(() => welcome.close());
    expect(welcome.page).toBe('first-run');
    expect(await welcome.open()).toBe(true);

    // The one-shot link the opener got: session cookie, then the page's CSRF and generation.
    const link = new URL(pc.opened.at(-1) ?? '');
    const port = Number(link.port);
    const origin = link.origin;
    const entered = await send(port, `${link.pathname}${link.search}`);
    expect(entered.status).toBe(303);
    const cookie = (entered.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await send(port, '/first-run', { headers: { Cookie: cookie } });
    const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
    expect(csrf).toBeDefined();
    const base = {
      Cookie: cookie,
      'X-AgentLink-CSRF': csrf ?? '',
      'Sec-Fetch-Site': 'same-origin',
    };
    const generation = async (): Promise<string> => {
      const res = await send(port, '/api/ui/agents', { headers: base });
      return String(res.headers['x-agentlink-generation'] ?? '');
    };
    const post = async (
      path: string,
      body: Uint8Array,
      extra: Record<string, string>,
    ): Promise<Response> =>
      send(port, path, {
        method: 'POST',
        headers: {
          ...base,
          Origin: origin,
          'Content-Type': 'application/octet-stream',
          'X-AgentLink-Generation': await generation(),
          ...extra,
        },
        body,
      });

    // First run: begin {label} and finish {label}, one passkey creation (the owner and the agent).
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const label = { 'X-AgentLink-Input': input({ label: 'Ana' }) };
    const begin = await post('/api/ui/first-run/owner/begin', new Uint8Array(0), label);
    expect(begin.status).toBe(200);
    const { publicKey } = JSON.parse(begin.body) as {
      publicKey: { rpId: string; userId: string; challenge: string; prfSalt: string };
    };
    const salt = decodeBase64url(publicKey.prfSalt);
    const created = auth.create(decodeBase64url(publicKey.userId), salt);
    const clientDataJSON = encodeUtf8(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: publicKey.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const finish = await post(
      '/api/ui/first-run/owner/finish',
      encodeSetupRegistration({
        credentialId: created.credentialId,
        authenticatorData: created.authenticatorData,
        clientDataJSON,
        prfOutput: created.prfOutput,
      }),
      label,
    );
    expect(finish.status).toBe(200);
    const listed = await pc.directory.list();
    expect(listed.map((e) => [e.name, e.label])).toEqual([['default', 'Ana']]);
    const folder = join(pc.home, '.agentlink', 'agents', 'default');
    expect(existsSync(folder)).toBe(true);

    // Remove, in the same session and the same host: the typed label and one passkey gesture.
    const removed = await post('/api/ui/agents/remove', encodePasskeyAssertion(auth.get(salt)), {
      'X-AgentLink-Input': input({ name: 'default', typedLabel: 'Ana' }),
      'X-AgentLink-Presence': 'passkey',
    });
    expect({ status: removed.status, body: JSON.parse(removed.body) as unknown }).toEqual({
      status: 200,
      body: { status: 'removed' },
    });
    expect(await pc.directory.list()).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    // The signed `agent.revoke` is kept in the owner's revoked list (never deleted with the agent).
    expect(await readdir(join(pc.home, '.agentlink', 'revoked'))).toHaveLength(1);
    expect(auth.gestures).toBe(2);
  }, 60_000);
});
