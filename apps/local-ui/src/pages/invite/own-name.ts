// W4-PEOPLE-INVITE: your own name for the letter icons and the friend preview: the open agent's
// name from the shared live store (U1's one subscription), read only when the caller gave none.
import { useEffect, useState } from 'react';
import { getLive, subscribeLive } from '../../api/live.js';

/** The open agent's name, from the shared live store (read only when the caller gave none). */
export function useOwnName(given: string | undefined): string {
  const [name, setName] = useState(given ?? '');
  useEffect(() => {
    if (given !== undefined) return undefined;
    const read = (): void => {
      const current = getLive().agents.find((a) => a.current);
      if (current !== undefined) setName(current.label);
    };
    read();
    return subscribeLive(read);
  }, [given]);
  return given ?? name;
}
