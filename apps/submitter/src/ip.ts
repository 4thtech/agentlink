// The per-IP rate-limit bucket of the submitter (07 §7; the same rule as the encrypted drop's,
// apps/drop/src/ip.ts, M1-27a): IPv4 per address, IPv6 per /64, so one host cannot escape the per-IP
// limits by rotating through its own /64. The bucket text is never stored or logged as is: the
// Worker keys its rate counters by an HMAC of it (worker.ts).

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** Eight hextets of an IPv6 address, or null. Handles `::` and a trailing dotted IPv4 part. */
function ipv6Hextets(text: string): number[] | null {
  let address = text.toLowerCase();
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(':');
  const last = address.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!IPV4.test(last)) return null;
    const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    address = `${address.slice(0, lastColon + 1)}`;
    if (address.endsWith('::')) {
      // `::1.2.3.4`: keep the double colon as is.
    } else if (address.endsWith(':')) {
      address = address.slice(0, -1);
    }
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!HEXTET.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  }
  if (known !== 8) return null;
  return [...head, ...tail];
}

/**
 * The rate-limit bucket for a client address (`CF-Connecting-IP`): the IPv4 address itself, or the
 * IPv6 /64 prefix as four zero-padded hextets plus `::/64`. An IPv4-mapped IPv6 address counts as
 * its IPv4 address. A missing or malformed address goes to the shared bucket `unknown`.
 */
export function ipBucket(ip: string | null): string {
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 45) return 'unknown';
  if (IPV4.test(ip)) return ip;
  if (!ip.includes(':')) return 'unknown';
  const hextets = ipv6Hextets(ip);
  if (hextets === null) return 'unknown';
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return `${String(h6 >> 8)}.${String(h6 & 0xff)}.${String(h7 >> 8)}.${String(h7 & 0xff)}`;
  }
  const pad = (n: number): string => n.toString(16).padStart(4, '0');
  return `${pad(h0)}:${pad(h1)}:${pad(h2)}:${pad(h3)}::/64`;
}
