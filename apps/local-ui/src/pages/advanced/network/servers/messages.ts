// NET-UI-B: the words for a refused or failed request (specs/11 §5.14), and one date format.
import { gateMessage } from '../../../agents/owner-gate.js';
import type { Fail } from './api.js';
import { SERVERS_STRINGS as S } from './strings.js';

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Unix seconds as a date; never throws. */
export const dayText = (seconds: number): string => DAY.format(new Date(seconds * 1000));
export const timeText = (seconds: number): string => TIME.format(new Date(seconds * 1000));

/** One sentence for a failure, always from the fixed strings (never text a server sent). */
export function failMessage(fail: Fail): string {
  if (fail.kind === 'refused') {
    switch (fail.code) {
      case 'invalid_list':
        return S.invalidList;
      case 'not_ready':
        return `${S.needTwoTitle}. ${S.needTwo}`;
      case 'same_list':
        return S.sameList;
      case 'too_many_previous':
        return `${S.tooManyOldTitle}. ${S.tooManyOld(
          fail.fitsFrom === undefined ? undefined : dayText(fail.fitsFrom),
        )}`;
      case 'rotation_pending':
        return S.finishing;
      case 'agent_paused':
        return S.pausedTitle;
      case 'changed':
        return S.changed;
      case 'mix_in_on':
      case 'not_applied':
        return S.failed;
    }
  }
  if (fail.kind === 'failed') return S.failed;
  return gateMessage({ kind: fail.kind }) ?? S.failed;
}
