// TRAY-POPOVER (D-155): where the popover goes. Pure: tray bounds + the display's work area in,
// the window's bounds out. Under the icon on macOS; at the notification area on Windows on whichever
// edge the taskbar is; zero or off-screen bounds fall back to the cursor, then to a work-area corner.
import { describe, expect, it } from 'vitest';
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  popoverBounds,
  taskbarEdge,
  validDisplayArea,
  validTrayBounds,
  type DisplayArea,
  type Rect,
} from '../../src/main/popover-position.js';

const SIZE = { width: 360, height: 560 };

// 1440×900 Mac with a 25 px menu bar (and a Dock at the bottom).
const MAC: DisplayArea = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 800 },
};
// 1920×1080 Windows, taskbar 48 px on each edge in turn.
const WIN_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };
const win = (workArea: Rect): DisplayArea => ({ bounds: WIN_BOUNDS, workArea });
const WIN_BOTTOM = win({ x: 0, y: 0, width: 1920, height: 1032 });
const WIN_TOP = win({ x: 0, y: 48, width: 1920, height: 1032 });
const WIN_LEFT = win({ x: 48, y: 0, width: 1872, height: 1080 });
const WIN_RIGHT = win({ x: 0, y: 0, width: 1872, height: 1080 });

const inside = (r: Rect, area: Rect): boolean =>
  r.x >= area.x &&
  r.y >= area.y &&
  r.x + r.width <= area.x + area.width &&
  r.y + r.height <= area.y + area.height;

describe('validTrayBounds', () => {
  it('accepts a real icon rectangle', () => {
    expect(validTrayBounds({ x: 1200, y: 0, width: 24, height: 24 })).toEqual({
      x: 1200,
      y: 0,
      width: 24,
      height: 24,
    });
  });

  it.each([
    null,
    undefined,
    {},
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 10, y: 10, width: 0, height: 22 },
    { x: Number.NaN, y: 0, width: 22, height: 22 },
    { x: 0, y: Infinity, width: 22, height: 22 },
    { x: 0, y: 0, width: 5000, height: 22 },
    { x: '1', y: 0, width: 22, height: 22 },
  ])('refuses %j', (bounds) => {
    expect(validTrayBounds(bounds)).toBeNull();
  });
});

describe('taskbarEdge', () => {
  it('macOS: the menu bar is the top edge', () => {
    expect(taskbarEdge({ x: 1200, y: 0, width: 24, height: 24 }, MAC, 'darwin')).toBe('top');
  });

  it('Windows: finds the taskbar on every edge', () => {
    expect(taskbarEdge({ x: 1800, y: 1040, width: 24, height: 32 }, WIN_BOTTOM, 'win32')).toBe(
      'bottom',
    );
    expect(taskbarEdge({ x: 1800, y: 8, width: 24, height: 32 }, WIN_TOP, 'win32')).toBe('top');
    expect(taskbarEdge({ x: 12, y: 1000, width: 24, height: 24 }, WIN_LEFT, 'win32')).toBe('left');
    expect(taskbarEdge({ x: 1884, y: 1000, width: 24, height: 24 }, WIN_RIGHT, 'win32')).toBe(
      'right',
    );
  });

  it('an icon inside the work area (overflow flyout, auto-hide taskbar) uses the nearest edge', () => {
    const autoHide = win(WIN_BOUNDS);
    expect(taskbarEdge({ x: 1700, y: 980, width: 24, height: 24 }, autoHide, 'win32')).toBe(
      'bottom',
    );
    expect(taskbarEdge({ x: 1890, y: 500, width: 24, height: 24 }, autoHide, 'win32')).toBe(
      'right',
    );
  });
});

