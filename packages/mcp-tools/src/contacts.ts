// Contacts as tool results show them (06 §2.1 contact-name rule, I-5; M1-9c), and the `Contact`
// argument's resolution (06 §2: contact ID, display name or invite alias; ambiguous →
// `AMBIGUOUS_CONTACT` with candidates).
//
// A contact is shown outside the untrusted block only as the core's `display`: the owner's alias, or
// the restricted name (`restrictName`, M1-7c) with its identity label. The self-declared name
// (`ContactView.name.value`) is never read here.
import { renderContactName, type ContactView } from '@4thtech-io/core';
import type { ContactDisplayName, IdentityLabel, NameSource } from '@4thtech-io/types';
import { fail, type HandlerOutput } from './result.js';
import { renderCopy } from './strings/index.js';
import { TOOL_TEXT } from './text.js';
import { removeInvisible } from './untrusted.js';

/** `ContactRef` of 06 §2.2: the name-rule form, never the self-declared name. */
export interface ContactRef {
  readonly id: string;
  readonly name: string;
  readonly label: IdentityLabel;
  readonly nameSource: NameSource;
  /**
   * WAVE-030: the owner's short fingerprint, set only where two active contacts show the same name
   * (and always on `AMBIGUOUS_CONTACT` candidates), so the user can tell them apart. Derived from
   * the verified card, never a self-declared string.
   */
  readonly ownerFingerprint?: string;
  /** WAVE-030: the first ten characters of the contact ID, on candidates only. */
  readonly shortId?: string;
  /**
   * REL051-B1 (N12): when the pairing was made (RFC 3339; `createdAt` when core has no `pairedAt`),
   * on candidates and listed contacts, so the user can tell same-named contacts apart.
   */
  readonly connectedAt?: string;
}

/** The short ID tag core shows (04 §2.9); anything else is left out of our text. */
const TAG = /^[0-9A-F]{4}\u00b7[0-9A-F]{4}$/;
const ID = /^0x[0-9a-f]{40}$/;

const rfc3339 = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const unixTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 33;

/**
 * REL051-B1 (N12): when the contact was connected (its pairing; else when it was added), as RFC
 * 3339, or undefined when core has neither time.
 */
export function connectedAtOf(view: ContactView): string | undefined {
  if (unixTime(view.pairedAt)) return rfc3339(view.pairedAt);
  return unixTime(view.createdAt) ? rfc3339(view.createdAt) : undefined;
}

/** `{connectedAt}` when known, else nothing. */
export function connectedAtField(view: ContactView): { readonly connectedAt?: string } {
  const at = connectedAtOf(view);
  return at === undefined ? {} : { connectedAt: at };
}

/** The first ten characters of a contact ID (`0x` and eight hex digits). */
export const shortIdOf = (id: string): string => id.slice(0, 10);

/** Owner aliases are owner text, shown unrestricted (06 §2.1 rule 1) but kept to one short line. */
const ALIAS_MAX_CODE_POINTS = 64;

function shownName(display: ContactDisplayName): string {
  if (display.nameSource !== 'owner') return display.name;
  const line = removeInvisible(display.name).replace(/\n/g, ' ').trim();
  return Array.from(line).slice(0, ALIAS_MAX_CODE_POINTS).join('');
}

export function contactRef(view: ContactView): ContactRef {
  return displayRef(view.id, view.display);
}

/** `ContactRef` from a contact ID and the core's `display` (e.g. an inbox item's sender). */
export function displayRef(id: string, display: ContactDisplayName): ContactRef {
  return Object.freeze({
    id,
    name: shownName(display),
    label: display.label,
    nameSource: display.nameSource,
  });
}

/** The name as summaries show it: quoted, then its label, e.g. `“Marko Novak” (self-declared)`. */
export function renderRef(ref: ContactRef): string {
  const name = renderContactName({
    name: ref.name,
    label: ref.label,
    nameSource: ref.nameSource,
  } as ContactDisplayName);
  if (ref.ownerFingerprint === undefined) return name;
  // N12: two same-named contacts with the same ID tag (one owner, two IDs) also show the short id.
  return ref.shortId === undefined
    ? `${name} (owner ${ref.ownerFingerprint})`
    : `${name} (owner ${ref.ownerFingerprint}, id ${ref.shortId})`;
}

/** A candidate of `AMBIGUOUS_CONTACT`: the name-rule ref plus ID tag and short ID. */
export function candidateRef(view: ContactView): ContactRef {
  return Object.freeze({
    ...contactRef(view),
    ownerFingerprint: view.ownerFingerprint.short,
    shortId: shortIdOf(view.id),
    ...connectedAtField(view),
  });
}

