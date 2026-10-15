// A line diff for the "exact diff" the user confirms (D-39, 06 §7). Zero context lines: only the
// lines that change are printed, so other servers' settings (which may hold keys in `env`) are not
// echoed into a terminal or an agent transcript beyond the lines that really change.

/** The largest grid the minimal diff is computed on; a bigger change is shown as one replacement. */
const MAX_GRID = 4_000_000;

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function script(before: string[], after: string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const ops: Op[] = before.slice(0, head).map((line) => ({ kind: ' ', line }));

  if (a.length * b.length > MAX_GRID) {
    for (const line of a) ops.push({ kind: '-', line });
    for (const line of b) ops.push({ kind: '+', line });
  } else {
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ kind: ' ', line: a[i] ?? '' });
        i += 1;
        j += 1;
      } else if (at(i + 1, j) >= at(i, j + 1)) {
        ops.push({ kind: '-', line: a[i] ?? '' });
        i += 1;
      } else {
        ops.push({ kind: '+', line: b[j] ?? '' });
        j += 1;
      }
    }
    for (; i < a.length; i += 1) ops.push({ kind: '-', line: a[i] ?? '' });
    for (; j < b.length; j += 1) ops.push({ kind: '+', line: b[j] ?? '' });
  }
  for (const line of before.slice(before.length - tail)) ops.push({ kind: ' ', line });
  return ops;
}

/**
 * The unified diff (no context) between two texts, as display lines: `--- a/<label>`,
 * `+++ b/<label>`, then one `@@ -a,b +c,d @@` header and the `-`/`+` lines per changed block.
 * Returns an empty list when the texts are equal.
 */
export function unifiedDiff(before: string, after: string, label: string): string[] {
  if (before === after) return [];
  const ops = script(splitLines(before), splitLines(after));
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op === undefined) break;
    if (op.kind === ' ') {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }
    const block: Op[] = [];
    for (let next = ops[index]; next !== undefined && next.kind !== ' '; next = ops[index]) {
      block.push(next);
      index += 1;
    }
    const removed = block.filter((o) => o.kind === '-').length;
    const added = block.filter((o) => o.kind === '+').length;
    // With no lines on one side, the unified format names the line before the block.
    const oldStart = removed === 0 ? oldLine : oldLine + 1;
    const newStart = added === 0 ? newLine : newLine + 1;
    out.push(`@@ -${oldStart},${removed} +${newStart},${added} @@`);
    for (const o of block) out.push(`${o.kind}${o.line}`);
    oldLine += removed;
    newLine += added;
  }
  return out;
}
