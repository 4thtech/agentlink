// B9 (UX1113 QA): terms leave a trace in the person's conversation. What the person decided about
// terms with this person (proposed, accepted, declined, answered with their own) comes from the
// Activity read the app already serves (`GET /api/ui/activity`: decided approvals with their action
// and a contact reference). Read only; the terms' own words stay on the approval card, so none of
// their content enters this line (I-5). Nothing here changes anything.
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { parseItem, type ActivityItem, type Decision } from '../activity/clean.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

export type TermsKind = 'offer_terms' | 'accept_terms' | 'reject_terms' | 'counter_terms';
export type TermsState = 'proposed' | 'accepted' | 'declined' | 'answered' | 'not_sent';

export interface TermsEvent {
  readonly at: number;
  readonly kind: TermsKind;
  readonly state: TermsState;
  readonly decision: Decision;
}

const KINDS: ReadonlySet<string> = new Set([
  'offer_terms',
  'accept_terms',
  'reject_terms',
  'counter_terms',
]);

const DONE: ReadonlySet<Decision> = new Set(['approved', 'approved_by_rules']);

/** The state word for what was decided (a refused or cancelled approval did not happen). */
export function termsState(kind: TermsKind, decision: Decision): TermsState {
  if (!DONE.has(decision)) return 'not_sent';
  switch (kind) {
    case 'offer_terms':
      return 'proposed';
    case 'accept_terms':
      return 'accepted';
    case 'reject_terms':
      return 'declined';
    case 'counter_terms':
      return 'answered';
  }
}

/** The terms events of one person in a page of the Activity feed, oldest first. */
export function termsOf(items: readonly ActivityItem[], contactId: string): TermsEvent[] {
  const out: TermsEvent[] = [];
  const id = contactId.toLowerCase();
  for (const item of items) {
    if (item.kind !== 'approval_decided' || item.action === undefined) continue;
    if (!KINDS.has(item.action.type) || item.action.contactId !== id) continue;
    const kind = item.action.type as TermsKind;
    out.push({
      at: item.at,
      kind,
      state: termsState(kind, item.decision),
      decision: item.decision,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Parse the feed body, keeping only the entries the page knows. */
export function parseFeed(data: unknown): ActivityItem[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const raw = (data as { items?: unknown }).items;
  if (!Array.isArray(raw)) return undefined;
  const items: ActivityItem[] = [];
  for (const r of raw as unknown[]) {
    const item = parseItem(r);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** The words of one line: who did what with whose terms. */
export function termsLine(e: TermsEvent, name: string): string {
  switch (e.state) {
    case 'proposed':
      return fmt(S.termsProposed, { name });
    case 'accepted':
      return fmt(S.termsAccepted, { name });
    case 'declined':
      return fmt(S.termsDeclined, { name });
    case 'answered':
      return fmt(S.termsAnswered, { name });
    case 'not_sent':
      return e.kind === 'offer_terms'
        ? fmt(S.termsNotSentOffer, { name })
        : fmt(S.termsNotSentAnswer, { name });
  }
}

export const termsStateWord = (state: TermsState): string => S.termsState[state];

/** This person's terms events, read again on every `tick`. A failed read shows none, never blocks. */
export function useTerms(
  api: ApiClient | undefined,
  contactId: string,
  tick: number,
): TermsEvent[] {
  const [events, setEvents] = useState<TermsEvent[]>([]);
  useEffect(() => {
    if (api === undefined) return undefined;
    let live = true;
    void api
      .get('/api/ui/activity?limit=100')
      .then((result) => {
        if (!live || result.kind !== 'ok') return;
        const items = parseFeed(result.data);
        if (items !== undefined) setEvents(termsOf(items, contactId));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, contactId, tick]);
  return events;
}
