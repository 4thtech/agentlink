// The inert-hold helper behind the modal layers (UI-REFRESH-f; moved here and kept off the public
// index by UI-REFRESH-e3). Internal: imported relatively by surface.tsx and pay-confirm.tsx only.

// Everything behind an open Sheet or dialog is inert (UI-REFRESH-f, follow-up from the review of
// #598): from the frame up to <body>, every sibling gets the `inert` attribute, so focus, clicks and
// assistive technology stay on the layer. A count per element lets two layers stack; an element that
// was already inert before is left alone and never released by us.
const inertCounts = new Map<Element, number>();

/**
 * Makes everything behind `frame` inert and returns the release.
 *
 * @internal Used by Sheet, DialogFrame and PayConfirmSheet only; not part of the package's public
 * API (UI-REFRESH-e3). Elements mounted behind the layer after the hold are not covered (UI-REFRESH-f-c).
 */
export function holdInert(frame: HTMLElement): () => void {
  const held: Element[] = [];
  for (let node: HTMLElement = frame; node !== document.body;) {
    const parent = node.parentElement;
    if (parent === null) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      const count = inertCounts.get(sibling);
      if (count === undefined) {
        if (sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        inertCounts.set(sibling, 1);
      } else {
        inertCounts.set(sibling, count + 1);
      }
      held.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const el of held) {
      const count = (inertCounts.get(el) ?? 1) - 1;
      if (count <= 0) {
        inertCounts.delete(el);
        el.removeAttribute('inert');
      } else {
        inertCounts.set(el, count);
      }
    }
  };
}
