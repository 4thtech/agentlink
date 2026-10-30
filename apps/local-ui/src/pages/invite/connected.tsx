// W4-PEOPLE-INVITE: the "Connected ✓" moment, on both sides (prototype v23 A7; 04 §3.6.1).
// Two letters meet and a check pops (U0 al-pop; a fade only under reduced motion), "You and {name}
// are connected", and the one last check: the safety code, 12 digits in 0.4.6, read from this app's
// server for the new contact. It is shown only once the pairing completed (the code does not exist
// before). "Numbers don't match?" says what to do next in plain words; nothing is signed here.
// Marking the code as checked stays on the person (People), behind Touch ID.
import { Button } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { contactPath, parseCode } from '../contacts/data.js';
import { CheckMark } from './icons.js';
import { INVITE_STRINGS as S, codeLabel, connectedWith, lastCheck, letterOf } from './strings.js';
import './invite.css';

export interface ConnectedMomentProps {
  /** The new contact's name (name-rule output), rendered as text. */
  readonly name: string;
  /** Your own name, for the first letter (optional). */
  readonly me?: string;
  /** The new contact's ref, for the safety code. */
  readonly contactRef?: string;
  readonly api?: ApiClient;
  readonly onDone?: () => void;
  /** 1 on a screen of its own (the join screen), 2 inside a page that has its title. */
  readonly headingLevel?: 1 | 2;
}

type Code =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly code: string };

export function ConnectedMoment({
  name,
  me = '',
  contactRef,
  api: givenApi,
  onDone,
  headingLevel = 1,
}: ConnectedMomentProps): ReactElement {
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [code, setCode] = useState<Code>(
    contactRef === undefined ? { kind: 'none' } : { kind: 'loading' },
  );
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    if (contactRef === undefined) {
      setCode({ kind: 'none' });
      return undefined;
    }
    let live = true;
    setCode({ kind: 'loading' });
    let path: string;
    try {
      path = contactPath(contactRef, 'safety-code');
    } catch {
      setCode({ kind: 'none' });
      return undefined;
    }
    void api.get(path).then(
      (res) => {
        if (!live) return;
        const answer = res.kind === 'ok' ? parseCode(res.data) : ({ kind: 'unavailable' } as const);
        setCode(answer.kind === 'ok' ? { kind: 'ok', code: answer.code } : { kind: 'none' });
      },
      () => {
        if (live) setCode({ kind: 'none' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, contactRef]);

  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const groups = code.kind === 'ok' ? code.code.split(' ') : [];
  return (
    <section className="inv-connected al-reveal" aria-label={connectedWith(name)}>
      <div className="inv-pair" aria-hidden="true">
        <span className="inv-avatar inv-avatar--me">{letterOf(me)}</span>
        <span className="inv-avatar inv-avatar--them">{letterOf(name)}</span>
        <span className="inv-pair-check">
          <CheckMark />
        </span>
      </div>
      <div className="inv-connected-head">
        <Heading className="inv-connected-title">{connectedWith(name)}</Heading>
        <p className="inv-intro al-muted">{lastCheck(name)}</p>
      </div>
      <div className="inv-code al-reveal" role="group" aria-label={S.safetyCode}>
        <span className="inv-eyebrow">{S.safetyCode}</span>
        {code.kind === 'ok' ? (
          <p className="inv-code-digits" role="img" aria-label={codeLabel(code.code)}>
            {groups.map((g, i) => (
              <span key={i}>
                {i > 0 ? <span className="inv-code-sep"> · </span> : null}
                {g}
              </span>
            ))}
          </p>
        ) : (
          <p className="al-text-body-sm al-muted" role="status">
            {code.kind === 'loading' ? S.codeLoading : S.codeLater}
          </p>
        )}
      </div>
      {mismatch ? (
        <div className="inv-mismatch al-reveal" role="status">
          {S.mismatch(name)}
        </div>
      ) : null}
      <div className="inv-connected-actions">
        <Button variant="primary" size="lg" className="al-press" onClick={onDone}>
          {S.done}
        </Button>
        {mismatch ? null : (
          <button type="button" className="inv-link-button" onClick={() => setMismatch(true)}>
            {S.dontMatch}
          </button>
        )}
      </div>
    </section>
  );
}
