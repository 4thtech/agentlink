// Preview mode is a BUILD-TIME constant absent from release builds (plan Decision 3, Fable H1).
// Bundles src/main/main.ts the way a release build does (define `false`, minified) and checks that no
// preview variable name survives; with `true` (a preview build) they are present. WP-D4's packaging
// and WP-D5's CI grep run the same check on the real ASAR.
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));
const PREVIEW_NAMES = [
  'AGENTLINK_DESKTOP_PREVIEW',
  'AGENTLINK_DESKTOP_PREVIEW_NODE',
  'AGENTLINK_DESKTOP_PREVIEW_HOST',
];

async function bundle(preview: boolean): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: { __AGENTLINK_DESKTOP_PREVIEW__: JSON.stringify(preview) },
    build: {
      ssr: ENTRY,
      write: false,
      minify: true,
      rollupOptions: { external: [/^node:/] },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : String(chunk.source)))
    .join('\n');
}

describe('preview mode in the bundle', () => {
  it('a release build (constant false) contains no preview variable name', async () => {
    const code = await bundle(false);
    expect(code.length).toBeGreaterThan(1000);
    for (const name of PREVIEW_NAMES) expect(code).not.toContain(name);
  });

  it('a preview build (constant true) contains them', async () => {
    const code = await bundle(true);
    expect(code).toContain('AGENTLINK_DESKTOP_PREVIEW');
  });
});
