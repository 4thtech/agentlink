// M1-11b-2c: the approval server's fixed pages (08 §1; 11 §6.2.1; 04 §2.5). Approvals live in the
// local app (apps/local-ui, D-118), which the server serves on `/` and `/approve/<id>` when the CLI
// embeds it; the server-rendered approval page and its script, stylesheet and sidebar copy are gone.
//
// What is left are two fixed pages, each plain text in fixed HTML: no script, no stylesheet, no
// form, no CSRF token and nothing from the request (I-5), served under the same strict CSP.
// - EXPIRED_HTML: the 401 answer (a used or unknown link, no session).
// - NO_APP_HTML: `/` and `/approve/<id>` on a server without the app bundle. It points to `approve`
//   in the owner's own terminal; without a page there is no CSRF token, so nothing can be decided
//   in the browser at all (the API gates are unchanged).

import { CLI_COMMAND } from './cli-command.js';

/** Every text the fixed pages show (11 §5 vocabulary). */
export const PAGE_STRINGS = Object.freeze({
  title: 'AgentLink',
  expired: `This link has expired. Open AgentLink again from your AI, or run ${CLI_COMMAND} approve in your own terminal.`,
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

/** The 401 page (11 §6.2.1 "local link expired"). Fixed text; nothing from the request. */
export const EXPIRED_HTML = fixedPage(PAGE_STRINGS.title, PAGE_STRINGS.expired);

/** `/` and `/approve/<id>` without the app bundle. Fixed text; nothing from the request. */
export const NO_APP_HTML = fixedPage(PAGE_STRINGS.noAppTitle, PAGE_STRINGS.noApp);
