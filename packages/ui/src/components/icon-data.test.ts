// UX-031-QUICKWINS: every icon shape carries its geometry (a shape with no attributes draws nothing).
import { describe, expect, it } from 'vitest';
import { ICON_SHAPES } from './icon-data.js';

describe('icon data', () => {
  it('has attributes on every shape of every icon', () => {
    for (const [name, shapes] of Object.entries(ICON_SHAPES)) {
      expect(shapes.length, name).toBeGreaterThan(0);
      for (const [tag, attrs] of shapes) {
        expect(Object.keys(attrs).length, `${name} <${tag}>`).toBeGreaterThan(0);
      }
    }
  });

  it('draws the Rules icon (sliders-horizontal) with nine lines', () => {
    const shapes = ICON_SHAPES['sliders-horizontal'] ?? [];
    expect(shapes).toHaveLength(9);
    for (const [tag, attrs] of shapes) {
      expect(tag).toBe('line');
      expect(Object.keys(attrs).sort()).toEqual(['x1', 'x2', 'y1', 'y2']);
    }
  });
});
