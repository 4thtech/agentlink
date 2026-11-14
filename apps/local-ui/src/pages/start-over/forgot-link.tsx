// OWNER-START-OVER (D-153): the quiet link under a master code field, to "Start over on this
// computer" (/restore/start-over). A plain link: the page it opens explains what is lost and offers
// Restore from recovery kit first. Kept tiny so code fields do not load the start-over page.
import type { ReactElement } from 'react';
import { FORGOT_LINK } from './strings.js';

export function ForgotCodeLink(): ReactElement {
  return (
    <p className="al-field-hint">
      <a className="al-link" href="/restore/start-over" data-forgot-code="">
        {FORGOT_LINK}
      </a>
    </p>
  );
}
