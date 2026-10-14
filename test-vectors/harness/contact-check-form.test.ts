// Cross-check of the owner-action `contact.check` vectors (M1-1h; G-28) against the strict
// @agentlink/types schema (M1-2f). The vectors come from the independent Python generator
// (tools/vectors/generate_owner_action.py, written in a separate session under the M1-1h rules) and
// the schema from @agentlink/types, written from 04 §2.4.1, §2.5.1 and §3.6.1; neither is derived
// from the other. The card asks for agreement "in every runtime the suite declares", so this file
// runs in all five runtime projects (the suite declares no `runtimes`). Signature checks, the
// lifetime bound and the comparison with the digest recomputed from the signed `handshake` and
// `handshake-ack` are the core's (M1-7c, M1-7d); the owner-action suite itself stays pending until then.
// Version 4 of the suite (IR-M1-2f-1 F02) adds verify cases for those core checks; here they must pass
// the schema unchanged (CORE_ONLY), and the context names each stored pairing in `pairings`.
import {
  contactCheckActionSchema,
  contactCheckParamsSchema,
  ownerActionSchema,
  signedContactCheckSchema,
  signedOwnerActionSchema,
} from '@agentlink/types';
import { describe, expect, test } from 'vitest';
import { vectorFiles, type VectorCase } from './registry';

interface Params {
  contact: string;
  pairingDigest: string;
  [key: string]: unknown;
}
interface Body {
  op: string;
  params: Params;
}
interface Input {
  readonly op?: unknown;
  readonly body?: Body;
  readonly signed?: { readonly body: Body; readonly sig: string };
  readonly context?: { readonly pairings?: readonly { readonly contact: string }[] };
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const input = (c: VectorCase): Input => c.input as Input;
const outcome = (c: VectorCase) => (c.expected as { outcome?: unknown }).outcome;
const byId = (id: string) => cases.find((c) => c.id === id);
const clone = <T>(v: T): T => structuredClone(v);

/** Every case whose body is a `contact.check`: selected by the signed op, not by its id. */
const signCases = cases.filter(
  (c) => input(c).op === 'sign' && input(c).body?.op === 'contact.check',
);
const verifyCases = cases.filter(
  (c) => input(c).op === 'verify' && input(c).signed?.body.op === 'contact.check',
);

/** The signing vector's params: the pairing every rejection vector's context names. */
const signedParams = (): Params => clone(input(byId('sign-contact-check')!).body!.params);
const PARAM_KEYS = new Set(['contact', 'pairingDigest']);

/**
 * The smallest repair for each rejection: undoing exactly the rule the vector names must make the
 * strict schema accept it (as in policy-form.test.ts and batch-form.test.ts). A vector that broke a
 * second rule, or another rule than its name says, still fails after the repair.
 */
const REPAIRS: Readonly<Record<string, (p: Params) => void>> = {
  'reject-pairing-digest-0x': (p) => {
    p.pairingDigest = p.pairingDigest.replace(/^0x/, '');
  },
  'reject-pairing-digest-uppercase': (p) => {
    p.pairingDigest = p.pairingDigest.toLowerCase();
  },
  'reject-pairing-digest-base64url': (p) => {
    // base64url (no padding) of 32 bytes back to bare lowercase hex.
    const b64 = p.pairingDigest.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(`${b64}=`), (ch) => ch.charCodeAt(0));
    expect(bytes).toHaveLength(32);
    p.pairingDigest = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },
  'reject-contact-checksummed': (p) => {
    p.contact = p.contact.toLowerCase();
  },
  'reject-contact-check-unknown-param': (p) => {
    for (const key of Object.keys(p)) if (!PARAM_KEYS.has(key)) delete p[key];
  },
  'verify-contact-check-reject-contact-uppercase': (p) => {
    p.contact = p.contact.toLowerCase();
  },
};

/**
 * Verify cases that the strict schema must accept unchanged: the two accepted checks, and the
 * rejections that only the core can make (04 §2.5.1 signature, expiry and lifetime; 04 §3.6.1 the
 * digest recomputed from the stored pair; an unknown contact). A schema that refused one of them
 * would over-reject (version 4 of the suite, IR-M1-2f-1 F02).
 */
