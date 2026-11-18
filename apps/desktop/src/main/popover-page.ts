// TRAY-POPOVER (D-155): the popover's fixed local page, shown before the core is ready, after a core
// restart until the main window has a new session, and when the widget page could not load (the core
// is down). Built like status-page.ts: fixed text only (nothing from the core, the environment or a
// link), a `data:` URL, no script (CSP `default-src 'none'` plus inline styles), no network. Its one
// button is a plain link to a FIXED URL on the reserved `.invalid` host (RFC 6761); popover.ts
// intercepts it in `will-navigate` and acts only while this exact page is shown. The navigation
// itself stays blocked (security.ts lockWebContents).

/** Fixed text (11 §5 plain words). */
export const POPOVER_FALLBACK_COPY = Object.freeze({
  heading: 'Starting AgentLink…',
  body: "If this takes a while, open AgentLink to see what's happening.",
  button: 'Open AgentLink',
});

/** The one action URL (Open AgentLink). */
export const POPOVER_ACTION_URL = 'http://agentlink.invalid/open-agentlink';

/** The page's CSP: nothing may load or run; inline styles only. */
export const POPOVER_FALLBACK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'";

// Colours from project/design (D-116 tokens), as status-page.ts.
const STYLE = `
:root{color-scheme:dark light;--canvas:#0b0c0e;--fg:#f5f6f7;--muted:#a1a9b4;--border:#2a2f36;--accent:#ff6a1a;--on-accent:#0b0c0e}
@media (prefers-color-scheme: light){:root{--canvas:#ffffff;--fg:#0b0c0e;--muted:#4f5761;--border:#d3d7dc}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--canvas);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
h1{font-size:17px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 20px;color:var(--muted)}
a{display:inline-block;padding:9px 16px;border-radius:9px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`.trim();

/** The page's HTML (fixed text only; none of it needs escaping). */
export function popoverFallbackHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${POPOVER_FALLBACK_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<title>AgentLink</title>',
    `<style>${STYLE}</style>`,
    '</head><body><main role="status" aria-live="polite">',
    `<h1>${POPOVER_FALLBACK_COPY.heading}</h1>`,
    `<p>${POPOVER_FALLBACK_COPY.body.replace(/'/g, '&#39;')}</p>`,
    `<a href="${POPOVER_ACTION_URL}" autofocus>${POPOVER_FALLBACK_COPY.button}</a>`,
    '</main></body></html>',
  ].join('');
}

const URL_VALUE = `data:text/html;charset=utf-8;base64,${Buffer.from(popoverFallbackHtml(), 'utf8').toString('base64')}`;

/** The page's `data:` URL. */
export function popoverFallbackUrl(): string {
  return URL_VALUE;
}

/** True only for the exact fallback page. */
export function isPopoverFallbackUrl(url: string): boolean {
  return url === URL_VALUE;
}
