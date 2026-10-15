// Loader hook (`--experimental-loader`) for tests that run the CLI from source in a child process
// they cannot give environment variables (the MCP Inspector CLI, inspector-cli.test.ts): it maps a
// `./x.js` specifier from apps/cli/src to its `./x.ts` source when no .js file exists, so the child
// needs no build. Same mapping as module-trace-hooks.mjs, without the tracing.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const fromSource = context.parentURL?.includes('/apps/cli/src/') === true;
    if (!fromSource || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
    return next(`${specifier.slice(0, -3)}.ts`, context);
  }
}
