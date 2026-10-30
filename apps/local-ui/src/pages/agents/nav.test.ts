// U3-h: the Agents page is a lazy route. W4-SHELL-V2 (Decision 48): Agents is a section of the menu
// at `/agents`; the old `/settings/agents` path still opens it.
import { describe, expect, it } from 'vitest';
import { REDIRECTS, SECTIONS, goToEntries } from '../../nav.js';
import { PAGE_PARTS } from '../../lazy/pages.js';
import { AGENTS_PATH } from './data.js';

describe('Agents navigation', () => {
  it('is a section of the menu and reached from Cmd+K; the old path redirects', () => {
    expect(SECTIONS.find((s) => s.id === 'agents')?.path).toBe('/agents');
    expect(goToEntries(false).find((e) => e.label === 'Agents')?.path).toBe('/agents');
    expect(REDIRECTS[AGENTS_PATH]).toBe('/agents');
  });
  it('is a lazy page', () => {
    expect(PAGE_PARTS['/agents']).toBeDefined();
  });
});
