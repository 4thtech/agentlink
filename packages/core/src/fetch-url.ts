// M1-15: the pure half of the download SSRF rules (04 §4 "SSRF protection (`fetch_file`)", §7).
// A download URL arrives inside an envelope from another party (an S3 presigned GET, a signed drop
// URL, a provider share link), so it is untrusted (I-5). This module decides, on the raw string and
// before any URL parser runs, whether the URL may be fetched at all, and which resolved addresses
// may be dialled. The DNS lookup and the pinned connection are the platform's job
// (`@agentlink/node` safe-fetch); in Workers (G-14, proposed) the same raw check applies and the
// address half relies on Workers egress, because Workers cannot resolve DNS.
//
// Why the raw string: a WHATWG parser maps percent-encoding, full-width digits, U+3002 and numeric
// host forms (`2130706433`, `0x7f.1`, `0177.0.0.1`) onto `127.0.0.1` or `localhost`. Checking the
// parser's output would follow the parser's rules; checking the raw string refuses all of them.
//
// Pure code, no I/O, no Node built-in. Nothing here echoes the URL into an error: a download URL is
// a secret (I-7), so a refusal carries only a fixed reason code.
import { isGloballyRoutable } from '@agentlink/transport-nostr';

/** Redirects followed per download, each re-checked (04 §4). A third redirect fails. */
export const MAX_FETCH_REDIRECTS = 2;
/** Upper bound for a download URL; a presigned S3 GET is well under 2 KB. */
export const MAX_FETCH_URL_LENGTH = 4096;

/** Why a URL or address was refused. Fixed codes: the URL itself never appears in an error. */
export type FetchUrlRefusal =
  /** Not a string, too long, or a character outside printable ASCII (including whitespace). */
  | 'url_malformed'
  /** The scheme is not `https://` (lower case). */
  | 'scheme_not_https'
  /** User info (`user@host`) is present. */
  | 'userinfo_present'
  /** A fragment (`#…`) is present. */
  | 'fragment_present'
  /** The host is not a valid DNS name or bracketed IPv6 literal. */
  | 'host_malformed'
  /** The host is a local or internal name (`localhost`, `.local`, `.internal`, …). */
  | 'host_denied'
  /** The host is an IP literal (any notation) that is not globally routable, or an odd notation. */
  | 'address_not_public'
  /** The port is not 1–65535 written without a leading zero. */
  | 'port_malformed'
  /** The path or query has a character outside the allowed set. */
  | 'path_malformed';

/** A URL that passed the raw check. `host` is lower case, without brackets. */
export interface CheckedFetchUrl {
  /** The exact string that was checked (the request is made for this URL and nothing else). */
  readonly url: string;
  /** Host name in lower case, or the IP literal without brackets. */
  readonly host: string;
  /** The IP literal, when the host is one (already checked as globally routable). */
  readonly literal?: string;
  readonly port: number;
  /** Path and query, starting with `/` (`/` when the URL has none). */
  readonly pathAndQuery: string;
}

export type FetchUrlCheck =
  | { readonly ok: true; readonly value: CheckedFetchUrl }
  | { readonly ok: false; readonly reason: FetchUrlRefusal };

const DENIED_SUFFIXES = ['.localhost', '.localdomain', '.local', '.internal', '.home.arpa'];
const DENIED_NAMES = new Set(['localhost', 'localhost.localdomain']);
/** RFC 3986 path and query characters, plus `%` for percent-encoding (presigned queries use it). */
const PATH_AND_QUERY = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/;
const PERCENT_TRIPLETS = /%(?![0-9A-Fa-f]{2})/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LAST_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** A label a WHATWG parser would read as a number in some base: decimal, octal or `0x` hex. */
const NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/;
const STRICT_DOTTED_QUAD = /^(?:(?:0|[1-9][0-9]{0,2})\.){3}(?:0|[1-9][0-9]{0,2})$/;

function refuse(reason: FetchUrlRefusal): FetchUrlCheck {
  return { ok: false, reason };
}

/** Checks a host name (not a bracketed literal); returns the IPv4 literal if it is one. */
function checkHostName(host: string): FetchUrlCheck | { literal?: string } {
  if (host.length === 0 || host.length > 253) return refuse('host_malformed');
  if (host.endsWith('.')) return refuse('host_malformed'); // a trailing dot dodges suffix lists
  const labels = host.split('.');
  const last = labels[labels.length - 1] as string;
  // A numeric last label makes a WHATWG parser read the whole host as IPv4, whatever its notation
  // (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`). Only a strict dotted quad that is globally
  // routable is accepted; every other numeric notation is refused outright.
  if (NUMERIC_LABEL.test(last)) {
    if (!STRICT_DOTTED_QUAD.test(host)) return refuse('address_not_public');
    if (!isGloballyRoutable(host)) return refuse('address_not_public');
    return { literal: host };
  }
  if (labels.length < 2) return refuse('host_malformed');
  for (const label of labels) {
    if (!LABEL.test(label)) return refuse('host_malformed');
  }
  if (!LAST_LABEL.test(last)) return refuse('host_malformed');
  if (DENIED_NAMES.has(host) || DENIED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return refuse('host_denied');
  }
  return {};
}

