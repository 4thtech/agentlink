// The MCP binding (M1-9c): the stdio server for `agentlink mcp` over the runtime-agnostic tool
// module in packages/mcp-tools/src/.
export { SERVER_INSTRUCTIONS } from './instructions.js';
export { SERVER_NAME, createMcpServer, toMcpTool } from './server.js';
export { agentToolContext, createMcpCommand, mcpCommand, type McpCommandDeps } from './command.js';
export {
  BackgroundLoop,
  INBOX_RESOURCE_URI,
  attachInboxResource,
  type BackgroundLoopOptions,
  type LoopClient,
  type LoopLease,
  type LoopTimers,
} from './loop.js';
