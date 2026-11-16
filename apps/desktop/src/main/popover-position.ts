// TRAY-POPOVER (D-155; plan §3): where the popover window goes. Pure and unit-tested.
//
// Input: the tray icon's bounds (Tray.getBounds, in screen DIPs), the display that holds them
// (bounds and work area) and the wanted size. Output: the window's bounds, inside the work area.
// - macOS: under the icon, centred, just below the menu bar.
// - Windows: at the notification-area icon on whichever edge the taskbar is (bottom → above the
//   icon, top → below, left → to the right, right → to the left). The edge is where the icon sits
//   outside the work area; an icon inside it (the "^" overflow flyout, an auto-hiding taskbar) uses
//   the display edge nearest to it.
// - No usable anchor (zero or off-screen bounds, and no cursor): the work-area corner (top right on
//   macOS, by the clock bottom right elsewhere). The caller tries the cursor before that.
// - Always clamped into the work area with a margin; a screen smaller than the popover shrinks it.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What the popover needs of an Electron Display. */
export interface DisplayArea {
  readonly bounds: Rect;
  readonly workArea: Rect;
}

export type Edge = 'top' | 'bottom' | 'left' | 'right';

/** Space between the icon (or the taskbar) and the popover. */
export const POPOVER_GAP = 6;
/** Space kept between the popover and the work area's edges. */
export const POPOVER_MARGIN = 8;
/** A tray icon is never larger than this (larger bounds are not an icon). */
const MAX_ICON = 512;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The bounds when they describe a real icon (finite, non-empty, icon-sized); else null. */
export function validTrayBounds(bounds: unknown): Rect | null {
  if (typeof bounds !== 'object' || bounds === null) return null;
  const { x, y, width, height } = bounds as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_ICON || height > MAX_ICON) return null;
  return { x, y, width, height };
}

/** True when the rectangles overlap (a point-sized rect counts when it lies inside). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** The edge the taskbar (menu bar) is on, as seen from the icon. */
export function taskbarEdge(anchor: Rect, display: DisplayArea, platform: string): Edge {
  const c = center(anchor);
  const wa = display.workArea;
  if (c.y < wa.y) return 'top';
  if (c.y >= wa.y + wa.height) return 'bottom';
  if (c.x < wa.x) return 'left';
  if (c.x >= wa.x + wa.width) return 'right';
  if (platform === 'darwin') return 'top';
  const b = display.bounds;
  const distances: readonly [Edge, number][] = [
    ['bottom', b.y + b.height - c.y],
    ['top', c.y - b.y],
    ['right', b.x + b.width - c.x],
    ['left', c.x - b.x],
  ];
  let best = distances[0] as [Edge, number];
  for (const entry of distances) if (entry[1] < best[1]) best = entry;
  return best[0];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export interface PopoverPlacement {
  readonly platform: string;
  readonly size: { readonly width: number; readonly height: number };
  /** The icon (or a point-sized rect at the cursor); null: the work-area corner. */
  readonly anchor: Rect | null;
  readonly display: DisplayArea;
}

/** The popover's bounds (integers, inside the work area). */
export function popoverBounds(placement: PopoverPlacement): Rect {
  const { platform, anchor, display } = placement;
  const wa = display.workArea;
  const width = Math.max(1, Math.min(placement.size.width, wa.width - 2 * POPOVER_MARGIN));
  const height = Math.max(1, Math.min(placement.size.height, wa.height - 2 * POPOVER_MARGIN));
  let minX = wa.x + POPOVER_MARGIN;
  let minY = wa.y + POPOVER_MARGIN;
  let maxX = wa.x + wa.width - POPOVER_MARGIN - width;
  let maxY = wa.y + wa.height - POPOVER_MARGIN - height;

  let x: number;
  let y: number;
  if (anchor === null) {
    x = maxX;
    y = platform === 'darwin' ? minY : maxY;
  } else {
    const c = center(anchor);
    switch (taskbarEdge(anchor, display, platform)) {
      // On the taskbar's side only the gap separates the popover from it (not the margin).
      case 'top':
        x = c.x - width / 2;
        y = Math.max(anchor.y + anchor.height, wa.y) + POPOVER_GAP;
        minY = Math.min(minY, wa.y + POPOVER_GAP);
        break;
      case 'bottom':
        x = c.x - width / 2;
        y = Math.min(anchor.y, wa.y + wa.height) - POPOVER_GAP - height;
        maxY = Math.max(maxY, wa.y + wa.height - POPOVER_GAP - height);
        break;
      case 'left':
        x = Math.max(anchor.x + anchor.width, wa.x) + POPOVER_GAP;
        y = c.y - height / 2;
        minX = Math.min(minX, wa.x + POPOVER_GAP);
        break;
      case 'right':
        x = Math.min(anchor.x, wa.x + wa.width) - POPOVER_GAP - width;
        y = c.y - height / 2;
        maxX = Math.max(maxX, wa.x + wa.width - POPOVER_GAP - width);
        break;
    }
  }
  return {
    x: Math.round(clamp(x, minX, maxX)),
    y: Math.round(clamp(y, minY, maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}
