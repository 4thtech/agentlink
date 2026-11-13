// Fills the invite page (08 §4, 11 §6.5, b11 §33.1). Every value from the payload (the name, the
// expiry, the fingerprint) is set with `textContent` only, never as HTML, so under Trusted Types no
// HTML sink is used at all. The page's elements are fixed in the HTML: nothing here creates an
// element, and nothing derived from the invite becomes one.
//
// U3-invite: the step section ("Set up in 2 minutes") sits under our own heading, apart from the
// inviter section, and holds no payload text: only the fixed sentence, command and canonical link.
// W6-INVITE-DESIGN: the three ways to accept are three cards (order: REL051-INV below). Each Copy
// button copies the string
// the script holds for its card, never text read back from the page, with no trailing line break.
// WP-2: the command card offers one command per computer, chosen from the browser and changeable
// with buttons; the installers need no Node.js.
// REL051-INV: the simplest path first. The command card leads (Mac, Windows, Linux or Node.js, each
// with where to paste it), then the link for people who already have AgentLink, then Ask your AI. A
// phone gets a line saying AgentLink runs on a computer. The Mac app shows only when the release
// switch MAC_APP_AVAILABLE is on (config.ts); its link is a build constant.
import { MAC_APP_AVAILABLE, MAC_APP_URLS, WIN_APP_AVAILABLE, WIN_APP_URL } from './config.js';
import type { InviteView } from './invite-state.js';
import type { InviteCommands } from './prompt.js';
import { DESKTOP_APP_LINKS, GET_APP_URL } from './flags.js';
import { expiredFor, invitesHeading, nextFor, strings } from './strings.js';

/** The computer a command is for (WP-2, REL051-INV). */
export type Os = 'mac' | 'windows' | 'linux' | 'node';

const OSES: readonly Os[] = ['mac', 'windows', 'linux', 'node'];

/** Which of the three commands each choice copies: Mac and Linux share the shell installer. */
export const COMMAND_FOR: Readonly<Record<Os, keyof InviteCommands>> = {
  mac: 'unix',
  windows: 'windows',
  linux: 'unix',
  node: 'node',
};

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

/**
 * WP-2, REL051-INV: the computer chosen first for a browser's user agent: Windows, Linux (also
 * ChromeOS and Android), otherwise Mac (also iPhone and iPad, and anything unknown). Read in the
 * page only; nothing is sent to choose it.
 */
export function osFor(userAgent: string): Exclude<Os, 'node'> {
  if (/\bWindows\b/.test(userAgent)) return 'windows';
  if (/\b(iPhone|iPad|iPod|Macintosh|Mac OS X)\b/.test(userAgent)) return 'mac';
  if (/\b(Linux|X11|CrOS|Android)\b/.test(userAgent)) return 'linux';
  return 'mac';
}

/**
 * REL051-INV: true for a phone or tablet, where the command cannot run. iPadOS 13 and later report
 * a Mac user agent, so a Mac user agent with more than one touch point (`navigator.maxTouchPoints`)
 * is a tablet too; a Mac has none.
 */
export const isPhone = (userAgent: string, maxTouchPoints = 0): boolean =>
  /\b(iPhone|iPad|iPod|Android|Mobile)\b/.test(userAgent) ||
  (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1);

/** How long "Copied" stays (b11 §6 row 6). */
const COPIED_MS = 1600;

/** Page options read from the browser (REL051-INV). `macApp` defaults to MAC_APP_AVAILABLE. */
export interface RenderOptions {
  /** The computer shown first (WP-2); null: none yet (a phone or tablet), the person picks one. */
  readonly os?: Os | null;
  /** A phone or tablet: show the "runs on a computer" line. */
  readonly phone?: boolean;
  /** The Mac app release switch (tests pass it; the page uses the build constant). */
  readonly macApp?: boolean;
  /** WIN-DESK-1d: the Windows app release switch (default WIN_APP_AVAILABLE). */
  readonly winApp?: boolean;
}

