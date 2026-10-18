// The RPC URL rule (04 §4 SSRF, 07 §6.1 keyless; M1-4a). Shipped RPC URLs and the user's own
// overrides (Advanced settings) both pass it before any request.
//
// The check runs on the raw string, before any URL parser, as for relay URLs (04 §4): a WHATWG
// parser maps percent-encoding, full-width dots and numeric host forms (`2130706433`, `0x7f.1`,
// `0177.0.0.1`) onto loopback or `localhost`. The host part is exactly the relay host rule of
// @4thtech-io/types: a lowercase DNS name of two or more labels, no numeric label (so no IP literal
// in any notation, and no bracketed IPv6), and never a local or special-use name. User info, a
// query, a fragment and `$` are refused too, because those are where an API key hides (07 §6.1).
//
// What this cannot see: where a public name resolves. An RPC URL comes from the shipped release or
// from the owner, never from inbound content, so it is not an attacker-chosen URL; resolving and
// pinning addresses (as `fetch_file` and relay sockets do) is left to the platform fetch. A refusal
// names a fixed reason code, never the URL.
import { isAllowedRelayHost } from '@4thtech-io/types';

/** Upper bound for an RPC URL; real endpoints are far shorter. */
export const MAX_RPC_URL_LENGTH = 2048;

/** Why an RPC URL was refused. Fixed codes: the URL never appears in a refusal. */
export type RpcUrlRefusal =
  | 'url_malformed'
  | 'scheme_not_https'
  | 'userinfo_present'
  | 'query_present'
  | 'fragment_present'
  | 'host_malformed'
  | 'host_denied'
  | 'port_malformed'
  | 'path_malformed';

export type RpcUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: RpcUrlRefusal };

/** Printable ASCII without `%` or `\` (so no percent-encoding, full-width form or whitespace). */
const CHARS = /^[\x21-\x24\x26-\x5b\x5d-\x7e]+$/;
const FORM = /^https:\/\/([^/:]*)(?::([^/]*))?(\/.*)?$/;
const HOST_CHARS = /^[a-z0-9.-]+$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const PATH = /^\/[A-Za-z0-9._~!&'()*+,;=:/-]*$/;

const refuse = (reason: RpcUrlRefusal): RpcUrlCheck => Object.freeze({ ok: false, reason });

/** Checks an RPC URL against the 04 §4 raw-string rule. */
export function checkRpcUrl(url: unknown): RpcUrlCheck {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_RPC_URL_LENGTH) {
    return refuse('url_malformed');
  }
  if (!CHARS.test(url)) return refuse('url_malformed');
  if (!url.startsWith('https://')) return refuse('scheme_not_https');
  if (url.includes('@')) return refuse('userinfo_present');
  if (url.includes('?')) return refuse('query_present');
  if (url.includes('#')) return refuse('fragment_present');
  const m = FORM.exec(url);
  if (m === null) return refuse('host_malformed');
  const [, host = '', port, path] = m;
  if (!HOST_CHARS.test(host)) return refuse('host_malformed');
  if (!isAllowedRelayHost(host)) return refuse('host_denied');
  if (port !== undefined && (!PORT.test(port) || Number(port) > 65535)) {
    return refuse('port_malformed');
  }
  if (path !== undefined && !PATH.test(path)) return refuse('path_malformed');
  return Object.freeze({ ok: true, url });
}
