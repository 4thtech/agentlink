// The top-up link builder (M1-26-e; D-113, 08 §1, docs/design/topup-ux.md §5).
import { describe, expect, it } from 'vitest';
import {
  TOP_UP_MAX_USD,
  TOP_UP_MIN_USD,
  TOP_UP_PAY_HOST,
  TOP_UP_PRESETS_USD,
  buildTopUpLink,
  suggestTopUpUsd,
} from './top-up-link.js';

const A = `0x${'ab'.repeat(20)}`;

describe('buildTopUpLink (D-113)', () => {
  it('puts everything in the fragment: https://{payHost}/#v=1&a=<address>&usd=<amount>', () => {
    expect(buildTopUpLink({ agentAddress: A, usd: '10' })).toBe(
      `https://${TOP_UP_PAY_HOST}/#v=1&a=${A}&usd=10`,
    );
  });

  it('usd is optional', () => {
    expect(buildTopUpLink({ agentAddress: A })).toBe(`https://${TOP_UP_PAY_HOST}/#v=1&a=${A}`);
  });

  it('the host comes from the config argument, with the shipped testing host as the default', () => {
    expect(TOP_UP_PAY_HOST).toBe('pay.agentlink.4thtech.io');
    expect(buildTopUpLink({ agentAddress: A, payHost: 'pay.example.test' })).toBe(
      `https://pay.example.test/#v=1&a=${A}`,
    );
  });

  it('nothing but the address and the amount is in the link: no query, no network, no token', () => {
    const url = buildTopUpLink({ agentAddress: A, usd: '25' }) ?? '';
    expect(url).not.toContain('?');
    expect(url.split('#').length).toBe(2);
    expect(url).not.toMatch(/chain|network|token|usdc|key|seed/i);
    expect(url.split('#')[0]).toBe(`https://${TOP_UP_PAY_HOST}/`);
  });

  it.each([
    ['uppercase hex', `0x${'AB'.repeat(20)}`],
    ['mixed case', `0x${'aB'.repeat(20)}`],
    ['0X prefix', `0X${'ab'.repeat(20)}`],
    ['too short', `0x${'ab'.repeat(19)}`],
    ['too long', `0x${'ab'.repeat(21)}`],
    ['no prefix', 'ab'.repeat(20)],
    ['non-hex', `0x${'zz'.repeat(20)}`],
    ['trailing text', `${A}&x=1`],
    ['empty', ''],
  ])('refuses a bad agent address (%s)', (_name, bad) => {
    expect(buildTopUpLink({ agentAddress: bad })).toBeUndefined();
  });

  it.each([
    '',
    '0',
    '-5',
    '+5',
    '4.99',
    '1e3',
    '5.123',
    '05',
    ' 10',
    '10 ',
    '10&x=1',
    '10#',
    '0x10',
    '10000.01',
    '100000',
    'abc',
    '.5',
    '5.',
  ])('refuses a bad usd %j', (usd) => {
    expect(buildTopUpLink({ agentAddress: A, usd })).toBeUndefined();
  });

  it.each(['5', '5.5', '10', '25', '26', '99.99', String(TOP_UP_MAX_USD)])(
    'accepts usd %s',
    (usd) => {
      expect(buildTopUpLink({ agentAddress: A, usd })).toBe(
        `https://${TOP_UP_PAY_HOST}/#v=1&a=${A}&usd=${usd}`,
      );
    },
  );

  it.each([
    'https://pay.example.test',
    'pay.example.test/x',
    'user@pay.example.test',
    'pay.example.test:8080',
    'Pay.Example.test',
    'pay example.test',
    'pay.example.test.',
    '-pay.example.test',
    'localhost',
    '',
    'pay.example.test?x=1',
    'pay.example.test#x',
    '127.0.0.1',
  ])('refuses a payHost that is not a plain lowercase host name: %j', (payHost) => {
    expect(buildTopUpLink({ agentAddress: A, payHost })).toBeUndefined();
  });
});

describe('suggestTopUpUsd (08 §1: the shortfall rounded up to the first preset, at least the minimum)', () => {
  it('the presets are $5, $10 and $25 and the minimum is $5', () => {
    expect(TOP_UP_PRESETS_USD).toEqual([5, 10, 25]);
    expect(TOP_UP_MIN_USD).toBe(5);
    expect(TOP_UP_MAX_USD).toBe(10_000);
  });

  it.each([
    ['0.1', '5'],
    ['0.000001', '5'],
    ['1', '5'],
    ['4.99', '5'],
    ['5', '5'],
    ['5.000001', '10'],
    ['5.01', '10'],
    ['10', '10'],
    ['10.5', '25'],
    ['25', '25'],
    ['25.01', '26'],
    ['26', '26'],
    ['99.5', '100'],
    ['10000', '10000'],
  ])('shortfall %s gives %s', (shortfall, expected) => {
    expect(suggestTopUpUsd(shortfall)).toBe(expected);
  });

  it.each(['0', '0.0', '-1', '', 'abc', '1e3', '10000.01', '99999', '1.1234567', ' 5', '5 '])(
    'no suggestion for %j',
    (shortfall) => {
      expect(suggestTopUpUsd(shortfall)).toBeUndefined();
    },
  );

  it('every suggestion is accepted by the builder', () => {
    for (const s of ['0.1', '7', '30', '9999.5']) {
      const usd = suggestTopUpUsd(s);
      expect(usd).toBeDefined();
      expect(buildTopUpLink({ agentAddress: A, ...(usd === undefined ? {} : { usd }) })).toContain(
        `&usd=${usd}`,
      );
    }
  });
});
