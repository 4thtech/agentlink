// W4-PEOPLE-INVITE: the "Connected ✓" moment, on both sides (prototype v23 A7; 04 §3.6.1).
// Two letters meet and a check pops (U0 al-pop; a fade only under reduced motion), "You and {name}
// are connected", and "Say hello to {name}" (a prompt to copy for your AI). The safety code (12
// digits in 0.4.6) is not shown by default (UX 2026-11-12 S-1): an optional check says in one line
// what it is for, and only then is the code read from this app's server for the new contact. It
// exists only once the pairing completed. "Numbers don't match?" says what to do next in plain
// words; nothing is signed here.
// Marking the code as checked stays on the person (People), behind Touch ID.
import { Button, CopyPrompt } from '@4thtech-io/ui';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { contactPath, parseCode } from '../contacts/data.js';
import type { OwnerClient } from '../contacts/owner.js';
import { CheckMark } from './icons.js';
import { NameContact } from './name-contact.js';
import { INVITE_STRINGS as S, codeLabel, connectedWith, helloPrompt, letterOf } from './strings.js';
import './invite.css';

export interface ConnectedMomentProps {
  /** The new contact's name (name-rule output), rendered as text. */
  readonly name: string;
  /** Your own name, for the first letter (optional). */
  readonly me?: string;
  /** The new contact's ref, for the safety code. */
  readonly contactRef?: string;
  readonly api?: ApiClient;
  /** The name came from the other side, not from your own alias: it is never our heading or prompt. */
  readonly selfDeclared?: boolean;
  /** For naming the contact (tests); the page's own owner client by default. */
  readonly owner?: OwnerClient;
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
  selfDeclared = true,
  owner,
  headingLevel = 1,
}: ConnectedMomentProps): ReactElement {
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [code, setCode] = useState<Code>(
    contactRef === undefined ? { kind: 'none' } : { kind: 'loading' },
  );
  const [mismatch, setMismatch] = useState(false);
  const [checking, setChecking] = useState(false);
  // The alias the owner confirmed (null while the name is only the contact's own, I-5).
  const [named, setNamed] = useState<string | null>(null);
  const shown = selfDeclared ? named : name;
  const who = shown ?? S.thisContact;
  const digitsId = useId();
  const digitsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (checking) digitsRef.current?.focus();
  }, [checking]);

  useEffect(() => {
    if (!checking) return undefined;
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
  }, [api, contactRef, checking]);

  // While the name field shows, "Save name" is the one primary button; "Done" steps back.
  const naming = selfDeclared && named === null && contactRef !== undefined;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const groups = code.kind === 'ok' ? code.code.split(' ') : [];
  return (
    <section
      className="inv-connected al-reveal"
      aria-label={shown === null ? S.connectedGeneric : connectedWith(shown)}
    >
      <div className="inv-pair" aria-hidden="true">
        {/* The two letters meet (U0 al-slide-in; the right one mirrored so it comes from the right),
            then the check pops (al-pop). Reduced motion: the kit's switch, no movement. */}
        <span className="inv-meet al-slide-in">
          <span className="inv-avatar inv-avatar--me">{letterOf(me)}</span>
        </span>
        <span className="inv-meet inv-from-right">
          <span className="inv-meet al-slide-in">
            <span className="inv-avatar inv-avatar--them inv-unflip">{letterOf(shown ?? '')}</span>
          </span>
        </span>
        <span className="inv-pair-check al-pop">
          <CheckMark />
        </span>
      </div>
      <div className="inv-connected-head">
        <Heading className="inv-connected-title">
          {shown === null ? S.connectedGeneric : connectedWith(shown)}
        </Heading>
      </div>
      {naming ? (
        <NameContact
          contactRef={contactRef}
          chosen={name}
          api={api}
          {...(owner === undefined ? {} : { owner })}
          onNamed={setNamed}
        />
      ) : null}
      <div className="inv-hello">
        <CopyPrompt title={S.sayHello(shown)} prompt={helloPrompt(shown)} />
      </div>
      <button
        type="button"
        className="inv-link-button inv-optional-check"
        aria-expanded={checking}
        aria-controls={digitsId}
        onClick={() => setChecking((on) => !on)}
      >
        {S.optionalCheck(who)}
      </button>
      {checking ? (
        <div
          id={digitsId}
          className="inv-code al-reveal"
          role="group"
          aria-label={S.safetyCode}
          tabIndex={-1}
          ref={digitsRef}
        >
          <span className="inv-eyebrow">{S.safetyCode}</span>
          <p className="al-text-body-sm">{S.checkPurpose(who)}</p>
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
      ) : null}
      {mismatch ? (
        <div className="inv-mismatch al-reveal" role="status">
          {S.mismatch(who)}
        </div>
      ) : null}
      <div className="inv-connected-actions">
        <Button
          variant={naming ? 'secondary' : 'primary'}
          size="lg"
          className="al-press"
          onClick={onDone}
        >
          {S.done}
        </Button>
        {mismatch || !checking ? null : (
          <button type="button" className="inv-link-button" onClick={() => setMismatch(true)}>
            {S.dontMatch}
          </button>
        )}
      </div>
    </section>
  );
}
