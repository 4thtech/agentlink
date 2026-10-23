// The headers of the invite host (08 §4), read from the `_headers` file in site/.

/** 08 §4, verbatim. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

/** The headers a path gets from `_headers`: every `/*`-style block that matches, merged. */
export function headersFor(file: string, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let applies = false;
  for (const line of file.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const rule = line.trim();
      applies = rule === '/*' || rule === path;
      continue;
    }
    if (!applies) continue;
    const at = line.indexOf(':');
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}