const CORE_ONLY: Readonly<Record<string, 'accept' | 'reject'>> = {
  'verify-contact-check': 'accept',
  'verify-contact-check-at-expiry': 'accept',
  'verify-contact-check-reject-digest-mismatch': 'reject',
  'verify-contact-check-reject-wrong-signer': 'reject',
  'verify-contact-check-reject-expired': 'reject',
  'verify-contact-check-reject-lifetime': 'reject',
  'verify-contact-check-reject-unknown-contact': 'reject',
  'verify-contact-check-reject-stored-ack-tampered': 'reject',
};

describe('owner-action contact.check vectors follow 04 §2.5.1 and §3.6.1 (M1-2f, G-28)', () => {
  test('the owner-action suite is committed with the contact.check cases', () => {
    expect(ownerAction).toBeDefined();
    expect(signCases.map((c) => c.id)).toStrictEqual(['sign-contact-check']);
  });

  test('the contact.check signing body is accepted unchanged by the strict schema', () => {
    for (const c of signCases) {
      const body = input(c).body;
      for (const schema of [contactCheckActionSchema, ownerActionSchema]) {
        const parsed = schema.safeParse(body);
        expect(parsed.success, `${c.id}: ${parsed.error?.message ?? ''}`).toBe(true);
        expect(parsed.data, c.id).toStrictEqual(body);
      }
      expect(contactCheckParamsSchema.safeParse(body?.params).success, c.id).toBe(true);
      // The canonical text the generator signed holds exactly the same object.
      const jcs = (c.expected as { jcs: string }).jcs;
      expect(JSON.parse(jcs), `${c.id}: JCS text`).toStrictEqual(body);
      const sig = (c.expected as { sig: string }).sig;
      const signed = { body, sig };
      for (const schema of [signedOwnerActionSchema, signedContactCheckSchema]) {
        const parsed = schema.safeParse(signed);
        expect(parsed.success, `${c.id} signed: ${parsed.error?.message ?? ''}`).toBe(true);
        expect(parsed.data, c.id).toStrictEqual(signed);
      }
    }
  });

  test('every named rejection vector is committed and names the signed pairing', () => {
    for (const id of Object.keys(REPAIRS)) {
      const c = byId(id);
      expect(c, `${id} is missing`).toBeDefined();
      expect(c?.expected, id).toStrictEqual({ outcome: 'reject' });
      expect(
        input(c!).context?.pairings?.map((p) => p.contact),
        id,
      ).toStrictEqual([signedParams().contact]);
    }
  });

  test('the core-only cases pass the strict schema unchanged', () => {
    for (const [id, expected] of Object.entries(CORE_ONLY)) {
      const c = byId(id);
      expect(c, `${id} is missing`).toBeDefined();
      expect(outcome(c!), id).toBe(expected);
      const signed = input(c!).signed;
      for (const schema of [signedOwnerActionSchema, signedContactCheckSchema]) {
        const parsed = schema.safeParse(signed);
        expect(parsed.success, `${id}: ${parsed.error?.message ?? ''}`).toBe(true);
        expect(parsed.data, id).toStrictEqual(signed);
      }
    }
  });

  test('every contact.check rejection is refused by the schema for exactly its named rule', () => {
    expect(verifyCases.map((c) => c.id).sort()).toStrictEqual(
      [...Object.keys(REPAIRS), ...Object.keys(CORE_ONLY)].sort(),
    );
    for (const c of verifyCases.filter((v) => v.id in REPAIRS)) {
      const signed = input(c).signed!;
      for (const schema of [signedOwnerActionSchema, signedContactCheckSchema]) {
        expect(schema.safeParse(signed).success, `${c.id}: schema accepts`).toBe(false);
      }
      expect(contactCheckParamsSchema.safeParse(signed.body.params).success, c.id).toBe(false);
      const fixed = clone(signed) as { body: Body; sig: string };
      REPAIRS[c.id]!(fixed.body.params);
      // The repair restores exactly the pairing the owner compared: nothing else was changed.
      expect(fixed.body.params, `${c.id} after repair`).toStrictEqual(signedParams());
      for (const schema of [signedOwnerActionSchema, signedContactCheckSchema]) {
        const parsed = schema.safeParse(fixed);
        expect(parsed.success, `${c.id} after repair: ${parsed.error?.message ?? ''}`).toBe(true);
      }
    }
  });
});
