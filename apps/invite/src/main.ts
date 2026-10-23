// The invite page's one first-party script (08 §4, D-53). It reads the fragment in the browser, shows
// what it finds and does nothing else: no request, no beacon, no storage write, no paste, no
// navigation. Copying is a user action (the copy button).
import './interpreted-parsers.js'; // first: it must run before the schemas load
import { evaluateFragment } from './invite-state.js';
import { render } from './view.js';

const view = await evaluateFragment(window.location.hash, Math.floor(Date.now() / 1000));
render(document, view, window.location.host, (text) => navigator.clipboard.writeText(text));
