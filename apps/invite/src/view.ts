// Fills the invite page (08 §4, 11 §6.5, b11 §33.1). Every value from the payload (the name, the
// expiry, the fingerprint) is set with `textContent` only, never as HTML, so under Trusted Types no
// HTML sink is used at all. The page's elements are fixed in the HTML: nothing here creates an
// element, and nothing derived from the invite becomes one.
//
// U3-invite: the step section ("Set up in 2 minutes") sits under our own heading, apart from the
// inviter section, and holds no payload text: only the fixed command or sentence with the canonical
// link. The Copy button copies the string the script holds for the selected way, never text read back
// from the page, and with no trailing line break. The "Need Node.js?" link is fixed in the HTML.
import type { InviteView } from './invite-state.js';
import { expiredFor, invitesHeading, nextFor, strings } from './strings.js';

function element(doc: Document, id: string): HTMLElement {
  const found = doc.getElementById(id);
  if (found === null) throw new Error(`missing element ${id}`);
  return found;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Works once, until 19 Oct 2026." for unix seconds (UTC). */
export function formatExpiry(seconds: number): string {
  const at = new Date(seconds * 1000);
  const day = `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''} ${String(at.getUTCFullYear())}`;
  return `${strings.inviter.expiryPrefix}${day}${strings.inviter.expirySuffix}`;
}

/** How long "Copied" stays (b11 §6 row 6). */
const COPIED_MS = 1600;

type Way = 'command' | 'askAi';

/**
 * Shows `view`. `copy` writes a string to the clipboard; the page never pastes or opens anything.
 * `retry` checks the invite once more (the `unreachable` state's Try again button).
 */
export function render(
  doc: Document,
  view: InviteView,
  host: string,
  copy: (text: string) => Promise<void>,
  retry?: () => void,
): void {
  const state = element(doc, 'state');
  const retryButton = element(doc, 'retry') as HTMLButtonElement;
  const inviter = element(doc, 'inviter');
  const step = element(doc, 'step');
  const next = element(doc, 'next');
  const stepText = element(doc, 'step-text');
  const copyButton = element(doc, 'copy') as HTMLButtonElement;
  const copyStatus = element(doc, 'copy-status');
  const tabCommand = element(doc, 'tab-command') as HTMLButtonElement;
  const tabAi = element(doc, 'tab-ai') as HTMLButtonElement;
  const switcher = element(doc, 'switch');
  const nodeHelp = element(doc, 'node-help');
  const panelLabel = element(doc, 'panel-label');
  const stepHelp = element(doc, 'step-help');
  const panel = element(doc, 'panel');

  // Start from nothing shown: a state never shows a command or a sentence.
  inviter.hidden = true;
  step.hidden = true;
  next.hidden = true;
  next.textContent = '';
  stepText.textContent = '';
  copyStatus.textContent = '';
  copyButton.onclick = null;
  tabCommand.onclick = null;
  tabAi.onclick = null;
  retryButton.onclick = null;
  retryButton.hidden = true;
  retryButton.disabled = false;
  element(doc, 'inviter-host').textContent = host;

  state.dataset['state'] = view.kind;
  state.textContent =
    view.kind === 'expired' && view.name !== undefined
      ? expiredFor(view.name)
      : strings.states[view.kind];
  state.hidden = view.kind === 'ready';

  if (view.kind === 'unreachable' && retry !== undefined) {
    retryButton.textContent = strings.retry;
    retryButton.hidden = false;
    // One click, one more check: the button is off until that check is shown.
    retryButton.onclick = (): void => {
      retryButton.onclick = null;
      retryButton.disabled = true;
      state.textContent = strings.states.loading;
      retry();
    };
  }

  if (view.kind === 'ready') {
    const { inviter: who } = view;
    element(doc, 'invite-heading').textContent = who.fallback
      ? strings.heading.someone
      : invitesHeading(who.name);
    // The quotes are ours; the name between them is text.
    element(doc, 'inviter-name').textContent = `“${who.name}”`;
    element(doc, 'inviter-label').textContent = strings.inviter.label;
    element(doc, 'inviter-fingerprint').textContent = who.fingerprint;
    element(doc, 'inviter-expiry').textContent = formatExpiry(who.expiresAt);
    inviter.hidden = false;

    // Held by the script; the button copies one of these strings, never the page's text.
    const texts: Readonly<Record<Way, string | undefined>> = {
      command: view.command,
      askAi: view.sentence,
    };
    let way: Way = view.command === undefined ? 'askAi' : 'command';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (chosen: Way): void => {
      way = chosen;
      const command = chosen === 'command';
      tabCommand.setAttribute('aria-selected', String(command));
      tabAi.setAttribute('aria-selected', String(!command));
      tabCommand.tabIndex = command ? 0 : -1;
      tabAi.tabIndex = command ? -1 : 0;
      panel.setAttribute('aria-labelledby', command ? 'tab-command' : 'tab-ai');
      panelLabel.textContent = command ? strings.step.commandLabel : strings.step.askAiLabel;
      stepHelp.textContent = command ? strings.step.commandHelp : strings.step.askAiHelp;
      nodeHelp.hidden = !command;
      stepText.textContent = texts[chosen] ?? '';
      copyStatus.textContent = '';
      copyButton.textContent = strings.step.copy;
    };
    // Too long for a command (08 §4): no switch, only the sentence.
    switcher.hidden = view.command === undefined;
    tabCommand.onclick = (): void => {
      show('command');
    };
    tabAi.onclick = (): void => {
      show('askAi');
    };
    switcher.onkeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const to: Way = way === 'command' ? 'askAi' : 'command';
      show(to);
      (to === 'command' ? tabCommand : tabAi).focus();
    };
    copyButton.onclick = (): void => {
      const text = texts[way];
      if (text === undefined) return;
      copy(text).then(
        () => {
          copyButton.textContent = strings.step.copied;
          copyStatus.textContent = strings.step.copied;
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => {
            copyButton.textContent = strings.step.copy;
          }, COPIED_MS);
        },
        () => {
          copyStatus.textContent = strings.step.copyFailed;
        },
      );
    };
    show(way);
    step.hidden = false;
    next.textContent = who.fallback ? strings.step.nextSomeone : nextFor(who.name);
    next.hidden = false;
  }

  state.dataset['ready'] = 'true';
}
