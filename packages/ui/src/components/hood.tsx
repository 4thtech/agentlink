// UI-REFRESH-e (S1): the Under the hood panel and the Appearance preview tile (B-11 §7; UX-V3 plan §3).
//
// The panel is read-only and accepts only typed, allowlisted fields. What it may show is decided here,
// in code, not by the caller: plain metadata (id, size, time, count, short text) and ONE link, the
// public proof record link on a public block explorer. Keys, codes, tokens, the session link and
// drop, upload, download and presigned URLs are refused before anything is rendered (I-5; zero
// access). A refused field is dropped without a trace: no error text, no log.
import { useContext, useId, useState, type ReactElement } from 'react';
import { Icon } from './brand.js';
import { HOOD_STRINGS, HoodContext } from './hood-core.js';

export { HOOD_STRINGS, HoodProvider, useHood } from './hood-core.js';

export type HoodTextKind = 'text' | 'id' | 'size' | 'time' | 'count' | 'path';

export type HoodField =
  | { readonly kind: HoodTextKind; readonly label: string; readonly value: string }
  | { readonly kind: 'proofLink'; readonly label?: string; readonly href: string };

const TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'id', 'size', 'time', 'count', 'path']);

/**
 * Public block explorers whose record pages may be linked: the exact hosts of the chain config's
 * `explorer` entries (packages/chain/src/config/testnets.ts; a test keeps them in step) plus the two
 * mainnet explorers. Exact match only: no subdomain or suffix matching.
 */
export const PROOF_LINK_HOSTS: readonly string[] = [
  'sepolia.basescan.org',
  'gnosis-chiado.blockscout.com',
  'basescan.org',
  'gnosisscan.io',
];
const PROOF_PATH = /^\/tx\/0x[0-9a-f]{64}$/;

/** Per-kind shapes: the specific kinds are an allowlist of formats, `text` falls back to the filters. */
const KIND_SHAPE: Partial<Record<HoodTextKind, RegExp>> = {
  id: /^[A-Za-z0-9._:-]{1,40}$/,
  size: /^\d[\d.,]*\s?(B|KB|MB|GB|bytes?)$/,
  count: /^\d{1,9}( of \d{1,9})?$/,
  time: /^[\d:.,+\-TZ ]{1,40}$/,
  // An absolute local path: POSIX `/…` (not `//`) or a drive `C:\…`. No query, fragment or control characters.
  path: /^(\/(?![/\\])|[A-Za-z]:[\\/])[^?#\0]*$/,
};

const LABEL_MAX = 40;
const VALUE_MAX = 120;
const PATH_MAX = 300;
const LINK_MAX = 300;

/** A label that names something secret or private is refused, whatever its value looks like. */
const FORBIDDEN_LABEL =
  /key|code|token|secret|passphrase|password|passkey|seed|session|link|url|presign|signature|upload|download|\bdrop\b|credential|cookie|authori[sz]/i;
const BLOB_RULE = /[A-Za-z0-9_\-+/=]{24,}/;
/** Values that look like a link, a scheme, a key or blob, a code, a token or a signed URL. */
const FORBIDDEN_VALUE: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /^\s*(javascript|data|blob|file|vbscript):/i,
  /\bwww\./i,
  BLOB_RULE,
  /\bbearer\s/i,
  /\b(tok|sk|pk|key)_[A-Za-z0-9]/i,
  /\beyJ[A-Za-z0-9_-]{6,}/,
  /\b[A-Z0-9]{4}(-[A-Z0-9]{4}){2,}\b/,
  /x-amz|signature=|token=|secret=|sig=/i,
  /(^|[\s-])[A-Za-z0-9]{4}([ -][A-Za-z0-9]{4}){2,}($|[\s-])/,
  /^\s*([a-z]+\s+){11,}[a-z]+\s*$/,
  /#s=|127\.0\.0\.1|localhost/i,
];

/**
 * Hosts of the encrypted drop and of object storage, refused anywhere in a value with or without a
 * scheme (zero access: a drop, upload, download or presigned link never shows).
 */
const STORAGE_HOST =
  /4thtech\.io|4th\.tech|workers\.dev|amazonaws\.com|cloudflarestorage\.com|\br2\.dev|storage\.googleapis\.com|blob\.core\.windows\.net/i;
