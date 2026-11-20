// NET-UI-B (C4, C8): the "Needs your approval" card, drawn with the approval card's own classes
// (packages/ui `al-approval`, D-116). The one confirm button is the existing owner step: Touch ID,
// a passkey, or the master code in the existing presence prompt (C5); this page never asks for a
// passphrase itself and never signs.
import { Button, Icon } from '@4thtech-io/ui';
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import type { OwnerClient, PresenceProof } from '../../../contacts/owner.js';
import { OwnerButton } from '../../../agents/owner-gate.js';
import { SERVERS_STRINGS as S } from './strings.js';

export interface Consequence {
  readonly title: string;
  readonly body: string;
}

export function ReviewCard({
  headline,
  rows,
  consequences,
  statement,
  withSensor,
  withCode,
  backLabel,
  busy,
  error,
  owner,
  onProof,
  onBack,
  children,
}: {
  readonly headline: string;
  /** Server rows (host, role) shown under the headline; plain text. */
  readonly rows?: readonly { readonly host: string; readonly role: string }[];
  readonly consequences: readonly Consequence[];
  readonly statement: string;
  readonly withSensor: (sensor: string) => string;
  readonly withCode: string;
  readonly backLabel: string;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly owner: OwnerClient;
  readonly onProof: (proof: PresenceProof) => void;
  readonly onBack: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <article className="al-card al-approval is-pending" aria-labelledby={`${id}-h`}>
      <header className="al-approval-top al-text-body-sm">
        <span className="al-approval-type">
          <Icon name="approval" size={14} />
          <span className="al-text-label">{S.needsApproval}</span>
        </span>
      </header>
      <h3 id={`${id}-h`} ref={heading} className="al-text-title-2" tabIndex={-1}>
        {headline}
      </h3>
      {rows === undefined || rows.length === 0 ? null : (
        <ul className="nw-list nw-scroll" tabIndex={0} aria-label={S.listLabel} data-review-servers>
          {rows.map((r) => (
            <li key={`${r.host}-${r.role}`} className="nw-srv">
              <div className="nw-srv-top">
                <span className="nw-host al-text-code">{r.host}</span>
                <span className="nw-state al-text-body-sm">{r.role}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {children}
      <div className="al-approval-extra">
        {consequences.map((c) => (
          <div key={c.title}>
            <p className="al-text-body">
              <strong>{c.title}</strong>
            </p>
            <p className="al-text-body-sm al-muted">{c.body}</p>
          </div>
        ))}
      </div>
      <OwnerButton
        owner={owner}
        statement={statement}
        withSensor={withSensor}
        withCode={withCode}
        busy={busy}
        error={error}
        onProof={onProof}
      />
      <Button onClick={onBack} disabled={busy}>
        {backLabel}
      </Button>
    </article>
  );
}
