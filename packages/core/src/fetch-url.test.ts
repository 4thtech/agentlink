// M1-15: table tests for the raw download-URL check (04 §4 "SSRF protection (`fetch_file`)").
import { describe, expect, it } from 'vitest';
import {
  MAX_FETCH_REDIRECTS,
  checkFetchUrl,
  pickPublicAddress,
  resolveRedirect,
  type FetchUrlRefusal,
} from './fetch-url.js';

const cp = (n: number): string => String.fromCodePoint(n);

describe('checkFetchUrl: refused URLs (04 §4)', () => {
  const refused: [string, unknown, FetchUrlRefusal][] = [
    // scheme
    ['http', 'http://files.example.com/x', 'scheme_not_https'],
    ['upper-case scheme', 'HTTPS://files.example.com/x', 'scheme_not_https'],
    ['ftp', 'ftp://files.example.com/x', 'scheme_not_https'],
    ['file', 'file:///etc/passwd', 'scheme_not_https'],
    ['scheme-relative', '//files.example.com/x', 'scheme_not_https'],
    ['data', 'data:text/plain,hi', 'scheme_not_https'],
    // loopback in every notation
    ['IPv4 loopback', 'https://127.0.0.1/x', 'address_not_public'],
    ['IPv4 loopback with port', 'https://127.0.0.1:8443/x', 'address_not_public'],
    ['decimal IPv4', 'https://2130706433/x', 'address_not_public'],
    ['octal IPv4', 'https://0177.0.0.1/x', 'address_not_public'],
    ['hex IPv4', 'https://0x7f.0.0.1/x', 'address_not_public'],
    ['hex whole', 'https://0x7f000001/x', 'address_not_public'],
    ['short IPv4', 'https://127.1/x', 'address_not_public'],
    ['leading-zero public quad', 'https://010.8.8.8/x', 'address_not_public'],
    ['bare 0x', 'https://a.0x/x', 'address_not_public'],
    ['IPv6 loopback', 'https://[::1]/x', 'address_not_public'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/x', 'address_not_public'],
    ['IPv4-mapped IPv6 hex', 'https://[::ffff:7f00:1]/x', 'address_not_public'],
    ['IPv4-compatible IPv6', 'https://[::127.0.0.1]/x', 'address_not_public'],
    ['NAT64', 'https://[64:ff9b::7f00:1]/x', 'address_not_public'],
    ['6to4', 'https://[2002:7f00:1::1]/x', 'address_not_public'],
    ['unspecified IPv4', 'https://0.0.0.0/x', 'address_not_public'],
    ['unspecified IPv6', 'https://[::]/x', 'address_not_public'],
    // private, link-local, unique-local, CGNAT, multicast
    ['10/8', 'https://10.1.2.3/x', 'address_not_public'],
    ['172.16/12', 'https://172.20.0.1/x', 'address_not_public'],
    ['192.168/16', 'https://192.168.1.1/x', 'address_not_public'],
    ['metadata', 'https://169.254.169.254/latest/meta-data/', 'address_not_public'],
    ['CGNAT', 'https://100.64.0.1/x', 'address_not_public'],
    ['multicast v4', 'https://224.0.0.1/x', 'address_not_public'],
    ['broadcast', 'https://255.255.255.255/x', 'address_not_public'],
    ['link-local v6', 'https://[fe80::1]/x', 'address_not_public'],
    ['unique-local v6', 'https://[fd00::1]/x', 'address_not_public'],
    ['multicast v6', 'https://[ff02::1]/x', 'address_not_public'],
    // zone ids and odd literals
    ['IPv6 zone id', 'https://[fe80::1%25en0]/x', 'host_malformed'],
    ['unclosed bracket', 'https://[2606:4700::1/x', 'host_malformed'],
    ['bracketed IPv4', 'https://[1.1.1.1]/x', 'host_malformed'],
    // names
    ['localhost', 'https://localhost/x', 'host_malformed'],
    ['localhost subdomain', 'https://evil.localhost/x', 'host_denied'],
    ['.local', 'https://printer.local/x', 'host_denied'],
    ['.internal metadata', 'https://metadata.google.internal/x', 'host_denied'],
    ['.home.arpa', 'https://nas.home.arpa/x', 'host_denied'],
    ['.localdomain', 'https://box.localdomain/x', 'host_denied'],
    ['trailing dot', 'https://files.example.com./x', 'host_malformed'],
    ['trailing dot on localhost', 'https://localhost./x', 'host_malformed'],
    ['single label', 'https://intranet/x', 'host_malformed'],
    ['underscore', 'https://a_b.example.com/x', 'host_malformed'],
    ['empty host', 'https:///x', 'host_malformed'],
    ['percent in host', 'https://%31%32%37.0.0.1/x', 'host_malformed'],
    ['percent localhost', 'https://loc%61lhost/x', 'host_malformed'],
    // user info, fragments, ports
    ['userinfo', 'https://user@files.example.com/x', 'userinfo_present'],
    ['userinfo trick', 'https://files.example.com@127.0.0.1/x', 'userinfo_present'],
    ['fragment', 'https://files.example.com/x#y', 'fragment_present'],
    ['port zero', 'https://files.example.com:0/x', 'port_malformed'],
    ['port leading zero', 'https://files.example.com:0443/x', 'port_malformed'],
    ['port too big', 'https://files.example.com:65536/x', 'port_malformed'],
    ['empty port', 'https://files.example.com:/x', 'port_malformed'],
    // characters
    ['backslash', 'https://files.example.com\\@127.0.0.1/x', 'url_malformed'],
    ['space', 'https://files.example.com/a b', 'url_malformed'],
    ['tab', 'https://files.exam\tple.com/x', 'url_malformed'],
    ['newline', 'https://files.example.com/x\r\nHost: evil', 'url_malformed'],
    ['full-width dot', `https://127${cp(0xff0e)}0${cp(0xff0e)}0${cp(0xff0e)}1/x`, 'url_malformed'],
    ['ideographic dot', `https://localhost${cp(0x3002)}/x`, 'url_malformed'],
    [
      'full-width digits',
      `https://${cp(0xff11)}${cp(0xff12)}${cp(0xff17)}.0.0.1/x`,
      'url_malformed',
    ],
    ['bidi control', `https://files.example.com/${cp(0x202e)}x`, 'url_malformed'],
    ['unicode host', `https://b${cp(0xfc)}cher.example/x`, 'url_malformed'],
    ['bad percent triplet', 'https://files.example.com/a%zz', 'path_malformed'],
    ['angle bracket in path', 'https://files.example.com/<x>', 'path_malformed'],
    ['not a string', 42, 'url_malformed'],
    ['empty', '', 'url_malformed'],
    ['too long', `https://files.example.com/${'a'.repeat(5000)}`, 'url_malformed'],
  ];

  it.each(refused)('%s', (_name, url, reason) => {
    expect(checkFetchUrl(url)).toEqual({ ok: false, reason });
  });
});

describe('checkFetchUrl: accepted URLs', () => {
  it('accepts a presigned S3 GET with a percent-encoded query', () => {
    const url =
      'https://bucket.s3.eu-central-1.amazonaws.com/obj?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261017%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Expires=604800&X-Amz-Signature=abc123';
    const result = checkFetchUrl(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe(url);
    expect(result.value.host).toBe('bucket.s3.eu-central-1.amazonaws.com');
    expect(result.value.port).toBe(443);
    expect(result.value.literal).toBeUndefined();
  });

  it('lower-cases the host, keeps the port and supplies a root path', () => {
    const result = checkFetchUrl('https://Drop.AgentLink.example:8443');
    expect(result).toEqual({
      ok: true,
      value: {
        url: 'https://Drop.AgentLink.example:8443',
        host: 'drop.agentlink.example',
        port: 8443,
        pathAndQuery: '/',
      },
    });
  });

  it('accepts a bare query', () => {
    const result = checkFetchUrl('https://files.example.com?x=1');
    expect(result.ok && result.value.pathAndQuery).toBe('/?x=1');
  });

  it('accepts public IP literals and reports them', () => {
    const v4 = checkFetchUrl('https://8.8.8.8/x');
    expect(v4.ok && v4.value.literal).toBe('8.8.8.8');
    const v6 = checkFetchUrl('https://[2606:4700:4700::1111]:444/x');
    expect(v6.ok && v6.value).toMatchObject({ literal: '2606:4700:4700::1111', port: 444 });
  });

  it('accepts a punycode last label', () => {
    expect(checkFetchUrl('https://files.xn--p1ai/x').ok).toBe(true);
  });
});

describe('pickPublicAddress (every answer must be public)', () => {
  it('returns the first answer when every answer is public', () => {
    expect(pickPublicAddress(['93.184.216.34', '2606:2800:220:1::1'])).toBe('93.184.216.34');
  });

  it.each([
    [['10.0.0.5']],
    [['93.184.216.34', '127.0.0.1']],
    [['169.254.169.254']],
    [['::ffff:10.0.0.1']],
    [['fe80::1%en0']],
    [['fd12::1']],
    [['100.100.100.100']],
    [['localhost']],
    [[]],
    [[42]],
  ])('refuses %j', (answers) => {
    expect(pickPublicAddress(answers as unknown[])).toBeUndefined();
  });
});

describe('resolveRedirect', () => {
  const base = (url: string) => {
    const r = checkFetchUrl(url);
    if (!r.ok) throw new Error('fixture');
    return r.value;
  };

  it('keeps absolute https locations verbatim (they are re-checked by the caller)', () => {
    const next = resolveRedirect(base('https://a.example.com/x'), 'https://169.254.169.254/');
    expect(next).toBe('https://169.254.169.254/');
    expect(checkFetchUrl(next).ok).toBe(false);
  });

  it('joins an origin-relative path to the answering origin', () => {
    expect(resolveRedirect(base('https://a.example.com:8443/x?y=1'), '/z?q=2')).toBe(
      'https://a.example.com:8443/z?q=2',
    );
    expect(resolveRedirect(base('https://a.example.com'), '/z')).toBe('https://a.example.com/z');
    expect(resolveRedirect(base('https://a.example.com?k=v'), '/z')).toBe(
      'https://a.example.com/z',
    );
  });

  it.each(['http://a.example.com/', '//127.0.0.1/', 'z', '../z', '', 'javascript:alert(1)'])(
    'refuses %j',
    (location) => {
      expect(resolveRedirect(base('https://a.example.com/x'), location)).toBeUndefined();
    },
  );

  it('caps redirects at two (04 §4)', () => {
    expect(MAX_FETCH_REDIRECTS).toBe(2);
  });
});
