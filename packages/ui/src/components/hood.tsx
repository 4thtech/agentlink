// UI-REFRESH-e (S1): the Under the hood panel and the Appearance preview tile (B-11 §7; UX-V3 plan §3).
//
// The panel is read-only and accepts only typed, allowlisted fields. What it may show is decided here,
// in code, not by the caller: plain metadata (id, size, time, count, short text) and ONE link, the
// public proof record link on a public block explorer. Keys, codes, tokens, the session link and
// drop, upload, download and presigned URLs are refused before anything is rendered (I-5; zero
// access). A refused field is dropped without a trace: no error text, no log.
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from './brand.js';

export const HOOD_STRINGS = {
  title: 'Under the hood',
  tooltip: 'Show the technical details. Nothing here changes how the app works.',
  empty: 'Nothing technical to show here yet.',
  hide: 'Hide technical details',
  show: 'Show technical details',
  proofLink: 'Open the public record',
  previewTitle: 'Preview',
  previewTry: 'Try it',
  previewStill: 'The sample sits still.',
  previewMoved: 'The sample has moved. With reduced motion it jumps instead of gliding.',
} as const;

export type HoodTextKind = 'text' | 'id' | 'size' | 'time' | 'count';

export type HoodField =
  | { readonly kind: HoodTextKind; readonly label: string; readonly value: string }
  | { readonly kind: 'proofLink'; readonly label?: string; readonly href: string };

const TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'id', 'size', 'time', 'count']);

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
};

const LABEL_MAX = 40;
const VALUE_MAX = 120;
const LINK_MAX = 300;

/** A label that names something secret or private is refused, whatever its value looks like. */
const FORBIDDEN_LABEL =
  /key|code|token|secret|passphrase|password|passkey|seed|session|link|url|presign|signature|upload|download|\bdrop\b|credential|cookie|authori[sz]/i;
/** Values that look like a link, a scheme, a key or blob, a code, a token or a signed URL. */
const FORBIDDEN_VALUE: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /^\s*(javascript|data|blob|file|vbscript):/i,
  /\bwww\./i,
  /[A-Za-z0-9_\-+/=]{24,}/,
  /\bbearer\s/i,
  /\b(tok|sk|pk|key)_[A-Za-z0-9]/i,
  /\beyJ[A-Za-z0-9_-]{6,}/,
  /\b[A-Z0-9]{4}(-[A-Z0-9]{4}){2,}\b/,
  /x-amz|signature=|token=|secret=|sig=/i,
  /(^|[\s-])[A-Za-z0-9]{4}([ -][A-Za-z0-9]{4}){2,}($|[\s-])/,
  /^\s*([a-z]+\s+){11,}[a-z]+\s*$/,
  /#s=|127\.0\.0\.1|localhost/i,
];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function safeText(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.trim() === '' || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 32) return false;
  return true;
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return PROOF_LINK_HOSTS.includes(h);
}

function acceptProofHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > LINK_MAX) return null;
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
  if (!safeText(label, LABEL_MAX) || !safeText(value, VALUE_MAX)) return null;
  if (FORBIDDEN_LABEL.test(label)) return null;
  const shape = KIND_SHAPE[kind as HoodTextKind];
  if (shape !== undefined && !shape.test(value)) return null;
  if (FORBIDDEN_VALUE.some((re) => re.test(value))) return null;
  return { kind: kind as HoodTextKind, label, value };
}

const HoodContext = createContext(false);

/** The global switch's value, handed down by the app. Off outside a provider. */
export function HoodProvider({
  value,
  children,
}: {
  value: boolean;
  children?: ReactNode;
}): ReactElement {
  return <HoodContext.Provider value={value}>{children}</HoodContext.Provider>;
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
