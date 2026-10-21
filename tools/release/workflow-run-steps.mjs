// The shell commands of a GitHub Actions workflow's `run:` steps, for the deploy workflow tests
// (OPS-PRIV-1). The repository has no general YAML parser (tools/docs-status/yaml.mjs reads only
// the status-file subset, without block scalars), and a workflow's `run:` keys are the only part
// these checks need, so this reads exactly those and fails closed on any form it does not know:
//   `run: <plain scalar>`, `run: "<quoted>"`, `run: '<quoted>'`, and block scalars `run: |` / `>`
//   (with an optional chomping indicator; a `>` block is folded with spaces), as a mapping key or
//   a sequence entry (`- run: ...`).
// Anything else after `run:` (an empty value, a plain scalar continued on a more-indented line, a
// flow form) throws.

const RUN_KEY = /^( *)(- +)?run:(?:[ \t]+(.*))?$/;

/** Every `run:` script in `source`, in order, with its 1-based line number. */
export function runScripts(source) {
  const lines = source.split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = RUN_KEY.exec(lines[i]);
    if (!match) continue;
    const keyColumn = match[1].length + (match[2]?.length ?? 0);
    const value = (match[3] ?? '').trim();
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() !== '' && line.length - line.trimStart().length <= keyColumn) break;
        body.push(line);
      }
      const indents = body
        .filter((l) => l.trim() !== '')
        .map((l) => l.length - l.trimStart().length);
      const strip = indents.length > 0 ? Math.min(...indents) : 0;
      const text = body.map((l) => l.slice(strip)).join('\n');
      // A folded (`>`) block joins its lines with spaces; a blank line stays a line break.
      const script = value.startsWith('>') ? text.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : text;
      scripts.push({ line: i + 1, script });
      i = j - 1;
    } else if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) {
        throw new Error(`workflow line ${String(i + 1)}: unsupported quoted run value`);
      }
      scripts.push({ line: i + 1, script: value.slice(1, -1) });
    } else if (value !== '' && !/^[[{&*!%@`]/.test(value)) {
      // A plain scalar may continue on more-indented lines; refuse that instead of reading half.
      const next = lines[i + 1] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length > keyColumn) {
        throw new Error(`workflow line ${String(i + 2)}: unsupported multi-line plain run value`);
      }
      scripts.push({ line: i + 1, script: value.replace(/\s+#.*$/, '') });
    } else {
      throw new Error(`workflow line ${String(i + 1)}: unsupported run value`);
    }
  }
  return scripts;
}

/** The logical command lines of a script: continuations joined, comments and blanks dropped. */
export function commandLines(script) {
  return script
    .replace(/[ \t]*\\\n[ \t]*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Every wrangler invocation in a command line (`wrangler`, `pnpm exec wrangler`, `npx wrangler`
 * and the like all contain the word `wrangler` followed by a subcommand), with the rest of the line.
 * `wrangler.toml` and `WRANGLER_*` variables are not invocations.
 */
export function wranglerCalls(line) {
  return [
    ...line.matchAll(/(?<![\w./-])wrangler[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/g),
  ].map((m) => ({ subcommand: m[1], next: m[2] ?? '', text: line.slice(m.index) }));
}

/** True for a wrangler call that uploads or deploys a Worker version. */
export function isDeployCall({ subcommand, next }) {
  return (
    subcommand === 'deploy' || (subcommand === 'versions' && ['deploy', 'upload'].includes(next))
  );
}
