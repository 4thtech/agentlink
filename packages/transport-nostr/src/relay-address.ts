// M1-5b: the address half of the relay SSRF rules (04 §4 "Transport, at connect"; 07 §4.2 "Relay
// connections"). A relay host name can resolve to a private address (DNS rebinding), so the pool
// resolves the host and accepts it only if EVERY answer is globally routable.
//
// IPv4: not in any block the IANA IPv4 Special-Purpose Address Registry marks as not globally
// reachable. IPv6: inside 2000::/3, outside every block the IANA IPv6 registry marks as not globally
// reachable, and outside the blocks that embed IPv4 addresses (6to4, Teredo, NAT64). Anything that
// does not parse as a plain address is refused, so a resolver that returns a zone id, a bracketed
// literal, a name or an odd notation fails closed.
//
// Pure code, no I/O: the resolver itself is injected (HostResolver in relay-io.ts) because shared
// packages cannot use Node built-ins.

/** Parses dotted-decimal IPv4 strictly (four 0-255 decimals, no leading zeros). */
function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    out.push(value);
  }
  return out;
}

/** Parses an IPv6 address into eight 16-bit groups; an embedded IPv4 tail is allowed. */
function parseIpv6(text: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(text)) return undefined;
  let head = text;
  let tail: number[] = [];
  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two groups.
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [
      ((v4[0] as number) << 8) | (v4[1] as number),
      ((v4[2] as number) << 8) | (v4[3] as number),
    ];
    head = text.slice(0, lastColon + 1);
    // "::1.2.3.4" keeps its "::"; "::ffff:1.2.3.4" loses the single colon before the tail.
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const wanted = 8 - tail.length;
  const halves = head.split('::');
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const left = toGroups(halves[0] as string);
  if (left === undefined) return undefined;
  if (halves.length === 1) {
    return left.length === wanted ? [...left, ...tail] : undefined;
  }
  const right = toGroups(halves[1] as string);
  if (right === undefined) return undefined;
  const missing = wanted - left.length - right.length;
  if (missing < 1) return undefined; // "::" stands for at least one group
  return [...left, ...new Array<number>(missing).fill(0), ...right, ...tail];
}

type V4Block = readonly [number, number, number, number, number]; // a, b, c, d, prefix length

/** Blocks of the IANA IPv4 Special-Purpose Address Registry that are not globally reachable. */
const IPV4_DENIED: readonly V4Block[] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // CGNAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, including the metadata address 169.254.169.254
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // deprecated 6to4 relay anycast
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, including 255.255.255.255
];

function inV4Block(address: readonly number[], block: V4Block): boolean {
  const value =
    (address[0] as number) * 2 ** 24 +
    ((address[1] as number) << 16) +
    ((address[2] as number) << 8) +
    (address[3] as number);
  const base = block[0] * 2 ** 24 + (block[1] << 16) + (block[2] << 8) + block[3];
  const size = 2 ** (32 - block[4]);
  return Math.floor(value / size) === Math.floor(base / size);
}

type V6Block = readonly [number[], number]; // leading groups, prefix length in bits

/** Blocks inside 2000::/3 that are not globally reachable, or that embed IPv4 addresses. */
const IPV6_DENIED: readonly V6Block[] = [
  [[0x2001, 0x0000], 23], // IETF protocol assignments, including Teredo 2001::/32
  [[0x2001, 0x0db8], 32], // documentation
  [[0x2002], 16], // 6to4
  [[0x3fff], 20], // documentation
];

function inV6Block(groups: readonly number[], [prefix, bits]: V6Block): boolean {
  let remaining = bits;
  for (let i = 0; remaining > 0; i += 1) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] as number) & mask) !== (((prefix[i] ?? 0) as number) & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * True when `address` is a plain IPv4 or IPv6 address that is globally routable under the allowlist
 * of 07 §4.2. Anything else (a name, a zone id, a malformed string) is false: fail closed.
 */
export function isGloballyRoutable(address: string): boolean {
  if (typeof address !== 'string') return false;
  if (address.includes(':')) {
    const groups = parseIpv6(address);
    if (groups === undefined) return false;
    if (((groups[0] as number) & 0xe000) !== 0x2000) return false; // outside 2000::/3
    return !IPV6_DENIED.some((block) => inV6Block(groups, block));
  }
  const v4 = parseIpv4(address);
  if (v4 === undefined) return false;
  return !IPV4_DENIED.some((block) => inV4Block(v4, block));
}
