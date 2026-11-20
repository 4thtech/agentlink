// NET-ANNOUNCE-OPTOUT (D-158 (7); 08 §1 `POST /api/ui/network/announce`; 11 §5.14 C3): "Don't also
// announce on the default servers" on its own, without changing the list. Offered only in custom mode
// with the mix-in off (the entry decides). The switch shows the stored choice; turning it opens one
// review with the spec warning, confirmed through the existing presence step (the same approval card
// as C4). The page never signs; the server signs `network.announce`.
import { Banner, Sheet, Switch } from '@4thtech-io/ui';
import { useRef, useState, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../../../contacts/owner.js';
import type { ServersApi } from './api.js';
import { failMessage } from './messages.js';
import { ReviewCard } from './review-card.js';
import { SERVERS_STRINGS as S } from './strings.js';

export interface AnnounceSwitchProps {
  readonly api: ServersApi;
  readonly owner: OwnerClient;
  /** The stored choice: true while the ID is also announced on the default servers. */
  readonly announceDefault: boolean;
  readonly disabled: boolean;
  readonly onDone: (announceDefault: boolean) => void;
}

export function AnnounceSwitch({
  api,
  owner,
  announceDefault,
  disabled,
  onDone,
}: AnnounceSwitchProps): ReactElement {
  const optedOut = !announceDefault;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const sent = useRef(false);
  // The change the sheet asks for: the opposite of the stored choice.
  const next = !announceDefault;

  const confirm = (proof: PresenceProof): void => {
    if (busy || sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    void api.announce(next, proof).then((out) => {
      setBusy(false);
      sent.current = false;
      if (out.kind === 'ok') {
        setOpen(false);
        onDone(out.value.announceDefault);
      } else setError(failMessage(out));
    });
  };

  return (
    <div className="nw" data-servers-announce={optedOut ? 'off' : 'on'}>
      <Switch
        label={S.optOutLabel}
        description={S.optOutBody}
        checked={optedOut}
        disabled={disabled}
        onChange={() => {
          setError(undefined);
          setOpen(true);
        }}
      />
      {optedOut ? (
        <Banner tone="warning" title={S.optOutTitle}>
          {S.optOut}
        </Banner>
      ) : null}
      {open ? (
        <Sheet
          open
          title={next ? S.announceOnTitle : S.announceOffTitle}
          onClose={() => setOpen(false)}
          closeLabel={S.close}
        >
          <div className="nw" data-servers-announce-review>
            {next ? null : (
              <Banner tone="warning" title={S.optOutTitle}>
                {S.optOut}
              </Banner>
            )}
            <ReviewCard
              headline={next ? S.announceOnTitle : S.announceOffTitle}
              consequences={[
                next
                  ? { title: S.announceSame, body: S.announceOnBody }
                  : { title: S.announceSame, body: S.announceSameBody },
              ]}
              statement={next ? S.announceOnReason : S.announceOffReason}
              withSensor={S.announceConfirmSensor}
              withCode={S.announceConfirmCode}
              backLabel={S.announceKeep}
              busy={busy}
              error={error}
              owner={owner}
              onProof={confirm}
              onBack={() => setOpen(false)}
            />
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
