// The MCP binding (M1-9c): the stdio server for `agentlink mcp` over the runtime-agnostic tool
// module in src/tools/.
export { SERVER_INSTRUCTIONS } from './instructions.js';
export { SERVER_NAME, createMcpServer, toMcpTool } from './server.js';
export { agentToolContext, createMcpCommand, mcpCommand, type McpCommandDeps } from './command.js';