describe('popoverBounds', () => {
  it('macOS: centred under the icon, just below the menu bar', () => {
    const r = popoverBounds({
      platform: 'darwin',
      size: SIZE,
      anchor: { x: 1000, y: 0, width: 24, height: 24 },
      display: MAC,
    });
    expect(r).toEqual({ x: 1012 - 180, y: 25 + POPOVER_GAP, width: 360, height: 560 });
  });

  it('macOS: an icon near the right edge is clamped into the work area', () => {
    const r = popoverBounds({
      platform: 'darwin',
      size: SIZE,
      anchor: { x: 1410, y: 0, width: 24, height: 24 },
      display: MAC,
    });
    expect(r.x + r.width).toBe(1440 - POPOVER_MARGIN);
    expect(inside(r, MAC.workArea)).toBe(true);
  });

  it('Windows bottom taskbar: above the icon, clamped to the right', () => {
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: 1820, y: 1040, width: 24, height: 32 },
      display: WIN_BOTTOM,
    });
    expect(r.y + r.height).toBe(1032 - POPOVER_GAP);
    expect(r.x + r.width).toBe(1920 - POPOVER_MARGIN);
    expect(inside(r, WIN_BOTTOM.workArea)).toBe(true);
  });

  it('Windows top taskbar: below the icon', () => {
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: 1700, y: 8, width: 24, height: 32 },
      display: WIN_TOP,
    });
    expect(r.y).toBe(48 + POPOVER_GAP);
    expect(inside(r, WIN_TOP.workArea)).toBe(true);
  });

  it('Windows left taskbar: to the right of the icon', () => {
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: 12, y: 1000, width: 24, height: 24 },
      display: WIN_LEFT,
    });
    expect(r.x).toBe(48 + POPOVER_GAP);
    expect(inside(r, WIN_LEFT.workArea)).toBe(true);
  });

  it('Windows right taskbar: to the left of the icon', () => {
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: 1884, y: 1000, width: 24, height: 24 },
      display: WIN_RIGHT,
    });
    expect(r.x + r.width).toBe(1872 - POPOVER_GAP);
    expect(inside(r, WIN_RIGHT.workArea)).toBe(true);
  });

  it('no anchor: the work-area corner (top right on macOS, by the clock on Windows)', () => {
    const mac = popoverBounds({ platform: 'darwin', size: SIZE, anchor: null, display: MAC });
    expect(mac).toEqual({
      x: 1440 - POPOVER_MARGIN - 360,
      y: 25 + POPOVER_MARGIN,
      width: 360,
      height: 560,
    });
    const windows = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: null,
      display: WIN_BOTTOM,
    });
    expect(windows).toEqual({
      x: 1920 - POPOVER_MARGIN - 360,
      y: 1032 - POPOVER_MARGIN - 560,
      width: 360,
      height: 560,
    });
  });

  it('a small screen shrinks the popover to the work area', () => {
    const tiny: DisplayArea = {
      bounds: { x: 0, y: 0, width: 320, height: 400 },
      workArea: { x: 0, y: 0, width: 320, height: 360 },
    };
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: 290, y: 370, width: 20, height: 20 },
      display: tiny,
    });
    expect(r.width).toBe(320 - 2 * POPOVER_MARGIN);
    expect(r.height).toBe(360 - 2 * POPOVER_MARGIN);
    expect(inside(r, tiny.workArea)).toBe(true);
  });

  it('a second display with negative coordinates', () => {
    const left: DisplayArea = {
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1032 },
    };
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: -100, y: 1040, width: 24, height: 32 },
      display: left,
    });
    expect(inside(r, left.workArea)).toBe(true);
    expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
  });
});

describe('validDisplayArea (unusable numbers fall back)', () => {
  it('accepts a real display', () => {
    expect(validDisplayArea(MAC)).toEqual(MAC);
  });

  it.each([
    null,
    {},
    { bounds: MAC.bounds },
    { bounds: { ...MAC.bounds, x: Number.NaN }, workArea: MAC.workArea },
    { bounds: MAC.bounds, workArea: { ...MAC.workArea, height: Infinity } },
    { bounds: MAC.bounds, workArea: { ...MAC.workArea, width: 0 } },
    { bounds: MAC.bounds, workArea: { ...MAC.workArea, x: -50 } },
  ])('refuses %j', (display) => {
    expect(validDisplayArea(display)).toBeNull();
  });

  it('popoverBounds never answers NaN or Infinity', () => {
    const r = popoverBounds({
      platform: 'win32',
      size: SIZE,
      anchor: { x: Number.NaN, y: 0, width: 24, height: 24 },
      display: { bounds: MAC.bounds, workArea: { ...MAC.workArea, y: Number.NaN } },
    });
    expect(r).toEqual({ x: 0, y: 0, width: 360, height: 560 });
    const noAnchor = popoverBounds({
      platform: 'darwin',
      size: SIZE,
      anchor: { x: Number.NaN, y: 0, width: 24, height: 24 },
      display: MAC,
    });
    expect(Object.values(noAnchor).every(Number.isFinite)).toBe(true);
    expect(noAnchor).toEqual({
      x: 1440 - POPOVER_MARGIN - 360,
      y: 25 + POPOVER_MARGIN,
      width: 360,
      height: 560,
    });
  });
});