/**
 * Shows `view`. `copy` writes a string to the clipboard; the page never pastes or opens anything.
 * `retry` checks the invite once more (the `unreachable` state's Try again button). WP-D9: the app
 * links follow the build-time flag of flags.ts.
 */
export function render(
  doc: Document,
  view: InviteView,
  copy: (text: string) => Promise<void>,
  retry?: () => void,
  options: RenderOptions = {},
): void {
  const { phone = false, macApp = MAC_APP_AVAILABLE, winApp = WIN_APP_AVAILABLE } = options;
  const os = options.os === undefined ? (phone ? null : 'mac') : options.os;
  const state = element(doc, 'state');
  const retryButton = element(doc, 'retry') as HTMLButtonElement;
  const inviter = element(doc, 'inviter');
  const step = element(doc, 'step');
  const next = element(doc, 'next');
  const copyStatus = element(doc, 'copy-status');
  const wayCommand = element(doc, 'way-command');
  const appLinks = element(doc, 'app-links');
  const openApp = element(doc, 'open-app');
  const getApp = element(doc, 'get-app');
  const osButtons = OSES.map((o) => [o, element(doc, `os-${o}`) as HTMLButtonElement] as const);
  // The three cards, in order (REL051-INV): the command, the link, Ask your AI. `text` is what the
  // card shows and its button copies; `label` is the button's resting text.
  const cards = [
    {
      card: 'way-command',
      title: strings.step.command,
      help: 'step-help',
      text: 'step-text',
      button: 'copy',
      label: strings.step.copy,
      title_id: 'way-command-title',
    },
    {
      card: 'way-link',
      title: strings.step.link,
      help: 'link-help',
      text: 'link-text',
      button: 'copy-link',
      label: strings.step.copyLink,
      title_id: 'way-link-title',
    },
    {
      card: 'way-ai',
      title: strings.step.askAi,
      help: 'ai-help',
      text: undefined,
      button: 'copy-ai',
      label: strings.step.copy,
      title_id: 'way-ai-title',
    },
  ] as const;
  const phoneNote = element(doc, 'phone-note');
  const macAppBlock = element(doc, 'mac-app');
  const macAppLinks = (['arm64', 'x64'] as const).map(
    (arch) => [arch, element(doc, `mac-app-${arch}`)] as const,
  );
  const helpAgain = element(doc, 'help-again');
  const winAppBlock = element(doc, 'win-app');
  const winAppLink = element(doc, 'win-app-link');

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
  for (const [, button] of osButtons) button.onclick = null;
  // WP-D9: no app link unless this build has them on and this view is a checked invite.
  appLinks.hidden = true;
  openApp.removeAttribute('href');
  getApp.removeAttribute('href');
  openApp.textContent = '';
  getApp.textContent = '';
  retryButton.onclick = null;
  phoneNote.hidden = true;
  macAppBlock.hidden = true;
  for (const [, link] of macAppLinks) link.removeAttribute('href');
  winAppBlock.hidden = true;
  winAppLink.removeAttribute('href');
  helpAgain.hidden = true;
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

    let chosen: Os | null = os;
    // Held by the script; each button copies one of these strings, never the page's text.
    const textOf = (card: (typeof cards)[number]['card']): string | undefined =>
      card === 'way-ai'
        ? view.sentence
        : card === 'way-command'
          ? chosen === null
            ? undefined
            : view.commands?.[COMMAND_FOR[chosen]]
          : view.inviteUrl;
    const helpOf = (card: (typeof cards)[number]['card']): string =>
      card === 'way-ai'
        ? strings.step.askAiHelp
        : card === 'way-command'
          ? chosen === null
            ? ''
            : strings.step.commandHelp[chosen]
          : strings.step.linkHelp;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const resetLabels = (): void => {
      for (const other of cards) {
        (element(doc, other.button) as HTMLButtonElement).textContent = other.label;
      }
    };
    // One short line (the link is shortened), never the whole link; the button copies all of it.
    const show = (c: (typeof cards)[number]): void => {
      element(doc, c.help).textContent = helpOf(c.card);
      if (c.text !== undefined) {
        element(doc, c.text).textContent = (textOf(c.card) ?? '')
          .split(view.inviteUrl)
          .join(shorten(view.inviteUrl));
      }
    };
    for (const c of cards) {
      const button = element(doc, c.button) as HTMLButtonElement;
      element(doc, c.title_id).textContent = c.title;
      show(c);
      button.textContent = c.label;
      // Too long for a command (08 §4): that card is left out, the others stay.
      element(doc, c.card).hidden = textOf(c.card) === undefined;
      button.onclick = (): void => {
        const text = textOf(c.card);
        if (text === undefined) return;
        copy(text).then(
          () => {
            resetLabels();
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

    // WP-2: the computer buttons. Each shows its command, where to paste it and what it does; the
    // Copy button follows. The Mac app (release switch) shows under the Mac choice only.
    element(doc, 'os-group').setAttribute('aria-label', strings.step.os.label);
    element(doc, 'copy-step').textContent = strings.step.copyStep;
    const commandCard = cards[0];
    if (macApp) {
      element(doc, 'mac-app-lead').textContent = strings.step.macApp.lead;
      for (const [arch, link] of macAppLinks) {
        link.textContent = strings.step.macApp[arch];
        link.setAttribute('href', MAC_APP_URLS[arch]);
      }
      element(doc, 'mac-app-which').textContent = strings.step.macApp.which;
      element(doc, 'mac-app-note').textContent = strings.step.macApp.note;
    }
    if (winApp) {
      element(doc, 'win-app-lead').textContent = strings.step.winApp.lead;
      winAppLink.textContent = strings.step.winApp.link;
      winAppLink.setAttribute('href', WIN_APP_URL);
      element(doc, 'win-app-note').textContent = strings.step.winApp.note;
    }
    // On a phone or tablet nothing is chosen first (null): no command is shown until the person
    // picks the computer they will use.
    const choose = (o: Os | null): void => {
      chosen = o;
      for (const [other, button] of osButtons) {
        button.setAttribute('aria-pressed', other === o ? 'true' : 'false');
      }
      element(doc, 'open-help').textContent =
        o === null ? strings.step.pickComputer : strings.step.openHelp[o];
      element(doc, 'step-text').hidden = o === null;
      element(doc, 'copy').hidden = o === null;
      macAppBlock.hidden = !(macApp && o === 'mac');
      winAppBlock.hidden = !(winApp && o === 'windows');
      show(commandCard);
    };
    for (const [o, button] of osButtons) {
      button.textContent = strings.step.os[o];
      button.onclick = (): void => {
        if (chosen === o) return;
        choose(o);
        resetLabels();
        copyStatus.textContent = '';
      };
    }
    choose(chosen);

    // WP-D9: "Open in the AgentLink app" next to the command. The address is the script's own
    // `agentlink://join#<payload>` (built from the checked payload, never read from the page); the
    // person's click hands it to the app on this computer, so the fragment reaches no server.
    // Behind the build-time flag (flags.ts): off until the desktop app is released.
    if (DESKTOP_APP_LINKS) {
      openApp.setAttribute('href', view.appLink);
      openApp.textContent = strings.step.openApp;
      getApp.setAttribute('href', GET_APP_URL);
      getApp.textContent = strings.step.getApp;
      appLinks.hidden = false;
    }

    wayCommand.hidden = view.commands === undefined;
    phoneNote.textContent = strings.step.phone;
    phoneNote.hidden = !phone;
    helpAgain.hidden = view.commands === undefined;
    step.hidden = false;
    next.textContent = who.fallback ? strings.step.nextSomeone : nextFor(who.name);
    next.hidden = false;
  }

  state.dataset['ready'] = 'true';
}
