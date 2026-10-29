// U3-h: the Agents page is a lazy route. W4-SHELL (b11 §34.2): it is no sidebar item; the agent
// switcher's "Manage agents & apps" and Cmd+K open it.
import { describe, expect, it } from 'vitest';
import { GO_TO, NAV_ITEMS } from '../../nav.js';
import { PAGE_PARTS } from '../../lazy/pages.js';
import { AGENTS_PATH } from './data.js';

describe('Agents navigation', () => {
  it('is reached from the switcher and Cmd+K, not the sidebar', () => {
    expect(NAV_ITEMS.some((i) => i.path === AGENTS_PATH)).toBe(false);
    expect(GO_TO.find((e) => e.label === 'Manage agents & apps')?.path).toBe(AGENTS_PATH);
  });
  it('is a lazy page', () => {
    expect(PAGE_PARTS[AGENTS_PATH]).toBeDefined();
  });
});
