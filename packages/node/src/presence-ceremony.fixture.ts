// REL051-SF1 test seam: what the page does for a passkey proof (presence-ceremony.ts). Not part of
// the build (tsconfig.json excludes *.fixture.ts).
//
// A maker answers one ceremony's challenge with a virtual authenticator that has a signing key: it
// builds clientDataJSON (`webauthn.get`, the challenge, the page's origin), lets the authenticator
// sign authenticatorData ‖ SHA-256(clientDataJSON) and returns the six-field body.
import { encodeUtf8 } from '@4thtech-io/crypto';
import type { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import { encodePayConfirmAssertion } from './pay-confirm.js';

/** Answers a ceremony: its base64url challenge and the page's origin, to the six-field body. */
export type CeremonyMaker = (challenge: string, origin: string) => Uint8Array;

/** A maker for `auth` (created with a credential key); `mutate` changes the finished body. */
export function ceremonyMaker(
  auth: VirtualPrfAuthenticator,
  salt: Uint8Array,
  mutate?: (body: Uint8Array) => void,
): CeremonyMaker {
  return (challenge, origin) => {
    const got = auth.get(salt);
    const clientDataJSON = encodeUtf8(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
    );
    const body = encodePayConfirmAssertion({
      ...got,
      clientDataJSON,
      signature: auth.sign(got.authenticatorData, clientDataJSON),
    });
    mutate?.(body);
    return body;
  };
}

/**
 * The page's two requests for a passkey proof: `post` sends one request with extra headers and a
 * body. The ceremony is asked with `X-AgentLink-Presence: challenge` and no body; a refused ask is
 * the answer. Then the made body goes with `X-AgentLink-Presence: passkey` and the ceremony.
 */
export async function withCeremony<A extends { status: number; json: Record<string, unknown> }>(
  post: (headers: Record<string, string>, body: Uint8Array) => Promise<A>,
  make: CeremonyMaker,
  origin: string,
): Promise<A> {
  const ask = await post({ 'X-AgentLink-Presence': 'challenge' }, new Uint8Array(0));
  if (ask.status !== 200) return ask;
  const publicKey = ask.json['publicKey'] as { challenge: string };
  return post(
    {
      'X-AgentLink-Presence': 'passkey',
      'X-AgentLink-Ceremony': String(ask.json['ceremony']),
    },
    make(publicKey.challenge, origin),
  );
}
