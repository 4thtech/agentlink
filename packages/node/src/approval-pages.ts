// M1-11b-2c: the approval server's fixed pages (08 §1; 11 §6.2.1; 04 §2.5). Approvals live in the
// local app (apps/local-ui, D-118), which the server serves on `/` and `/approve/<id>` when the CLI
// embeds it; the server-rendered approval page and its script, stylesheet and sidebar copy are gone.
//
// What is left are two fixed pages, each plain text in fixed HTML: no script, no stylesheet, no
// form, no CSRF token and nothing from the request (I-5), served under the same strict CSP.
// - EXPIRED_HTML: the 401 answer (a used or unknown link, no session); EXPIRED_APPROVAL_HTML is
//   the same answer on an approval link (`/approve/<id>`).
// - NO_APP_HTML: `/` and `/approve/<id>` on a server without the app bundle. It points to `approve`
//   in the owner's own terminal; without a page there is no CSRF token, so nothing can be decided
//   in the browser at all (the API gates are unchanged).

import { CLI_COMMAND } from './cli-command.js';

/** Every text the fixed pages show (11 §5 vocabulary). */
export const PAGE_STRINGS = Object.freeze({
  title: 'AgentLink',
  // R1-UI-12: plain steps per computer first; the terminal is a small second line.
  expiredTitle: 'This link has expired',
  expired: 'Open AgentLink again to get a new one. It takes a few seconds.',
  expiredMac:
    'Mac: open AgentLink from your Applications folder, or press Cmd + Space and type AgentLink.',
  expiredWindows: 'Windows: open AgentLink from the Start menu.',
  expiredLinux: 'Linux: open AgentLink from your app menu.',
  expiredAi: 'Or ask your AI to open AgentLink for you.',
  expiredTerminal: 'If you use a terminal, run',
  // REL051-INTFIX: an expired approval link says where the approval is once AgentLink is open
  // again (Home, Waiting for you), and its terminal line names the command that shows approvals.
  expiredApproval:
    'Open AgentLink again to get a new one. If the request still waits, it is on Home under Waiting for you.',
  noAppTitle: "Approvals can't open here",
  noApp: `This copy of AgentLink can't show approvals in the browser. Run ${CLI_COMMAND} approve in your own terminal, or update AgentLink.`,
});

/** One fixed page: a heading and one paragraph whose command is set as code. */
function fixedPage(heading: string, text: string): string {
  const command = `${CLI_COMMAND} approve`;
  const [before, after] = text.split(command);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${PAGE_STRINGS.title}</title></head>`,
    `<body><main><h1>${heading}</h1>`,
    `<p>${before ?? ''}<code>${command}</code>${after ?? ''}</p>`,
    '</main></body></html>',
    '',
  ].join('\n');
}

/** One expired-link page: plain steps per computer first, the terminal command a small second line. */
function expiredPage(text: string, command: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${PAGE_STRINGS.title}</title></head>`,
    `<body><main><h1>${PAGE_STRINGS.expiredTitle}</h1>`,
    `<p>${text}</p>`,
    `<ul><li>${PAGE_STRINGS.expiredMac}</li><li>${PAGE_STRINGS.expiredWindows}</li><li>${PAGE_STRINGS.expiredLinux}</li></ul>`,
    `<p>${PAGE_STRINGS.expiredAi}</p>`,
    `<p><small>${PAGE_STRINGS.expiredTerminal} <code>${command}</code></small></p>`,
    '</main></body></html>',
    '',
  ].join('\n');
}

/** The 401 page (11 §6.2.1 "local link expired"). Fixed text; nothing from the request. */
export const EXPIRED_HTML = expiredPage(PAGE_STRINGS.expired, `${CLI_COMMAND} ui`);

/**
 * The 401 page for an approval link (`/approve/<id>`): the same steps, but it says where the
 * approval is (Home, Waiting for you) and its terminal line is `approve`, which lists what waits. Fixed text; nothing from
 * the request (not even the approval ID).
 */
export const EXPIRED_APPROVAL_HTML = expiredPage(
  PAGE_STRINGS.expiredApproval,
  `${CLI_COMMAND} approve`,
);

/** `/` and `/approve/<id>` without the app bundle. Fixed text; nothing from the request. */
export const NO_APP_HTML = fixedPage(PAGE_STRINGS.noAppTitle, PAGE_STRINGS.noApp);

/**
 * UX1113-QA-HOST: any other path outside the API (no session, or no app bundle). Fixed text and one
 * plain link to Home; no script, no token and nothing from the request.
 */
export const NOT_FOUND_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${PAGE_STRINGS.title}</title></head>`,
  '<body><main><h1>Page not found</h1>',
  `<p>This page isn't here. <a href="/">Go to Home</a></p>`,
  '</main></body></html>',
  '',
].join('\n');
