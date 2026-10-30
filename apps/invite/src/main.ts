// The invite page's one first-party script (08 §4, D-53). It reads the fragment in the browser, shows
// what it finds and does nothing else: no beacon, no storage write, no paste, no navigation. Its one
// request is for a short link (D-139, 04 §3.6.2): a GET of the invite object by lookupId from the
// drop host, again only when the person clicks Try again. Copying is a user action (the copy button).
import './interpreted-parsers.js'; // first: it must run before the schemas load
import { inviteFetcher } from './drop-fetch.js';
import { evaluateFragment } from './invite-state.js';
import { render } from './view.js';

const hash = window.location.hash;
const host = window.location.host;
const fetchObject = inviteFetcher((input, init) => window.fetch(input, init));
const copy = (text: string): Promise<void> => navigator.clipboard.writeText(text);

async function show(): Promise<void> {
  const view = await evaluateFragment(hash, Math.floor(Date.now() / 1000), fetchObject);
  render(document, view, host, copy, () => {
    void show();
  });
}

await show();
