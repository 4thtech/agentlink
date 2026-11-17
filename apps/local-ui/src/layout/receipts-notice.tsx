// SEC-RECEIPTS-DEFAULT (D-156; 11 §5.10): the one-time notice on Home after the update that turned
// received receipts on by default. Closable; "Got it" or "Open Settings" closes it for good, and the
// app keeps the dismissal for every browser (notices/index.ts, prefs/app-kept.ts). Fixed words only.
import { Button, PageNotice } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { useDismissed } from '../notices/index.js';
import { navigate } from '../router.js';

export const RECEIPTS_NOTICE_KEY = 'receipts-on';

/** Where the owner turns received receipts off (the Rules page, Everyday). */
export const RECEIPTS_SETTING_PATH = '/settings/rules';

/** 11 §5.10 "One-time notice after the update", word for word (title and body together). */
export const RECEIPTS_NOTICE_STRINGS = Object.freeze({
  title: 'AgentLink now tells your contacts when your AI app has received their message.',
  body: 'This also shows them that your AI app was open at about that time. You can turn this off in Settings.',
  gotIt: 'Got it',
  openSettings: 'Open Settings',
});

const S = RECEIPTS_NOTICE_STRINGS;

/** The notice, until it is dismissed. */
export function ReceiptsNotice(): ReactElement | null {
  const [dismissed, dismiss] = useDismissed(RECEIPTS_NOTICE_KEY);
  if (dismissed) return null;
  return (
    <PageNotice
      tone="info"
      title={S.title}
      onDismiss={dismiss}
      dismissLabel={S.gotIt}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={dismiss}>
            {S.gotIt}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              dismiss();
              navigate(RECEIPTS_SETTING_PATH);
            }}
          >
            {S.openSettings}
          </Button>
        </>
      }
    >
      <p>{S.body}</p>
    </PageNotice>
  );
}
