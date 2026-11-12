// The window's local status page (desktop start UX, 2026-11-12). The window shows it at once on
// launch ("Starting AgentLink…") and whenever the core could not start, so the person never faces an
// app with a menu bar and nothing else.
//
// - It is static and bundled: the HTML is built here, in the shell's own code (inside app.asar),
//   from FIXED text per status kind. Nothing from the core, its stderr, the environment or a
//   deep link is ever inserted. It loads as a `data:` URL: no file access, no network, no protocol
//   handler, no preload, no IPC.
// - No script at all. Its CSP is `default-src 'none'` plus inline styles; there is nothing to fetch.
// - The two buttons are plain links to FIXED URLs on the reserved `.invalid` host (RFC 6761: never
//   resolves). The main process intercepts them in `will-navigate` (window.ts) and acts only when the
//   window is showing one of these exact pages; every navigation stays blocked (security.ts). The
//   session page can never reach them: it cannot navigate to `data:` (blocked by Chromium and the
//   origin lock) and its navigations to the action URLs are refused because it is not a status page.
// - It does not touch the origin lock: only the core's first valid `ready` sets it.
import { START_FAILURE_REASONS, type StartFailureReason } from '../shared/protocol.js';
import { START_FAILURE_TEXT } from './start-failure.js';

/** What the status page can say. */
export const STATUS_KINDS = [
  'starting',
  ...START_FAILURE_REASONS,
  'port',
  'retries',
  'exited',
  'ai_app',
  'missing_files',
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

/** The kinds that mean "the core is not running": they show Try again and Open log folder. */
export type FailureKind = Exclude<StatusKind, 'starting'>;

export interface StatusCopy {
  readonly heading: string;
  readonly body: string;
}

const COULD_NOT_START = "AgentLink couldn't start";
const TRY_AGAIN_HINT = 'Choose Try again when you are ready.';
const LOG_HINT =
  "If it keeps happening, choose Open log folder and share the file core.log with the person helping you. It doesn't contain your messages or passwords.";

const startFailureCopy = (reason: StartFailureReason): StatusCopy => ({
  heading: COULD_NOT_START,
  body: `${START_FAILURE_TEXT[reason]} Run \`agentlink doctor\` in your own terminal to see why. ${TRY_AGAIN_HINT}`,
});

/** Fixed text (11 §5 plain words). */
export const STATUS_COPY: Readonly<Record<StatusKind, StatusCopy>> = Object.freeze({
  starting: { heading: 'Starting AgentLink…', body: 'This takes a few seconds.' },
  no_owner: startFailureCopy('no_owner'),
  no_ids: startFailureCopy('no_ids'),
  only_removing: startFailureCopy('only_removing'),
  keychain: startFailureCopy('keychain'),
  open: startFailureCopy('open'),
  port: {
    heading: COULD_NOT_START,
    body: `Another program on this computer is using the address AgentLink needs. Close it or restart your computer. ${TRY_AGAIN_HINT}`,
  },
  retries: {
    heading: 'AgentLink stopped',
    body: `AgentLink stopped several times in a row, so it won't start again on its own. ${TRY_AGAIN_HINT} ${LOG_HINT}`,
  },
  exited: {
    heading: COULD_NOT_START,
    body: `AgentLink stopped before it was ready, several times in a row. ${TRY_AGAIN_HINT} ${LOG_HINT}`,
  },
  ai_app: {
    heading: 'Open AgentLink yourself',
    body: 'AgentLink was started by an AI app. To keep you in control, it only opens when you start it yourself. Quit AgentLink, then open it from your Applications folder or the Start menu.',
  },
  missing_files: {
    heading: 'Some of AgentLink is missing',
    body: "Parts of the AgentLink app are missing, so it couldn't start. Install AgentLink again from agentlink.4thtech.io, then open it.",
  },
});

/** The two fixed action URLs (reserved `.invalid` host; the main process intercepts them). */
export const STATUS_ACTION_URLS = Object.freeze({
  'try-again': 'http://agentlink.invalid/try-again',
  'open-log-folder': 'http://agentlink.invalid/open-log-folder',
} as const);
export type StatusAction = keyof typeof STATUS_ACTION_URLS;

/** The action for an exact action URL, else null. */
export function statusAction(url: string): StatusAction | null {
  for (const [action, fixed] of Object.entries(STATUS_ACTION_URLS)) {
    if (url === fixed) return action as StatusAction;
  }
  return null;
}

/** The page's CSP: nothing may load or run; inline styles only. */
export const STATUS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'";

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inline code in the fixed copy (`agentlink doctor`) → <code>. */
const withCode = (escaped: string): string => escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

// Colours from docs/design (D-116 tokens: canvas, surface, border, fg, muted, brand seal).
const STYLE = `
:root{color-scheme:dark light;--canvas:#0b0c0e;--surface:#111316;--border:#2a2f36;--fg:#f5f6f7;--muted:#a1a9b4;--accent:#ff6a1a;--on-accent:#0b0c0e}
@media (prefers-color-scheme: light){:root{--canvas:#f5f6f7;--surface:#ffffff;--border:#d3d7dc;--fg:#0b0c0e;--muted:#4f5761}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--canvas);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:24px}
main{max-width:520px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:32px}
h1{font-size:20px;line-height:1.3;margin:0 0 8px}
p{margin:0;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--fg)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
a{display:inline-block;padding:9px 16px;border-radius:9px;border:1px solid var(--border);color:var(--fg);text-decoration:none;font-weight:600}
a.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.spinner{width:28px;height:28px;margin:0 0 20px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.spinner{animation:none}}
`.trim();

/** The page's HTML for `kind` (fixed text only). */
export function statusPageHtml(kind: StatusKind): string {
  const copy = STATUS_COPY[kind];
  const actions =
    kind === 'starting'
      ? '<div class="spinner" role="progressbar" aria-label="Starting"></div>'
      : '';
  const buttons =
    kind === 'starting'
      ? ''
      : `<div class="actions"><a class="primary" href="${STATUS_ACTION_URLS['try-again']}">Try again</a><a href="${STATUS_ACTION_URLS['open-log-folder']}">Open log folder</a></div>`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${STATUS_PAGE_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<title>AgentLink</title>',
    `<style>${STYLE}</style>`,
    '</head><body><main role="status" aria-live="polite">',
    actions,
    `<h1>${escapeHtml(copy.heading)}</h1>`,
    `<p>${withCode(escapeHtml(copy.body))}</p>`,
    buttons,
    '</main></body></html>',
  ].join('');
}

const PREFIX = 'data:text/html;charset=utf-8;base64,';

const PAGE_URLS: ReadonlyMap<StatusKind, string> = new Map(
  STATUS_KINDS.map((kind) => [
    kind,
    `${PREFIX}${Buffer.from(statusPageHtml(kind), 'utf8').toString('base64')}`,
  ]),
);
const PAGE_URL_SET: ReadonlySet<string> = new Set(PAGE_URLS.values());

/** The `data:` URL of the page for `kind`. */
export function statusPageUrl(kind: StatusKind): string {
  return PAGE_URLS.get(kind) as string;
}

/** True only for one of the fixed status pages (exact match). */
export function isStatusPageUrl(url: string): boolean {
  return PAGE_URL_SET.has(url);
}
