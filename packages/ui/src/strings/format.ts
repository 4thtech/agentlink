// A small ICU MessageFormat subset (11 §5.4): `{name}`, `{n, plural, one {# x} other {# xs}}` and
// `{k, select, a {A} other {B}}`. Values are inserted as text and are never parsed again, so a
// counterparty-supplied value cannot inject a placeholder (I-5).

export type MessageValues = Readonly<Record<string, string | number>>;

/** Index of the `}` closing the `{` that opens at `start`. Throws on an unbalanced message. */
function closing(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced "{" at ${start} in message`);
}

/** Parse `key {text} key {text} …` into a map of branch name to branch source. */
function branches(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const open = body.indexOf('{', i);
    if (open < 0) throw new Error('Branch without "{"');
    const name = body.slice(i, open).trim();
    const end = closing(body, open);
    out.set(name, body.slice(open + 1, end));
    i = end + 1;
  }
  return out;
}

const PLACEHOLDER = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(plural|select)\s*,([\s\S]*))?$/;

function render(src: string, values: MessageValues, hash: number | undefined): string {
  let text = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '#' && hash !== undefined) {
      text += String(hash);
      i++;
    } else if (c === '{') {
      const end = closing(src, i);
      const inner = src.slice(i + 1, end);
      const parts = PLACEHOLDER.exec(inner);
      if (!parts) throw new Error(`Bad placeholder "${inner}"`);
      const name = parts[1]!;
      const kind = parts[2];
      const value = values[name];
      if (value === undefined) {
        text += src.slice(i, end + 1); // keep it visible; never invent text
      } else if (!kind) {
        text += String(value);
      } else {
        const map = branches(parts[3] ?? '');
        let key: string;
        if (kind === 'plural') {
          const n = Number(value);
          key = map.has(`=${n}`) ? `=${n}` : n === 1 ? 'one' : 'other';
        } else {
          key = map.has(String(value)) ? String(value) : 'other';
        }
        const branch = map.get(key) ?? map.get('other');
        if (branch === undefined) throw new Error(`No "other" branch in "${name}"`);
        text += render(branch, values, kind === 'plural' ? Number(value) : hash);
      }
      i = end + 1;
    } else {
      text += c;
      i++;
    }
  }
  return text;
}

/** Fill a message template. Missing values leave their placeholder visible. */
export function formatMessage(template: string, values: MessageValues = {}): string {
  return render(template, values, undefined);
}
