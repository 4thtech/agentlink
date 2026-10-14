// M1-5b: the address allowlist of 07 §4.2 (relay connections, step 2), table-driven.
import { describe, expect, it } from 'vitest';
import { isGloballyRoutable } from './relay-address.js';

describe('isGloballyRoutable: IPv4', () => {
  it.each([
    ['93.184.216.34'],
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['198.17.255.255'],
    ['198.20.0.1'],
    ['223.255.255.255'],
  ])('accepts the global address %s', (address) => {
    expect(isGloballyRoutable(address)).toBe(true);
  });

  it.each([
    ['0.0.0.0'],
    ['0.255.255.255'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['100.64.0.1'],
    ['100.127.255.255'],
    ['127.0.0.1'],
    ['127.255.255.255'],
    ['169.254.169.254'],
    ['169.254.0.1'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.0.0.1'],
    ['192.0.2.1'],
    ['192.88.99.1'],
    ['192.168.0.1'],
    ['198.18.0.1'],
    ['198.19.255.255'],
    ['198.51.100.7'],
    ['203.0.113.9'],
    ['224.0.0.1'],
    ['239.255.255.255'],
    ['240.0.0.1'],
    ['255.255.255.255'],
  ])('refuses the non-global address %s', (address) => {
    expect(isGloballyRoutable(address)).toBe(false);
  });

  it.each([
    [''],
    ['1.2.3'],
    ['1.2.3.4.5'],
    ['256.1.1.1'],
    ['01.2.3.4'],
    ['1.2.3.04'],
    ['0x7f.0.0.1'],
    ['2130706433'],
    ['1.2.3.4 '],
    ['example.com'],
    ['1.2.3.-4'],
  ])('refuses the malformed address %j', (address) => {
    expect(isGloballyRoutable(address)).toBe(false);
  });
});

describe('isGloballyRoutable: IPv6', () => {
  it.each([
    ['2606:4700:4700::1111'],
    ['2a00:1450:4001:81b::200e'],
    ['2001:4860:4860::8888'],
    ['2620:4f:8000::1'],
    ['3ffe::1'],
    ['3fff:1000::1'],
  ])('accepts the global address %s', (address) => {
    expect(isGloballyRoutable(address)).toBe(true);
  });

  it.each([
    ['::'],
    ['::1'],
    ['::ffff:8.8.8.8'], // IPv4-mapped: outside 2000::/3
    ['::ffff:127.0.0.1'],
    ['64:ff9b::808:808'], // NAT64
    ['64:ff9b:1::1'], // NAT64 local use
    ['2002:808:808::1'], // 6to4
    ['2002::1'],
    ['2001::1'], // Teredo
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['2001:2::1'], // benchmarking, inside 2001::/23
    ['2001:db8::1'], // documentation
    ['3fff::1'], // documentation (3fff::/20)
    ['3fff:fff::1'],
    ['fc00::1'], // unique-local
    ['fd12:3456::1'],
    ['fe80::1'], // link-local
    ['fe80::1%eth0'],
    ['ff02::1'], // multicast
    ['100::1'], // discard-only
    ['4000::1'], // outside 2000::/3
    ['1fff::1'],
  ])('refuses the non-global address %s', (address) => {
    expect(isGloballyRoutable(address)).toBe(false);
  });

  it.each([
    [':::'],
    ['2001:4860:4860::8888::1'],
    ['2001:4860:4860:0:0:0:0:0:1'],
    ['2001:4860:4860:1'],
    ['2606:4700:4700:::1111'],
    ['[2606:4700:4700::1111]'],
    ['g606::1'],
    ['2606:4700:4700::1111:12345'],
    ['2606::1.2.3'],
  ])('refuses the malformed address %j', (address) => {
    expect(isGloballyRoutable(address)).toBe(false);
  });

  it('reads an embedded IPv4 tail and still applies the block rules', () => {
    expect(isGloballyRoutable('2606:4700::1.2.3.4')).toBe(true);
    expect(isGloballyRoutable('2002::1.2.3.4')).toBe(false);
  });
});
