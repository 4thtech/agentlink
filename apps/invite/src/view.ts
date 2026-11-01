// Fills the invite page (08 §4, 11 §6.5, b11 §33.1). Every value from the payload (the name, the
// expiry, the fingerprint) is set with `textContent` only, never as HTML, so under Trusted Types no
// HTML sink is used at all. The page's elements are fixed in the HTML: nothing here creates an
// element, and nothing derived from the invite becomes one.
//
// U3-invite: the step section ("Set up in 2 minutes") sits under our own heading, apart from the
// inviter section, and holds no payload text: only the fixed sentence, command and canonical link.
// W6-INVITE-DESIGN: the three ways to accept are three cards, in this order: the sentence for the
// person's AI, the command, and the link to paste into AgentLink. Each Copy button copies the string
// the script holds for its card, never text read back from the page, with no trailing line break.
// The "Need Node.js?" link is fixed in the HTML.
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

/** "agentlink.4thtech.io/i#jVPL…mfnHw": the host, the path and the ends of the fragment. */
export function shorten(link: string): string {
  const at = link.indexOf('#');
  const head = link.slice(0, at + 1).replace(/^https:\/\//, '');
  const rest = link.slice(at + 1);
  return rest.length <= 14 ? head + rest : `${head}${rest.slice(0, 4)}…${rest.slice(-5)}`;
}

/** How long "Copied" stays (b11 §6 row 6). */
const COPIED_MS = 1600;

/**
 * Shows `view`. `copy` writes a string to the clipboard; the page never pastes or opens anything.
 * `retry` checks the invite once more (the `unreachable` state's Try again button).
 */
export function render(
  doc: Document,
  view: InviteView,
  copy: (text: string) => Promise<void>,
  retry?: () => void,
): void {
  const state = element(doc, 'state');
  const retryButton = element(doc, 'retry') as HTMLButtonElement;
  const inviter = element(doc, 'inviter');
  const step = element(doc, 'step');
  const next = element(doc, 'next');
  const copyStatus = element(doc, 'copy-status');
  const wayCommand = element(doc, 'way-command');
  // The three cards, in order: Ask your AI, the command, the link. `text` is what the card shows
  // and its button copies; `label` is the button's resting text.
  const cards = [
    {
      card: 'way-ai',
      title: strings.step.askAi,
      help: 'ai-help',
      helpText: strings.step.askAiHelp,
      text: undefined,
      button: 'copy-ai',
      label: strings.step.copy,
      title_id: 'way-ai-title',
    },
    {
      card: 'way-command',
      title: strings.step.command,
      help: 'step-help',
      helpText: strings.step.commandHelp,
      text: 'step-text',
      button: 'copy',
      label: strings.step.copy,
      title_id: 'way-command-title',
    },
    {
      card: 'way-link',
      title: strings.step.link,
      help: 'link-help',
      helpText: strings.step.linkHelp,
      text: 'link-text',
      button: 'copy-link',
      label: strings.step.copyLink,
      title_id: 'way-link-title',
    },
  ] as const;

  // Start from nothing shown: a state never shows a command or a sentence.
  inviter.hidden = true;
  step.hidden = true;
  next.hidden = true;
  next.textContent = '';
  copyStatus.textContent = '';
  for (const c of cards) {
    if (c.text !== undefined) element(doc, c.text).textContent = '';
    (element(doc, c.button) as HTMLButtonElement).onclick = null;
  }
  retryButton.onclick = null;
  retryButton.hidden = true;
  retryButton.disabled = false;

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
    // The name is text.
    element(doc, 'inviter-name').textContent = who.name;
    element(doc, 'inviter-label').textContent = strings.inviter.label;
    element(doc, 'inviter-fingerprint').textContent = who.fingerprint;
    element(doc, 'inviter-expiry').textContent = formatExpiry(who.expiresAt);
    inviter.hidden = false;

    // Held by the script; each button copies one of these strings, never the page's text.
    const texts: Readonly<Record<(typeof cards)[number]['card'], string | undefined>> = {
      'way-ai': view.sentence,
      'way-command': view.command,
      'way-link': view.inviteUrl,
    };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for (const c of cards) {
      const text = texts[c.card];
      const button = element(doc, c.button) as HTMLButtonElement;
      element(doc, c.title_id).textContent = c.title;
      element(doc, c.help).textContent = c.helpText;
      // One short line (the link is shortened), never the whole link; the button copies all of it.
      if (c.text !== undefined) {
        element(doc, c.text).textContent = (text ?? '')
          .split(view.inviteUrl)
          .join(shorten(view.inviteUrl));
      }
      button.textContent = c.label;
      // Too long for a command (08 §4): that card is left out, the others stay.
      element(doc, c.card).hidden = text === undefined;
      button.onclick = (): void => {
        if (text === undefined) return;
        copy(text).then(
          () => {
            for (const other of cards) {
              (element(doc, other.button) as HTMLButtonElement).textContent = other.label;
            }
            button.textContent = strings.step.copied;
            copyStatus.textContent = strings.step.copied;
            const pending = timers.get(c.button);
            if (pending !== undefined) clearTimeout(pending);
            timers.set(
              c.button,
              setTimeout(() => {
                button.textContent = c.label;
              }, COPIED_MS),
            );
          },
          () => {
            copyStatus.textContent = strings.step.copyFailed;
          },
        );
      };
    }
    wayCommand.hidden = texts['way-command'] === undefined;
    step.hidden = false;
    next.textContent = who.fallback ? strings.step.nextSomeone : nextFor(who.name);
    next.hidden = false;
  }

  state.dataset['ready'] = 'true';
}
