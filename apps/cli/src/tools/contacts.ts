// Contacts as tool results show them (06 §2.1 contact-name rule, I-5; M1-9c), and the `Contact`
// argument's resolution (06 §2: contact ID, display name or invite alias; ambiguous →
// `AMBIGUOUS_CONTACT` with candidates).
//
// A contact is shown outside the untrusted block only as the core's `display`: the owner's alias, or
// the restricted name (`restrictName`, M1-7c) with its identity label. The self-declared name
// (`ContactView.name.value`) is never read here.
import { renderContactName, type ContactView } from '@agentlink/core';
import type { ContactDisplayName, IdentityLabel, NameSource } from '@agentlink/types';
import { fail, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';
import { removeInvisible } from './untrusted.js';

/** `ContactRef` of 06 §2.2: the name-rule form, never the self-declared name. */
export interface ContactRef {
  readonly id: string;
  readonly name: string;
  readonly label: IdentityLabel;
  readonly nameSource: NameSource;
}

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
  return renderContactName({
    name: ref.name,
    label: ref.label,
    nameSource: ref.nameSource,
  } as ContactDisplayName);
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
      TOOL_TEXT.contactAmbiguous,
      TOOL_TEXT.contactAmbiguousNextStep,
      'AMBIGUOUS_CONTACT',
      { candidates: matches.map(contactRef) },
    ),
  };
}
