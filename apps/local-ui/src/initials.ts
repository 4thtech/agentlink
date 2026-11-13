// One rule for a person's monogram, so Home and People draw the same letters (R1-UI-24): the first
// letter of each of the first two words; "#" for an unnamed "Contact …"; "?" for nothing.
export function initials(text: string): string {
  const t = text.replace(/[“”"]/g, '').trim();
  if (t.startsWith('Contact ')) return '#';
  return (
    t
      .split(/\s+/)
      .map((w) => [...w][0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}
