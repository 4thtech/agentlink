// The cloud agent Worker entry (08 §3.1; M2-3a). It exports only what the Workers runtime expects:
// the default handler and the AgentDO class named in wrangler.toml.
//
// M2-3a serves only `/health`, which answers "ok" and nothing about the agent. `/mcp` (M2-3b), the
// OAuth endpoints (M2-3c) and the owner pages (M2-3f) are later cards; every other path is 404. The
// Worker reaches AgentDO only as `idFromName("agent")` (06 §6: one publisher per deployment).
import { AgentDO } from './agent-do.js';

export { AgentDO };

const NO_STORE = { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' };

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : 'ok', {
        status: 200,
        headers: NO_STORE,
      });
    }
    return new Response('Not found', { status: 404, headers: NO_STORE });
  },
};
