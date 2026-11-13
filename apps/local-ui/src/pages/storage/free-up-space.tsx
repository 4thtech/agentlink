// RET-4 (D-148; 08 §1 "Free up space"; 11 §5): Settings > Storage's Free up space. Filters by
// person, by age and "Files only"; Review asks the server what that removes (counts and sizes, the
// delete sheet with its fixed lines) before anything is deleted. The people list is the Messages
// read (names as core shows them, text only, I-5). RET-7: opened from the AI's agentlink_tidy link,
// it says so, fills the filters and opens the sheet; nothing is deleted until the owner confirms.
import { Button, Surface } from '@4thtech-io/ui';
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { parseConversations, type Conversation } from '../messages/api.js';
import type { DeleteTarget } from '../history/api.js';
import { DeleteSheet } from '../history/delete-sheet.js';
import { HISTORY_STRINGS as H } from '../history/strings.js';
import { SettingsIcon } from '../settings/icons.js';

const AGES: readonly (readonly [string, string])[] = [
  ['', H.anyAge],
  ['30', H.days30],
  ['90', H.days90],
  ['365', H.days365],
];

/** RET-7: the filter of an agentlink_tidy proposal, from the page link (parseTidyProposal). */
export interface TidyProposal {
  readonly contact?: string;
  readonly olderThanDays: 30 | 90 | 365;
  readonly include: 'files' | 'both';
}

const TIDY_KEYS: ReadonlySet<string> = new Set(['tidy', 'days', 'contact']);
const CONTACT_ID = /^0x[0-9a-f]{40}$/;

/**
 * RET-7: `?tidy=files|both&days=30|90|365[&contact=0x…]`, each key once and nothing else; anything
 * else is no proposal (the page then opens as usual). It only fills the filters: the server plans,
 * and the owner confirms with presence (RET-4).
 */
export function parseTidyProposal(search: string): TidyProposal | undefined {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const keys = [...query.keys()];
  if (keys.length === 0 || keys.some((k) => !TIDY_KEYS.has(k))) return undefined;
  if (new Set(keys).size !== keys.length) return undefined;
  const tidy = query.get('tidy');
  const days = query.get('days');
  const contact = query.get('contact');
  if (tidy !== 'files' && tidy !== 'both') return undefined;
  if (days !== '30' && days !== '90' && days !== '365') return undefined;
  if (contact !== null && !CONTACT_ID.test(contact)) return undefined;
  return {
    ...(contact === null ? {} : { contact }),
    olderThanDays: Number(days) as 30 | 90 | 365,
    include: tidy,
  };
}

export function FreeUpSpace({
  api,
  fetch: givenFetch,
  token,
  onApplied,
  proposal,
}: {
  readonly api: ApiClient;
  readonly fetch?: typeof fetch | undefined;
  readonly token?: string | undefined;
  readonly onApplied: () => void;
  /** RET-7: the AI's proposal from the page link: the filters filled and the sheet open. */
  readonly proposal?: TidyProposal | undefined;
}): ReactElement {
  const titleId = useId();
  const personId = useId();
  const ageId = useId();
  const filesId = useId();
  const [people, setPeople] = useState<readonly Conversation[]>([]);
  const [person, setPerson] = useState(proposal?.contact ?? '');
  const [age, setAge] = useState(proposal === undefined ? '' : String(proposal.olderThanDays));
  const [filesOnly, setFilesOnly] = useState(proposal?.include === 'files');
  const [review, setReview] = useState<{ target: DeleteTarget; filesOnly: boolean } | undefined>(
    proposal === undefined
      ? undefined
      : {
          target: {
            ...(proposal.contact === undefined ? {} : { contact: proposal.contact }),
            olderThanDays: proposal.olderThanDays,
          },
          filesOnly: proposal.include === 'files',
        },
  );
  const [suggested, setSuggested] = useState(proposal !== undefined);

  useEffect(() => {
    let live = true;
    void api.get('/api/ui/messages').then(
      (res) => {
        if (!live || res.kind !== 'ok') return;
        setPeople(parseConversations(res.data) ?? []);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const start = (): void => {
    const target: DeleteTarget = {
      ...(person === '' ? {} : { contact: person }),
      ...(age === '' ? {} : { olderThanDays: Number(age) }),
    };
    setReview({ target, filesOnly });
  };
  // "Everyone, any age" would be everything: Review needs a person or an age.
  const canReview = person !== '' || age !== '';
  const chosenName = people.find((p) => p.contactId === person)?.name;

  return (
    <Surface as="section" level={1} className="sto-coming" aria-labelledby={titleId}>
      <span className="sto-ic" aria-hidden="true">
        <SettingsIcon name="folder" />
      </span>
      <div className="sto-coming-text">
        <h2 id={titleId} className="al-text-h3">
          {H.freeTitle}
        </h2>
        <p className="al-text-body-sm al-muted">{H.freeLead}</p>
        {suggested ? (
          <div role="status">
            <p className="al-text-body-sm">{H.aiSuggested}</p>
            <p className="al-text-body-sm al-muted">{H.aiNothingYet}</p>
          </div>
        ) : null}
        <div className="sto-filters">
          <label htmlFor={personId} className="sto-field al-text-body-sm">
            <span>{H.person}</span>
            <select
              id={personId}
              className="al-input"
              value={person}
              onChange={(e) => {
                setPerson(e.target.value);
                setReview(undefined);
              }}
            >
              <option value="">{H.everyone}</option>
              {people.map((p) => (
                <option key={p.contactId} value={p.contactId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ageId} className="sto-field al-text-body-sm">
            <span>{H.olderThan}</span>
            <select
              id={ageId}
              className="al-input"
              value={age}
              onChange={(e) => {
                setAge(e.target.value);
                setReview(undefined);
              }}
            >
              {AGES.map(([value, words]) => (
                <option key={value} value={value}>
                  {words}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={filesId} className="sto-check al-text-body-sm">
            <input
              id={filesId}
              type="checkbox"
              checked={filesOnly}
              onChange={(e) => {
                setFilesOnly(e.target.checked);
                setReview(undefined);
              }}
            />
            <span>{H.filesOnly}</span>
          </label>
          <Button variant="secondary" size="sm" disabled={!canReview} onClick={start}>
            {H.review}
          </Button>
        </div>
        {review === undefined ? null : (
          <DeleteSheet
            name={chosenName}
            target={review.target}
            include={review.filesOnly ? 'files' : 'both'}
            {...(givenFetch === undefined ? {} : { fetch: givenFetch })}
            {...(token === undefined ? {} : { token })}
            onClose={() => {
              setReview(undefined);
              setSuggested(false);
            }}
            onApplied={onApplied}
          />
        )}
      </div>
    </Surface>
  );
}
