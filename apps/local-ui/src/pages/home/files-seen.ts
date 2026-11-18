// WIDGET-POLISH-0511 (S1; 08 §1 notifications, the `mark` kind): whether a person's new files are
// still unseen, and the one way to mark them seen from the main app.
//
// - The "new files" count (the bell and the menu bar widget's Needs you) is the notification store's
//   `files-<ref>` item, one per person. It is read here with a GET (the shell refreshes the store).
// - Opening a received file, Save and Show in Finder mark that item read, as does "Mark as seen" on
//   the conversation. The mark is the existing `POST /api/ui/notifications/:id/read` (display state
//   only; nothing is decided from it). The widget stays read-only: it only reads the result.
// - Nothing here carries a name, a file name or a path: only the item ID (a kind and a contact ref).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATION_READ_PATH,
  notificationId,
  readNotificationList,
} from '@4thtech-io/types/ui-contract/notifications';
import type { ApiClient } from '../../api/client.js';
import { NOTIFICATIONS_CHANGED } from '../../api/notifications.js';

export interface FilesSeen {
  /** True while this person has new files the owner has not seen (false when unknown). */
  readonly unseen: boolean;
  /** Marks this person's new files seen; a no-op unless the last read saw them unseen. */
  readonly markSeen: () => void;
}

/** The person's `files` notification, read on mount, on `tick` and after any mark. */
export function useFilesSeen(api: ApiClient, contactId: string, tick: number): FilesSeen {
  const id = notificationId('files', contactId.toLowerCase());
  const [unseen, setUnseen] = useState(false);
  const alive = useRef(true);
  // Only an item the last read saw unseen is marked (no write when nothing waits).
  const unseenRef = useRef(false);

  const read = useCallback(async (): Promise<void> => {
    const result = await api.get(NOTIFICATIONS_PATH).catch(() => undefined);
    if (!alive.current || result?.kind !== 'ok') return;
    const list = readNotificationList(result.data);
    if (list === undefined) return;
    const next = list.items.some((i) => i.id === id && !i.read);
    unseenRef.current = next;
    setUnseen(next);
  }, [api, id]);

  useEffect(() => {
    alive.current = true;
    void read();
    const onChanged = (): void => void read();
    window.addEventListener(NOTIFICATIONS_CHANGED, onChanged);
    return () => {
      alive.current = false;
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChanged);
    };
  }, [read, tick]);

  const markSeen = useCallback((): void => {
    if (!unseenRef.current) return;
    unseenRef.current = false;
    setUnseen(false);
    void api
      .post(NOTIFICATION_READ_PATH.replace(':id', id))
      .then((r) => {
        if (r.kind === 'ok' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
        }
      })
      .catch(() => undefined);
  }, [api, id]);

  return { unseen, markSeen };
}
