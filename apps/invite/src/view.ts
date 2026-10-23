// Fills the invite page (08 §4, 11 §6.5). Every value from the payload (the name, the expiry, the
// fingerprint) is set with `textContent` only, never as HTML, so under Trusted Types no HTML sink is
// used at all. The page's elements are fixed in the HTML: nothing here creates an element, and
// nothing derived from the invite becomes one. The prompt sits in its own section under our own
// heading, apart from the inviter details; the copy button copies the string the script holds, never
// text read back from the page.
import type { InviteView } from './invite-state.js';
import { strings } from './strings.js';

function element(doc: Document, id: string): HTMLElement {
  const found = doc.getElementById(id);
  if (found === null) throw new Error(`missing element ${id}`);
  return found;
}

/** `2026-10-17 08:00 UTC` for unix seconds. */
function formatExpiry(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')}${strings.inviter.expirySuffix}`;
}

/** Shows `view`. `copy` writes a string to the clipboard; the page never pastes or opens anything. */
export function render(
  doc: Document,
  view: InviteView,
  host: string,
  copy: (text: string) => Promise<void>,
): void {
  const state = element(doc, 'state');
  const inviter = element(doc, 'inviter');
  const prompt = element(doc, 'prompt');
  const promptText = element(doc, 'prompt-text');
  const copyButton = element(doc, 'copy') as HTMLButtonElement;
  const copyStatus = element(doc, 'copy-status');

  // Start from nothing shown: a state never shows a prompt.
  inviter.hidden = true;
  prompt.hidden = true;
  promptText.textContent = '';
  copyStatus.textContent = '';
  copyButton.onclick = null;

  state.dataset['state'] = view.kind;
  state.textContent = strings.states[view.kind];

  if (view.kind === 'ready') {
    // The quotes are ours; the name between them is text.
    element(doc, 'inviter-name').textContent = `“${view.inviter.name}”`;
    element(doc, 'inviter-label').textContent = strings.inviter.label;
    element(doc, 'inviter-fingerprint').textContent = view.inviter.fingerprint;
    element(doc, 'inviter-expiry').textContent = formatExpiry(view.inviter.expiresAt);
    element(doc, 'inviter-host').textContent = host;
    inviter.hidden = false;

    const text = view.prompt; // held by the script; the button copies this string
    promptText.textContent = text;
    copyButton.onclick = (): void => {
      copy(text).then(
        () => {
          copyStatus.textContent = strings.prompt.copied;
        },
        () => {
          copyStatus.textContent = strings.prompt.copyFailed;
        },
      );
    };
    prompt.hidden = false;
  }

  state.dataset['ready'] = 'true';
}
