// U3-h: the Agents page is a sidebar item after Contacts and a lazy route.
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../../nav.js';
import { PAGE_PARTS } from '../../lazy/pages.js';
import { AGENTS_PATH } from './data.js';

describe('Agents navigation', () => {
  it('is the item right after Contacts', () => {
    const labels = NAV_ITEMS.map((i) => i.label);
    expect(labels[labels.indexOf('Contacts') + 1]).toBe('Agents');
    expect(NAV_ITEMS.find((i) => i.label === 'Agents')?.path).toBe(AGENTS_PATH);
  });
  it('is a lazy page', () => {
    expect(PAGE_PARTS[AGENTS_PATH]).toBeDefined();
  });
});
