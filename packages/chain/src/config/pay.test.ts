// The shipped pay page config (M1-26-e; docs/design/topup-ux.md §5, D-113).
import { describe, expect, it } from 'vitest';
import { PAY_PAGE } from './pay.js';

describe('PAY_PAGE', () => {
  it('is not live: the pay page does not exist yet, so no link is given by default', () => {
    expect(PAY_PAGE.live).toBe(false);
  });

  it('names a plain lowercase host (no scheme, path, port or userinfo)', () => {
    expect(PAY_PAGE.host).toMatch(/^(?:[a-z0-9-]+\.)+[a-z]+$/);
  });

  it('is frozen, so no caller can redirect a payment', () => {
    expect(Object.isFrozen(PAY_PAGE)).toBe(true);
  });
});