/**
 * The raw-string check of a download URL (04 §4): `https://` + host [":" port] [path [? query]],
 * printable ASCII only, no user info, no fragment. The host is a DNS name of two or more labels
 * (lower case after ASCII case folding, no local or internal suffix, no trailing dot), a strict
 * dotted-quad IPv4 or a bracketed IPv6 literal; an IP literal must be globally routable (07 §4.2),
 * so loopback, private, link-local (including `169.254.169.254`), unique-local, CGNAT, multicast,
 * unspecified, IPv4-mapped and NAT64 forms are refused. Percent-encoding is allowed only in the
 * path and query, never in the host.
 */
export function checkFetchUrl(raw: unknown): FetchUrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FETCH_URL_LENGTH) {
    return refuse('url_malformed');
  }
  // Printable ASCII only: no whitespace, no control character, no non-ASCII (full-width dots and
  // digits, U+3002, bidi controls), no backslash (which some parsers read as `/`).
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\')) return refuse('url_malformed');
  if (!raw.startsWith('https://')) return refuse('scheme_not_https');
  if (raw.includes('#')) return refuse('fragment_present');
  const rest = raw.slice('https://'.length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  let pathAndQuery = authorityEnd === -1 ? '/' : rest.slice(authorityEnd);
  if (authority.includes('@')) return refuse('userinfo_present');
  if (authority.includes('%')) return refuse('host_malformed');

  let hostPart: string;
  let portPart: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return refuse('host_malformed');
    hostPart = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) return refuse('host_malformed');
      portPart = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    hostPart = colon === -1 ? authority : authority.slice(0, colon);
    portPart = colon === -1 ? undefined : authority.slice(colon + 1);
  }

  let port = 443;
  if (portPart !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(portPart)) return refuse('port_malformed');
    port = Number(portPart);
    if (port > 65_535) return refuse('port_malformed');
  }

  let host: string;
  let literal: string | undefined;
  if (authority.startsWith('[')) {
    // A bracketed IPv6 literal: hex, colons and an optional dotted tail only; no zone id.
    host = hostPart.toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(host) || !host.includes(':')) return refuse('host_malformed');
    if (!isGloballyRoutable(host)) return refuse('address_not_public');
    literal = host;
  } else {
    host = hostPart.toLowerCase();
    const checked = checkHostName(host);
    if ('ok' in checked) return checked;
    literal = checked.literal;
  }

  if (pathAndQuery.startsWith('?')) pathAndQuery = `/${pathAndQuery}`;
  if (!PATH_AND_QUERY.test(pathAndQuery) || PERCENT_TRIPLETS.test(pathAndQuery)) {
    return refuse('path_malformed');
  }
  return {
    ok: true,
    value: { url: raw, host, port, pathAndQuery, ...(literal === undefined ? {} : { literal }) },
  };
}

/**
 * The address half (04 §4, 07 §4.2): a resolved host may be dialled only if it has at least one
 * answer and EVERY answer is a plain, globally routable IP address. One private answer refuses the
 * whole host, so a resolver that mixes public and private records cannot steer the connection.
 * Returns the address to connect to (the first answer), or undefined.
 */
export function pickPublicAddress(addresses: readonly unknown[]): string | undefined {
  if (!Array.isArray(addresses) || addresses.length === 0) return undefined;
  for (const address of addresses) {
    if (typeof address !== 'string' || !isGloballyRoutable(address)) return undefined;
  }
  return addresses[0] as string;
}

/**
 * Resolves a redirect `Location` against the URL that answered it, as a raw string, so the result
 * goes through checkFetchUrl like the first URL. Accepts an absolute `https://` URL or an
 * origin-relative path (`/…`, not `//…`); anything else (another scheme, a scheme-relative or a
 * dot-relative reference) is refused. Returns undefined when refused.
 */
export function resolveRedirect(current: CheckedFetchUrl, location: unknown): string | undefined {
  if (typeof location !== 'string' || location.length === 0) return undefined;
  if (location.startsWith('https://')) return location;
  if (location.startsWith('/') && !location.startsWith('//')) {
    // The scheme and authority of the answering URL, exactly as checked.
    const authorityEnd = current.url.slice('https://'.length).search(/[/?]/);
    const base =
      authorityEnd === -1 ? current.url : current.url.slice(0, 'https://'.length + authorityEnd);
    return `${base}${location}`;
  }
  return undefined;
}
