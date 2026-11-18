// RELAY-CARD-MIGRATION (S2; 0.5.13; 04 §2.5, §2.6; 08 §1; 11 §5; I-4; owner-approved 2026-11-18): on
// Home, "Update your contact details" for an ID whose card still lists a server AgentLink no longer
// uses. Styled like the rename note on Home (PageNotice, info tone, one owner button; D-116).
//
// - Reads `GET /api/ui/contact-details` (a read; signs nothing) whenever the open ID changes; shown
//   only while it answers `needed`.
// - Its one button is the owner gesture (Touch ID, passkey or the master code, as every owner
//   action); the proof goes to `POST /api/ui/contact-details`, where the server signs the ID's next
//   card and core's card-update tells the contacts. The page never signs.
// - Afterwards it reads again and disappears. If the owner never does it nothing breaks: the old
//   servers are still read. Copy never says "relay" (11 §5).
import { PageNotice } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import type { AgentsApi } from '../agents/api.js';
import { gateMessage, OwnerButton } from '../agents/owner-gate.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import { notify } from '../../notices/index.js';

export { CONTACT_DETAILS_PATH } from '../agents/api.js';

/** Fixed text (11 §5: plain words; no "relay", "wallet", "gas" or "transaction"). */
export const CONTACT_DETAILS_TEXT = Object.freeze({
  title: 'Update your contact details',
  body: 'AgentLink moved to more reliable servers. Your contacts need your new details once.',
  statement: 'Update your contact details',
  withSensor: (sensor: string): string => `Update with ${sensor}`,
  withCode: 'Update with your master code',
  done: 'Contact details updated. Your contacts get your new details.',
  pending: 'An earlier change of this ID is still finishing. Try again in a minute.',
  notAvailable: 'Quit the AgentLink app and open it again, then try once more.',
  failed: "That didn't go through. Your contact details didn't change. Try again.",
});

export interface ContactDetailsBannerProps {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  /** Changes when the open ID changes, so the state is read again. */
  readonly agentKey: string | undefined;
}

export function ContactDetailsBanner({
  api,
  owner,
  agentKey,
}: ContactDetailsBannerProps): ReactElement | null {
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (agentKey === undefined || api.contactDetails === undefined) {
      setNeeded(false);
      return undefined;
    }
    let live = true;
    void api.contactDetails().then((state) => {
      if (live) setNeeded(state === 'needed');
    });
    return () => {
      live = false;
    };
  }, [api, agentKey, reads]);

  if (!needed || api.updateContactDetails === undefined) return null;
  const update = api.updateContactDetails;
  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void update(proof).then((out) => {
      setBusy(false);
      if (out.kind === 'done' || out.kind === 'current') {
        if (out.kind === 'done') notify({ text: CONTACT_DETAILS_TEXT.done });
        setNeeded(false);
        setReads((n) => n + 1);
        return;
      }
      setError(
        gateMessage(out) ??
          (out.kind === 'rotation_pending'
            ? CONTACT_DETAILS_TEXT.pending
            : out.kind === 'not_available'
              ? CONTACT_DETAILS_TEXT.notAvailable
              : CONTACT_DETAILS_TEXT.failed),
      );
    });
  };
  return (
    <section
      className="hm-rename-banner"
      aria-label={CONTACT_DETAILS_TEXT.title}
      data-contact-details-banner
    >
      <PageNotice
        tone="info"
        icon="users"
        title={CONTACT_DETAILS_TEXT.title}
        actions={
          <OwnerButton
            owner={owner}
            statement={CONTACT_DETAILS_TEXT.statement}
            withSensor={CONTACT_DETAILS_TEXT.withSensor}
            withCode={CONTACT_DETAILS_TEXT.withCode}
            busy={busy}
            error={error}
            onProof={send}
          />
        }
      >
        <p>{CONTACT_DETAILS_TEXT.body}</p>
      </PageNotice>
    </section>
  );
}
