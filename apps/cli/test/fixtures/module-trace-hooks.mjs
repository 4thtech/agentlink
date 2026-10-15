// Module-load trace hooks for the `agentlink mcp` module-graph guard (mcp-module-graph.test.ts;
// IR-M1-9c-1 F02), loaded with `--experimental-loader`. They run off the main thread and:
// - record the URL of every module the ESM loader resolves, appended to the trace file;
// - map a `./x.js` specifier from apps/cli/src to its `./x.ts` source when no .js file exists, so
//   the child runs the CLI from source (with --experimental-transform-types) and needs no build.
// CommonJS loads (require inside packages such as ajv) are traced by the parent through
// NODE_DEBUG=module on stderr.
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const traceFile = process.env.AGENTLINK_MODULE_TRACE;
if (traceFile === undefined) throw new Error('AGENTLINK_MODULE_TRACE is not set');

export async function resolve(specifier, context, next) {
  let result;
  try {
    result = await next(specifier, context);
  } catch (error) {
    const fromSource = context.parentURL?.includes('/apps/cli/src/') === true;
    if (!fromSource || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
    result = await next(`${specifier.slice(0, -3)}.ts`, context);
  }
  appendFileSync(traceFile, `${result.url}\n`);
  return result;
}