/** A host with `drop` in its name, followed by a path. */
const DROP_HOST = /(^|[^a-z0-9.-])[a-z0-9-]*drop[a-z0-9-]*(\.[a-z0-9-]+)+[/\\]/i;
/** A scheme with a single slash, a backslash or none (`https:/x`, `https:\\x`, `https:x`). */
const LOOSE_SCHEME: readonly RegExp[] = [
  /(^|[^a-z0-9+.-])[a-z][a-z0-9+.-]+:[/\\]/i,
  /\b(https?|wss?|ftps?|file|s3|gs|blob|data|javascript|vbscript|agentlink):/i,
];
/** Any host name followed by a path (text, id, time, size, count only; a folder may contain dots). */
const SCHEMELESS_URL = /(^|[^a-z0-9.-])[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}[/\\]/i;
/** Look-alike slashes and colons that NFKC does not fold. */
const LOOKALIKE = /[\u2044\u2215\u29F8\u2236\uA789\u0589\u05C3\uFE13\uFE30\u02D0\u2CF9]/;
/** Control (C0, DEL, C1), format (bidi, zero-width, soft hyphen, BOM) and line/paragraph separators. */
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/**
 * A key cut into pieces: three or more chunks of four or more key characters, each mixing letters
 * and digits, joined by separators, adding up to 24 or more key characters.
 */
const CHUNK = /^[A-Za-z0-9_+=]{4,}$/;
const SEPARATORS = /[\s/\\.,:;|-]+/;
function splitBlob(value: string, separators: RegExp = SEPARATORS): boolean {
  let run = 0;
  let total = 0;
  for (const piece of value.split(separators)) {
    if (CHUNK.test(piece) && /\d/.test(piece) && /[A-Za-z]/.test(piece)) {
      run += 1;
      total += piece.length;
      if (run >= 3 && total >= 24) return true;
    } else {
      run = 0;
      total = 0;
    }
  }
  return false;
}

/**
 * The forms a value is checked in: as given, NFKC-folded (full-width and compatibility forms), and
 * percent-decoded until stable. `null` when decoding does not settle (fail closed).
 */
function variants(value: string): string[] | null {
  const out = [value];
  let cur = value.normalize('NFKC');
  out.push(cur);
  for (let i = 0; i < 4; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      // A `%` that is not an escape: decode only the well-formed escapes.
      next = cur.replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m;
        }
      });
    }
    next = next.normalize('NFKC');
    if (next === cur) return out;
    out.push(next);
    cur = next;
  }
  return null;
}

/** True when one form of the value matches a refused shape for its kind. */
function refusedForm(v: string, kind: HoodTextKind): boolean {
  if (HIDDEN_CHAR.test(v) || LOOKALIKE.test(v)) return true;
  if (STORAGE_HOST.test(v) || DROP_HOST.test(v)) return true;
  if (LOOSE_SCHEME.some((re) => re.test(v))) return true;
  if (kind !== 'id' && splitBlob(v)) return true;
  if (kind === 'path') {
    // Checked piece by piece: a key, code or token hiding in one folder name is refused.
    const segments = v.split(/[\\/]/);
    if (segments.some((seg) => seg === '..' || BLOB_RULE.test(seg))) return true;
    // Same filters as any value, except the long-blob rule, which is applied per segment above.
    return FORBIDDEN_VALUE.some((re) => re !== BLOB_RULE && re.test(v));
  }
  if (SCHEMELESS_URL.test(v)) return true;
  // An id is bounded by its own 40-character shape (KIND_SHAPE.id), so the 24-character run rule
  // does not apply: a message id is `env_` plus 22 characters. A bare run of 24 or more with no
  // short lower-case prefix is still refused, so a secret cannot pass as an id.
  // Its key-in-pieces check splits on dots and colons only: `-` and `_` belong to base64url and are
  // already inside the run rule.
  if (kind === 'id') {
    const rest = v.replace(/^[a-z]{2,8}_/, '');
    if (BLOB_RULE.test(rest) || splitBlob(rest, /[.:]+/)) return true;
    return FORBIDDEN_VALUE.some((re) => re !== BLOB_RULE && re.test(v));
  }
  return FORBIDDEN_VALUE.some((re) => re.test(v));
}

function valueAllowed(value: string, kind: HoodTextKind): boolean {
  const forms = variants(value);
  return forms !== null && !forms.some((v) => refusedForm(v, kind));
}

