// Contact-name rule types (06 §2.1, D-53). The rule itself (`restrictName`) is M1-7c; this package
// fixes the vocabulary and makes a raw, untrusted name impossible to pass where a restricted name
// or an owner alias is required (compile-time brand, checked by `pnpm typecheck`).
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  IDENTITY_LABELS,
  NAME_SOURCES,
  RESERVED_NAME_WORDS,
  RESTRICTED_NAME_FALLBACK,
  RESTRICTED_NAME_MAX_CODE_POINTS,
  type ContactDisplayName,
  type OwnerAlias,
  type RestrictedName,
} from './index.js';

describe('contact-name vocabulary (06 §2.1)', () => {
  it('has the identity labels of 11 §5.2 and the name sources', () => {
    expect(IDENTITY_LABELS).toEqual([
      'self-declared',
      'safety-code-checked',
      'registered',
      'verified-domain',
    ]);
    expect(NAME_SOURCES).toEqual(['counterparty', 'owner']);
  });

  it('has the reserved words, the fallback and the length cap', () => {
    expect(RESERVED_NAME_WORDS).toEqual([
      'verified',
      'registered',
      'self-declared',
      'safety code',
      'checked',
      'AgentLink',
      'system',
      'approved',
      'owner',
    ]);
    expect(RESTRICTED_NAME_FALLBACK).toBe('Contact');
    expect(RESTRICTED_NAME_MAX_CODE_POINTS).toBe(32);
  });
});

describe('branded name types', () => {
  it('a raw string is neither a RestrictedName nor an OwnerAlias', () => {
    expectTypeOf<string>().not.toMatchTypeOf<RestrictedName>();
    expectTypeOf<string>().not.toMatchTypeOf<OwnerAlias>();
    expectTypeOf<RestrictedName>().not.toMatchTypeOf<OwnerAlias>();
    expectTypeOf<RestrictedName>().toMatchTypeOf<string>();
  });

  it('a counterparty name must be restricted; only an owner name may be an alias', () => {
    const restricted = 'Marko Novak' as RestrictedName;
    const shown: ContactDisplayName = {
      name: restricted,
      label: 'self-declared',
      nameSource: 'counterparty',
    };
    expect(shown.nameSource).toBe('counterparty');
    const show = (n: ContactDisplayName) => n.nameSource;
    const raw = { name: 'x', label: 'self-declared', nameSource: 'counterparty' } as const;
    const mixed = {
      name: 'x' as OwnerAlias,
      label: 'self-declared',
      nameSource: 'counterparty',
    } as const;
    // @ts-expect-error a raw string cannot be shown as a counterparty name
    show(raw);
    // @ts-expect-error an owner alias cannot claim a counterparty source
    show(mixed);
  });
});
