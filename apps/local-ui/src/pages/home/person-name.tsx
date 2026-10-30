// W4-HOME (IR-W4-HOME-SEC-1 g): one way to show a person's name on Home. The server already applies
// the name rule (the owner's alias or the restricted name); here the name is cleaned once more of
// direction-changing, invisible and control characters, capped, and isolated in a `<bdi dir="auto">`
// so it can never reorder the text around it. React text only (I-5).
import type { ReactElement } from 'react';

// Control characters (C0, DEL, C1), the Arabic letter mark, zero-width and direction marks,
// embeddings and overrides, isolates and the byte-order mark.
const isHidden = (cp: number): boolean =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2069) ||
  cp === 0xfeff;
const MAX = 64;

/** The name with no hidden or direction-changing characters; never empty. */
export function cleanName(name: string): string {
  const clean = [...name]
    .filter((ch) => !isHidden(ch.codePointAt(0) ?? 0))
    .join('')
    .trim();
  return clean === '' ? '?' : [...clean].slice(0, MAX).join('');
}

export function PersonName({ name }: { readonly name: string }): ReactElement {
  return (
    <bdi dir="auto" className="hm-name">
      {cleanName(name)}
    </bdi>
  );
}