function labelAllowed(label: string): boolean {
  const forms = variants(label);
  return (
    forms !== null &&
    !forms.some((l) => HIDDEN_CHAR.test(l) || LOOKALIKE.test(l) || FORBIDDEN_LABEL.test(l))
  );
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function safeText(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.trim() !== '' && s.length <= max && !HIDDEN_CHAR.test(s);
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return PROOF_LINK_HOSTS.includes(h);
}

function acceptProofHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > LINK_MAX || HIDDEN_CHAR.test(href)) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '')
    return null;
  if (u.search !== '' || u.hash !== '' || !hostAllowed(u.hostname)) return null;
  if (!PROOF_PATH.test(u.pathname)) return null;
  return u.href;
}

/**
 * The allowlist, in one place. Returns a clean copy of the field (only its known properties) or
 * `null` when it must not be shown.
 */
export function acceptHoodField(input: unknown): HoodField | null {
  if (!isRecord(input)) return null;
  const kind = input['kind'];
  if (kind === 'proofLink') {
    const href = acceptProofHref(input['href']);
    return href === null ? null : { kind: 'proofLink', href };
  }
  if (typeof kind !== 'string' || !TEXT_KINDS.has(kind)) return null;
  const label = input['label'];
  const value = input['value'];
  if (!safeText(label, LABEL_MAX) || !safeText(value, kind === 'path' ? PATH_MAX : VALUE_MAX))
    return null;
  if (!labelAllowed(label)) return null;
  const shape = KIND_SHAPE[kind as HoodTextKind];
  if (shape !== undefined && !shape.test(value)) return null;
  if (!valueAllowed(value, kind as HoodTextKind)) return null;
  return { kind: kind as HoodTextKind, label, value };
}

export interface UnderTheHoodProps {
  /** Untyped on purpose at the boundary: every field goes through `acceptHoodField`. */
  fields: readonly unknown[];
}

/** The marked, collapsible technical panel of a page. Renders nothing while the switch is off. */
export function UnderTheHood({ fields }: UnderTheHoodProps): ReactElement | null {
  const on = useContext(HoodContext);
  const [open, setOpen] = useState(true);
  const id = useId();
  if (!on) return null;
  const accepted = fields.map(acceptHoodField).filter((f): f is HoodField => f !== null);
  return (
    <section className="al-hood" aria-label={HOOD_STRINGS.title}>
      <button
        type="button"
        className="al-hood-head al-text-label"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={`${id}-body`}
        title={open ? HOOD_STRINGS.hide : HOOD_STRINGS.show}
        onClick={() => setOpen(!open)}
      >
        <Icon name="terminal" size={14} />
        <span>{HOOD_STRINGS.title}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="al-hood-chev" />
      </button>
      {open ? (
        <div className="al-hood-body" id={`${id}-body`}>
          {accepted.length === 0 ? (
            <p className="al-hood-empty">{HOOD_STRINGS.empty}</p>
          ) : (
            <dl className="al-hood-list">
              {accepted.map((f, i) =>
                f.kind === 'proofLink' ? (
                  <div className="al-hood-row" key={i}>
                    <dd>
                      <a href={f.href} target="_blank" rel="noopener noreferrer">
                        {HOOD_STRINGS.proofLink}
                      </a>
                    </dd>
                  </div>
                ) : (
                  <div className="al-hood-row" key={i}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ),
              )}
            </dl>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Appearance: a small tile that glides when asked, so a motion setting can be felt at once. */
export function PreviewTile(): ReactElement {
  const [moved, setMoved] = useState(false);
  return (
    <div className={`al-preview-tile${moved ? ' is-moved' : ''}`}>
      <p className="al-text-label">{HOOD_STRINGS.previewTitle}</p>
      <div className="al-preview-track" aria-hidden="true">
        <span className="al-preview-chip" />
      </div>
      <button
        type="button"
        className="al-btn al-btn-secondary al-btn-sm"
        onClick={() => setMoved(!moved)}
      >
        {HOOD_STRINGS.previewTry}
      </button>
      <p className="al-text-caption al-muted" aria-live="polite">
        {moved ? HOOD_STRINGS.previewMoved : HOOD_STRINGS.previewStill}
      </p>
    </div>
  );
}
