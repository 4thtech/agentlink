// NET-UI-B (C8; D-158): "Use AgentLink's automatic servers?". One review, one approval; allowed at
// any time (refused only while an earlier change finishes, the ID is paused, or it already is
// automatic). Same approval card and presence step as C4.
import { Banner, Button, Sheet, Skeleton } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../../../contacts/owner.js';
import type { Done, Fail, Review, ServersApi } from './api.js';
import { dayText, failMessage } from './messages.js';
import { ReviewCard, type Consequence } from './review-card.js';
import { SERVERS_STRINGS as S } from './strings.js';

export interface ResetFlowProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly api: ServersApi;
  readonly owner: OwnerClient;
  readonly onDone: (done: Done) => void;
}

export function ResetFlow({
  open,
  onClose,
  api,
  owner,
  onDone,
}: ResetFlowProps): ReactElement | null {
  const [review, setReview] = useState<Review | undefined>(undefined);
  const [failed, setFailed] = useState<Fail | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const sent = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void api.resetReview().then((out) => {
      if (!live) return;
      if (out.kind === 'ok') setReview(out.value);
      else setFailed(out);
    });
    return () => {
      live = false;
    };
  }, [open, api]);

  const confirm = (proof: PresenceProof): void => {
    if (busy || sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    void api.reset(proof).then((out) => {
      setBusy(false);
      sent.current = false;
      if (out.kind === 'ok') onDone(out.value);
      else setError(failMessage(out));
    });
  };

  const lines: Consequence[] = [
    { title: S.resetPicks, body: S.resetForgets },
    ...(review === undefined || review.contacts === 0
      ? []
      : [{ title: S.contactsTitle, body: S.contactsBody(review.contacts) }]),
    ...(review === undefined || review.leaving.length === 0
      ? []
      : [
          {
            title: S.leavingTitle,
            body: S.resetLeaving(dayText(Math.max(...review.leaving.map((l) => l.until)))),
          },
        ]),
  ];
  return (
    <Sheet open={open} title={S.resetTitle} onClose={onClose} closeLabel={S.close}>
      <div className="nw" data-servers-reset>
        <p className="al-text-body al-muted">{S.resetBody}</p>
        {failed !== undefined ? (
          <>
            <Banner tone="warning">{failMessage(failed)}</Banner>
            <div>
              <Button onClick={onClose}>{S.resetKeep}</Button>
            </div>
          </>
        ) : review === undefined ? (
          <Skeleton loading lines={3}>
            {null}
          </Skeleton>
        ) : (
          <ReviewCard
            headline={S.resetTitle}
            consequences={lines}
            statement={S.resetReason}
            withSensor={S.resetConfirmSensor}
            withCode={S.resetConfirmCode}
            backLabel={S.resetKeep}
            busy={busy}
            error={error}
            owner={owner}
            onProof={confirm}
            onBack={onClose}
          />
        )}
      </div>
    </Sheet>
  );
}