/**
 * Refs by contact ID for `views`, with the ID tag added where another contact shows the
 * same name (WAVE-030). Compared the way `resolveContact` compares, so a pair that cannot be told
 * apart by name is exactly a pair that shows its fingerprint.
 */
export function refsById(views: readonly ContactView[]): Map<string, ContactRef> {
  const counts = new Map<string, number>();
  // N12: same name AND same ID tag (one owner's two IDs): the short id tells them apart.
  const tagCounts = new Map<string, number>();
  const tagKey = (view: ContactView): string =>
    `${fold(shownName(view.display))}\u0000${view.ownerFingerprint.short}`;
  for (const view of views) {
    const key = fold(shownName(view.display));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    tagCounts.set(tagKey(view), (tagCounts.get(tagKey(view)) ?? 0) + 1);
  }
  return new Map(
    views.map((view) => {
      const ref = contactRef(view);
      const dup = (counts.get(fold(shownName(view.display))) ?? 0) > 1;
      const sameTag = (tagCounts.get(tagKey(view)) ?? 0) > 1;
      return [
        view.id,
        dup
          ? Object.freeze({
              ...ref,
              ownerFingerprint: view.ownerFingerprint.short,
              ...(sameTag ? { shortId: shortIdOf(view.id) } : {}),
            })
          : ref,
      ] as const;
    }),
  );
}

/** Contacts the tools offer: active ones (not blocked, revoked or removed). */
export const activeContacts = (views: readonly ContactView[]): ContactView[] =>
  views.filter((view) => view.status === 'active');

export type ContactResolution =
  | { readonly ok: true; readonly contact: ContactView }
  | { readonly ok: false; readonly output: HandlerOutput };

const fold = (text: string): string =>
  removeInvisible(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Resolves a `Contact` argument against the active contacts: an exact contact ID, or the shown name
 * (alias or restricted name), compared after NFKC and case folding. The query is agent-written text:
 * it is never echoed in a summary, `nextStep` or error (IR-M1-9g-1 L1).
 */
export function resolveContact(query: string, views: readonly ContactView[]): ContactResolution {
  const contacts = activeContacts(views);
  const byId = contacts.find((view) => view.id === query.trim().toLowerCase());
  if (byId !== undefined) return { ok: true, contact: byId };
  const wanted = fold(query);
  const matches =
    wanted === '' ? [] : contacts.filter((view) => fold(shownName(view.display)) === wanted);
  if (matches.length === 1) return { ok: true, contact: matches[0]! };
  if (matches.length === 0) {
    return {
      ok: false,
      output: fail('not_found', TOOL_TEXT.contactNotFound, TOOL_TEXT.contactNotFoundNextStep),
    };
  }
  return {
    ok: false,
    output: fail(
      'error',
      ambiguousSummary(matches),
      TOOL_TEXT.contactAmbiguousNextStep,
      'AMBIGUOUS_CONTACT',
      { candidates: matches.map(candidateRef) },
    ),
  };
}

/** At most this many options are spelled out in an ambiguous summary; `candidates` has them all. */
const SUMMARY_OPTIONS = 5;

/**
 * REL051-B1 (N12): "More than one contact has that name … They are: 1) owner 1111·2222, id
 * 0xbbbbbbbb, connected 2025-10-09; 2) …". Only what tells them apart and is not counterparty text
 * (I-5): the ID tag from the verified card, the short contact ID and the day the pairing was made.
 * Never a name, so never the query (IR-M1-9g-1 L1). A value of another shape is left out.
 */
function ambiguousSummary(matches: readonly ContactView[]): string {
  const options = matches.slice(0, SUMMARY_OPTIONS).map((view, i) => {
    const tag = view.ownerFingerprint.short;
    const at = connectedAtOf(view);
    const parts = [
      ...(typeof tag === 'string' && TAG.test(tag) ? [`owner ${tag}`] : []),
      ...(ID.test(view.id) ? [`id ${shortIdOf(view.id)}`] : []),
      ...(at === undefined ? [] : [`connected ${at.slice(0, 10)}`]),
    ];
    return `${String(i + 1)}) ${parts.join(', ')}`;
  });
  const rest = matches.length - options.length;
  const list = rest > 0 ? `${options.join('; ')}; and ${String(rest)} more` : options.join('; ');
  return renderCopy(TOOL_TEXT.contactAmbiguousOptions, { options: list });
}
