// A small ICU MessageFormat subset for the copy sheet (11 §5.4): `{name}` and
// `{count, plural, one {…} other {…}}` with `#` for the count. Rendering is one pass over the
// parsed template, so a substituted value is never parsed again: a value that contains `{x}` or
// `#` comes out literally (inbound text can never add or expand a placeholder, I-5).

export type CopyValue = string | number;
export type CopyParams = Readonly<Record<string, CopyValue>>;

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'arg'; name: string }
  | { kind: 'plural'; name: string; one: Node[]; other: Node[] }
  | { kind: 'hash' };

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parseAll(): Node[] {
    const nodes = this.parseNodes(false, false);
    if (this.pos < this.src.length) throw new Error('unbalanced "}" in copy template');
    return nodes;
  }

  private parseNodes(inBranch: boolean, hashIsCount: boolean): Node[] {
    const nodes: Node[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') nodes.push({ kind: 'text', text });
      text = '';
    };
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos);
      if (ch === '}') {
        if (inBranch) break;
        throw new Error('unbalanced "}" in copy template');
      }
      if (ch === '{') {
        flush();
        this.pos += 1;
        nodes.push(this.parseArgument());
        continue;
      }
      if (ch === '#' && hashIsCount) {
        flush();
        nodes.push({ kind: 'hash' });
        this.pos += 1;
        continue;
      }
      text += ch;
      this.pos += 1;
    }
    flush();
    return nodes;
  }

  private parseArgument(): Node {
    const close = this.src.indexOf('}', this.pos);
    const comma = this.src.indexOf(',', this.pos);
    if (close === -1) throw new Error('unterminated "{" in copy template');
    if (comma === -1 || comma > close) {
      const name = this.src.slice(this.pos, close).trim();
      if (!NAME.test(name)) throw new Error(`bad placeholder name "${name}"`);
      this.pos = close + 1;
      return { kind: 'arg', name };
    }
    const name = this.src.slice(this.pos, comma).trim();
    if (!NAME.test(name)) throw new Error(`bad placeholder name "${name}"`);
    this.pos = comma + 1;
    const kindEnd = this.src.indexOf(',', this.pos);
    if (kindEnd === -1 || this.src.slice(this.pos, kindEnd).trim() !== 'plural') {
      throw new Error('only plural arguments are supported');
    }
    this.pos = kindEnd + 1;
    const branches: Record<string, Node[]> = {};
    for (;;) {
      while (this.src.charAt(this.pos) === ' ') this.pos += 1;
      if (this.src.charAt(this.pos) === '}') {
        this.pos += 1;
        break;
      }
      const open = this.src.indexOf('{', this.pos);
      if (open === -1) throw new Error('plural branch without "{"');
      const selector = this.src.slice(this.pos, open).trim();
      if (selector !== 'one' && selector !== 'other') {
        throw new Error(`unsupported plural selector "${selector}"`);
      }
      this.pos = open + 1;
      branches[selector] = this.parseNodes(true, true);
      if (this.src.charAt(this.pos) !== '}') throw new Error('unterminated plural branch');
      this.pos += 1;
    }
    const { one, other } = branches;
    if (one === undefined || other === undefined) {
      throw new Error('plural needs "one" and "other"');
    }
    return { kind: 'plural', name, one, other };
  }
}

const parsed = new Map<string, Node[]>();

function parse(template: string): Node[] {
  let nodes = parsed.get(template);
  if (nodes === undefined) {
    nodes = new Parser(template).parseAll();
    parsed.set(template, nodes);
  }
  return nodes;
}

function collect(nodes: readonly Node[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'arg') into.add(node.name);
    if (node.kind === 'plural') {
      into.add(node.name);
      collect(node.one, into);
      collect(node.other, into);
    }
  }
}

/** The placeholder names a template uses (also validates its syntax). */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>();
  collect(parse(template), names);
  return [...names].sort();
}

function renderNodes(
  nodes: readonly Node[],
  params: CopyParams,
  count: number | undefined,
  out: string[],
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'hash':
        out.push(String(count));
        break;
      case 'arg':
        out.push(String(params[node.name]));
        break;
      case 'plural': {
        const n = params[node.name];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
          throw new Error(`placeholder "${node.name}" must be a non-negative integer`);
        }
        renderNodes(n === 1 ? node.one : node.other, params, n, out);
        break;
      }
    }
  }
}

/**
 * Renders a template. Strict: every placeholder must be supplied and no extra value may be
 * passed, so a template and its caller cannot drift apart silently.
 */
export function renderCopy(template: string, params: CopyParams = {}): string {
  const wanted = placeholdersOf(template);
  const given = Object.keys(params).sort();
  const missing = wanted.filter((name) => !given.includes(name));
  const extra = given.filter((name) => !wanted.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `copy parameters do not match the template (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
  const out: string[] = [];
  renderNodes(parse(template), params, undefined, out);
  return out.join('');
}
