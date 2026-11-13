// R1-UI-01: Home before any ID exists. One clear way forward, inside the app: no terminal command and
// no "ask your AI" (design-1112 §8). The wizard creates the first ID with one Touch ID.
import { Button, Icon } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { navigate } from '../../router.js';
import { START_FIRST_STEP } from './guard.js';
import { FINISH_SETUP as T } from './strings.js';
import './start.css';

export function FinishSetupCard(): ReactElement {
  return (
    <section className="st-card st-finish al-reveal" aria-labelledby="st-finish-h" data-no-id="">
      <h2 id="st-finish-h" className="al-text-title-2">
        {T.title}
      </h2>
      <p className="al-lede">{T.body}</p>
      <div>
        <Button
          variant="primary"
          size="lg"
          className="al-press"
          onClick={() => navigate(START_FIRST_STEP)}
        >
          <Icon name="user-plus" size={18} />
          {T.create}
        </Button>
      </div>
    </section>
  );
}
