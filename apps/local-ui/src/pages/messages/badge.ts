// The Messages badge in the sidebar (MSG-FILES-IO-e): how many contacts have inbound messages newer
// than this browser's seen marker. It reads the same list the page reads (GET only), and a failure
// is just no badge: a number is never a gate and never shows what a message said.
import { useEffect, useState } from 'react';
import { createApiClient } from '../../api/client.js';
import { createMessagesApi, type Conversation } from './api.js';
import { countUnseen, loadSeen, SEEN_EVENT } from './seen.js';

const SKIP = new Set(['/first-run']);

/** `override` is a test seam that returns the count directly. */
export function useUnseenMessages(path: string, override?: () => Promise<number>): number {
  const [list, setList] = useState<readonly Conversation[]>([]);
  const [fixed, setFixed] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (SKIP.has(path)) return undefined;
    let live = true;
    if (override !== undefined) {
      override().then(
        (n) => live && setFixed(n),
        () => live && setFixed(0),
      );
    } else {
      createMessagesApi(createApiClient())
        .conversations()
        .then(
          (r) => live && setList(r.ok ? r.value : []),
          () => live && setList([]),
        );
    }
    return () => {
      live = false;
    };
  }, [path, override]);

  useEffect(() => {
    const onSeen = (): void => tick((n) => n + 1);
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => window.removeEventListener(SEEN_EVENT, onSeen);
  }, []);

  return override !== undefined ? fixed : countUnseen(list, loadSeen());
}
