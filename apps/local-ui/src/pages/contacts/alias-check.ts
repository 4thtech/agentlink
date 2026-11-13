// UX1113-N2: the rename name is checked while typing (`rename-check`, debounced), never between the
// click and the gesture, so the one "Rename with Touch ID" button goes straight to the sensor. The
// server checks the name again when it signs; this only holds the button and words the refusal.
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { parseRenameCheck, renameCheckPath } from './data.js';
import { CONTACTS_STRINGS as C } from './strings.js';

/** How long typing pauses before the name is checked. */
export const ALIAS_CHECK_DELAY_MS = 300;

export type AliasCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'refused'; readonly message: string; readonly hold: boolean };

export function useAliasCheck(
  api: ApiClient,
  contactRef: string,
  wanted: string,
  active: boolean,
  delayMs: number = ALIAS_CHECK_DELAY_MS,
): AliasCheck {
  const [check, setCheck] = useState<AliasCheck>({ kind: 'pending' });
  useEffect(() => {
    if (!active) return undefined;
    if (wanted === '') {
      setCheck({ kind: 'refused', message: C.aliasInvalid, hold: true });
      return undefined;
    }
    let live = true;
    setCheck({ kind: 'pending' });
    const timer = setTimeout(() => {
      let path: string;
      try {
        path = renameCheckPath(contactRef, wanted);
      } catch {
        setCheck({ kind: 'refused', message: C.contactUnknown, hold: true });
        return;
      }
      void api.get(path).then(
        (res) => {
          if (!live) return;
          const answer =
            res.kind === 'ok'
              ? parseRenameCheck(res.data)
              : ({ kind: 'refused', reason: 'unavailable' } as const);
          if (answer.kind === 'ok') return setCheck({ kind: 'ok' });
          setCheck(
            answer.reason === 'alias_taken'
              ? { kind: 'refused', message: C.aliasTaken, hold: true }
              : answer.reason === 'alias_invalid'
                ? { kind: 'refused', message: C.aliasInvalid, hold: true }
                : answer.reason === 'contact_unknown'
                  ? { kind: 'refused', message: C.contactUnknown, hold: true }
                  : { kind: 'refused', message: C.renameUnavailable, hold: false },
          );
        },
        () => {
          if (live) setCheck({ kind: 'refused', message: C.renameUnavailable, hold: false });
        },
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, contactRef, wanted, active, delayMs]);
  return check;
}
