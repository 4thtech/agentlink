// M1-9y: the Node.js version check. It runs before anything else loads, because on an old Node the
// native modules (keychain, SQLite) can crash the process with no message at all (seen on Node
// 22.13.1: a segmentation fault). This file imports nothing.

/** The oldest Node.js the CLI supports. Keep in step with `engines.node` in package.json. */
export const MIN_NODE = '22.14.0';

function parts(version: string): number[] {
  const numbers = version
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  while (numbers.length < 3) numbers.push(0);
  return numbers.map((n) => (Number.isFinite(n) ? n : 0));
}

/** True when `version` (like "22.13.1" or "v22.13.1") is older than `minimum`. */
export function isNodeTooOld(version: string, minimum: string = MIN_NODE): boolean {
  const have = parts(version);
  const need = parts(minimum);
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * The one line for the user (11 §5 vocabulary), or undefined when this Node is new enough. The
 * caller writes it to stderr only (an MCP server keeps stdout for the protocol) and exits non-zero.
 */
export function checkNodeVersion(
  version: string = process.versions.node,
  minimum: string = MIN_NODE,
): string | undefined {
  if (!isNodeTooOld(version, minimum)) return undefined;
  const shown = minimum.replace(/\.0$/, '');
  return `AgentLink needs Node.js ${shown} or newer; you have v${version.replace(/^v/, '')}. Update Node (nodejs.org, or \`nvm install --lts\`) and try again.`;
}
