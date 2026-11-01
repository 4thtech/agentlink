// The layer stack behind Sheet, DialogFrame and PayConfirmSheet (W5-SHEET-CLOSE). Internal: imported
// relatively by surface.tsx and pay-confirm.tsx only; not part of the package's public API.
//
// Why: Escape used to be a React handler on the layer, so it only fired while focus was inside it.
// A click on non-focusable content (or a removed focused button) moves focus to <body>, the rest of
// the page is inert, and Escape went nowhere. Now one document-level listener serves the stack and
// the top-most layer wins; each layer also closes when the route changes.
import { useEffect, useRef } from 'react';

interface Layer {
  readonly escape: () => void;
}

const stack: Layer[] = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  event.preventDefault();
  top.escape();
}

/** The app router's own event (router.tsx); `popstate` covers Back and Forward. */
const NAVIGATION_EVENTS = ['popstate', 'agentlink:navigate'] as const;

function place(): string {
  return typeof location === 'undefined' ? '' : location.pathname + location.search;
}

/**
 * While `active`, Escape on the document calls `onEscape` (top-most layer only) and a route change
 * calls `onNavigate` (every layer).
 */
export function useLayer(active: boolean, onEscape: () => void, onNavigate: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    if (!active) return undefined;
    const layer: Layer = { escape: () => escape.current() };
    if (stack.length === 0) document.addEventListener('keydown', onKeyDown);
    stack.push(layer);
    const opened = place();
    const left = (event: Event): void => {
      // A navigation to the same address (a deep link that lands here) leaves the layer open.
      if (event.type !== 'popstate' && place() === opened) return;
      navigate.current();
    };
    for (const name of NAVIGATION_EVENTS) window.addEventListener(name, left);
    return () => {
      for (const name of NAVIGATION_EVENTS) window.removeEventListener(name, left);
      const at = stack.indexOf(layer);
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);
}

/**
 * Focus that lands on <body> (a click on text, a removed button) goes back to the layer's title, so
 * the layer keeps the keyboard. Returns a handler for the layer's `focusout`.
 */
export function refocusOnLoss(
  frame: { current: HTMLElement | null },
  title: { current: HTMLElement | null },
): () => void {
  return () => {
    setTimeout(() => {
      const root = frame.current;
      if (root === null || !root.isConnected) return;
      const now = document.activeElement;
      if (now === null || now === document.body || now === document.documentElement) {
        title.current?.focus();
      }
    }, 0);
  };
}
