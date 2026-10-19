// M1-10a: the submitter's per-IP rate-limit bucket (07 §7; as the drop's, M1-27a): IPv4 per address,
// IPv6 per /64.
import { describe, expect, it } from 'vitest';
import { ipBucket } from './ip.js';

describe('ipBucket', () => {
  it('keeps an IPv4 address as is', () => {
    expect(ipBucket('198.51.100.7')).toBe('198.51.100.7');
  });

  it('reduces IPv6 to its /64 prefix, whatever the notation', () => {
    const expected = '2001:0db8:00aa:00bb::/64';
    for (const ip of [
      '2001:db8:aa:bb::1',
      '2001:DB8:AA:BB:1:2:3:4',
      '2001:0db8:00aa:00bb:0000:0000:0000:ffff',
      '2001:db8:aa:bb:0:0:0:9',
    ]) {
      expect(ipBucket(ip)).toBe(expected);
    }
    expect(ipBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
  });

  it('treats an IPv4-mapped IPv6 address as IPv4', () => {
    expect(ipBucket('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('puts a missing or malformed address in one shared bucket', () => {
    for (const bad of [
      null,
      '',
      'not-an-ip',
      '1.2.3',
      '256.1.1.1',
      '01.2.3.4',
      '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      'a'.repeat(100),
    ]) {
      expect(ipBucket(bad)).toBe('unknown');
    }
  });
});
