// The installed AgentLink program a session hook may call (M1-29; 06 §7, D-53). The hook runs code at
// every session start, so it points at the absolute path of the copy that is installed now, never at
// `npx` (which can fetch a newer package) and never at npx's temporary cache. Nothing here runs the
// program; it only checks that the path is a real file of the AgentLink package.
import { realpath, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { PACKAGE_NAME } from './harnesses.js';

/** Characters that change meaning inside a double-quoted shell word (or cannot be quoted at all). */
const UNQUOTABLE = /["$`\r\n\0%]/;

async function isAgentlinkPackageAbove(script: string): Promise<boolean> {
  let dir = dirname(script);
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const name = (parsed as { name?: unknown } | null)?.name;
      return name === PACKAGE_NAME;
    } catch {
      // No package.json here (or unreadable): look one folder up.
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * `"<node>" "<script>"` for the installed program, ready to be followed by arguments, or `undefined`
 * when there is no safe installed copy to point at: a relative or missing path, the temporary npx
 * copy, a script outside the AgentLink package, or a path that cannot be quoted safely.
 */
export async function resolveInstalledCli(
  script: string | undefined,
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (script === undefined || !isAbsolute(script) || !isAbsolute(nodePath)) return undefined;
  let real: string;
  try {
    real = await realpath(script);
    if (!(await stat(real)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const inNpxCache = (path: string): boolean => path.split(sep).includes('_npx');
  if (inNpxCache(script) || inNpxCache(real)) return undefined;
  const bad = (path: string): boolean =>
    UNQUOTABLE.test(path) || (platform !== 'win32' && path.includes('\\'));
  if (bad(real) || bad(nodePath)) return undefined;
  if (!(await isAgentlinkPackageAbove(real))) return undefined;
  return `"${nodePath}" "${real}"`;
}
