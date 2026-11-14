// WIN-HELLO-NATIVE (S2): what a presence screen inside the desktop app offers. Native (Touch ID or
// Windows Hello) when the helper says it is available; otherwise the master code, with plain text on
// how to set up the OS sign-in where that would help. Inside the app it is NEVER the WebAuthn
// passkey path: on Windows 11 21H2 that path only offers "Insert your security key"
// (WIN-FIRSTRUN-NOPRF), so it is not a default the page falls through to.
import { describe, expect, it } from 'vitest';
import { readNativeStatus } from './native-api.js';
import { desktopPresenceOffer } from './offer.js';

const answer = (native: unknown): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify({ native }), { status: 200 }))) as never;

describe('GET /api/owner/native: the unavailable reason', () => {
  it('keeps a known reason and drops anything else', async () => {
    expect(
      await readNativeStatus(
        answer({ available: false, registered: false, unavailable: 'not_set_up', platform: 'windows' }),
        't',
      ),
    ).toEqual({ available: false, registered: false, unavailable: 'not_set_up' });
    expect(
      await readNativeStatus(
        answer({ available: false, registered: false, unavailable: 'no_secure_hardware' }),
        't',
      ),
    ).toEqual({ available: false, registered: false, unavailable: 'no_secure_hardware' });
    expect(
      await readNativeStatus(
        answer({ available: false, registered: false, unavailable: '<b>hi</b>' }),
        't',
      ),
    ).toEqual({ available: false, registered: false });
  });
});

describe('desktopPresenceOffer', () => {
  it('native when available, on both platforms', () => {
    for (const platform of ['mac', 'windows'] as const) {
      expect(desktopPresenceOffer(platform, { available: true, registered: true })).toEqual({
        kind: 'native',
      });
      expect(desktopPresenceOffer(platform, { available: true, registered: false })).toEqual({
        kind: 'native',
      });
    }
  });

  it('Windows Hello not set up: the master code plus how to set up Windows Hello', () => {
    const offer = desktopPresenceOffer('windows', {
      available: false,
      registered: false,
      unavailable: 'not_set_up',
    });
    expect(offer.kind).toBe('code');
    expect(offer.kind === 'code' ? offer.help : '').toMatch(/Sign-in options/);
    expect(offer.kind === 'code' ? offer.help : '').toMatch(/PIN/);
    expect(offer.kind === 'code' ? offer.help : '').toMatch(/master code/);
  });

  it('no secure hardware or an unknown reason: the master code, with its own plain text', () => {
    for (const unavailable of ['no_secure_hardware', 'unknown', undefined] as const) {
      const offer = desktopPresenceOffer('windows', {
        available: false,
        registered: false,
        ...(unavailable === undefined ? {} : { unavailable }),
      });
      expect(offer.kind).toBe('code');
      expect(offer.kind === 'code' ? offer.help : '').toMatch(/master code/);
    }
  });

  it('never the passkey (WebAuthn) path inside the app, whatever the status says', () => {
    const statuses = [
      { available: false, registered: false },
      { available: false, registered: true, reason: 'reregister' as const },
      { available: false, registered: false, unavailable: 'not_set_up' as const },
      { available: true, registered: false },
    ];
    for (const platform of ['mac', 'windows'] as const) {
      for (const status of statuses) {
        expect(['native', 'code']).toContain(desktopPresenceOffer(platform, status).kind);
      }
    }
  });

  it('plain words only (11 §5)', () => {
    for (const platform of ['mac', 'windows'] as const) {
      for (const unavailable of ['not_set_up', 'no_secure_hardware', 'unknown'] as const) {
        const offer = desktopPresenceOffer(platform, {
          available: false,
          registered: false,
          unavailable,
        });
        const text = offer.kind === 'code' ? offer.help : '';
        expect(text).not.toMatch(/wallet|gas|seed phrase|transaction|TPM|WebAuthn|passkey|security key/i);
      }
    }
  });
});
