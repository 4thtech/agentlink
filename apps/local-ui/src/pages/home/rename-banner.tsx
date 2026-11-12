// WP-1 Rename truth (S2; D-141, Decision 46; 08 §1; 11 §5.8): on Home, the open ID's "Contacts
// still see {cardName}" note with its one gesture, so an ID renamed before D-141 (or made in the
// terminal and renamed later) is repaired where the owner looks first, not only on the IDs page.
// Reads `GET /api/ui/agents/card-name` (a read; signs nothing) whenever the open ID or its label
// changes; the gesture is the IDs page's own CardNameNote (the rename with the current label, which
// puts it in the card). Card names and labels are text only, in their own bidi run (I-5).
import { useEffect, useState, type ReactElement } from 'react';
import type { AgentsApi } from '../agents/api.js';
import type { AgentRow } from '../agents/data.js';
import { CardNameNote } from '../agents/parts.js';
import { AGENTS_STRINGS as S } from '../agents/strings.js';
import type { OwnerClient } from '../contacts/owner.js';
import { notify } from '../../notices/index.js';

export interface RenameBannerProps {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  /** The open ID; nothing shows without one. */
  readonly row: AgentRow | undefined;
}

export function RenameBanner({ api, owner, row }: RenameBannerProps): ReactElement | null {
  const [cardName, setCardName] = useState<string | undefined>(undefined);
  const name = row?.name;
  const label = row?.label;
  useEffect(() => {
    if (name === undefined) {
      setCardName(undefined);
      return undefined;
    }
    let live = true;
    void api.cardName().then((out) => {
      if (live) setCardName(out.kind === 'differs' ? out.cardName : undefined);
    });
    return () => {
      live = false;
    };
  }, [api, name, label]);

  if (row === undefined || row.removing) return null;
  if (cardName === undefined) return null;
  return (
    <section className="hm-rename-banner" aria-label={S.updateName} data-rename-banner>
      <CardNameNote
        row={row}
        cardName={cardName}
        api={api}
        owner={owner}
        onUpdated={(contactsTold) => {
          setCardName(undefined);
          // notices.md: an outcome is a toast.
          if (contactsTold) notify({ text: S.renamedTold(row.label) });
        }}
      />
    </section>
  );
}
