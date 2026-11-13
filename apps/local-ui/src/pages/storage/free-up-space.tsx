// RET-4 (D-148; 08 §1 "Free up space"; 11 §5): Settings > Storage's Free up space. Filters by
// person, by age and "Files only"; Review asks the server what that removes (counts and sizes, the
// delete sheet with its fixed lines) before anything is deleted. The people list is the Messages
// read (names as core shows them, text only, I-5).
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

export function FreeUpSpace({
  api,
  fetch: givenFetch,
  token,
  onApplied,
}: {
  readonly api: ApiClient;
  readonly fetch?: typeof fetch | undefined;
  readonly token?: string | undefined;
  readonly onApplied: () => void;
}): ReactElement {
  const titleId = useId();
  const personId = useId();
  const ageId = useId();
  const filesId = useId();
  const [people, setPeople] = useState<readonly Conversation[]>([]);
  const [person, setPerson] = useState('');
  const [age, setAge] = useState('');
  const [filesOnly, setFilesOnly] = useState(false);
  const [review, setReview] = useState<{ target: DeleteTarget; filesOnly: boolean } | undefined>(
    undefined,
  );

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
            onClose={() => setReview(undefined)}
            onApplied={onApplied}
          />
        )}
      </div>
    </Surface>
  );
}
