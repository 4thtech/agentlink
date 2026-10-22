// The MCP binding (06 §1, D-73 (1); M1-9c): the tool registry on the official MCP TypeScript SDK's
// low-level `Server`. The registry's JSON Schemas are served as they are (no conversion), so what
// the client sees is exactly the frozen surface (registry.ts, the I-4 snapshot).
//
// - `tools/list` returns every registered tool with `inputSchema`, `outputSchema`, `title` and all
//   four annotations (06 §2.0).
// - `tools/call` runs `callTool` and returns `structuredContent` plus one text block (06 §1 rules
//   2 and 3, §4). Results are status-driven, never protocol errors (rule 3).
// - The server instructions are 06 §5, verbatim. No tool list change is ever announced: the list is
//   fixed for the life of the process.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool, TOOLS, type HandlerEnvironment, type ToolDefinition } from '../tools/index.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

/** The server name in `initialize` (06: binary `agentlink`, subcommand `mcp`). */
export const SERVER_NAME = 'agentlink';

/** A registry entry as an MCP `Tool`. */
export function toMcpTool(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    outputSchema: tool.outputSchema as Tool['outputSchema'],
    annotations: { title: tool.title, ...tool.annotations },
  };
}

/** M1-36j: the per-harness approval wait (approval-wait.ts). Absent: no wait. */
export interface McpServerOptions {
  /** The wait in ms for the client's `clientInfo.name` (undefined before `initialize`). */
  readonly approvalWaitMs?: (clientName: string | undefined) => number;
  /** The approval read interval (tests). */
  readonly approvalWaitIntervalMs?: number;
}

export function createMcpServer(
  env: HandlerEnvironment,
  version: string,
  options: McpServerOptions = {},
): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );
  const tools = TOOLS.map(toMcpTool);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const clientName = server.getClientVersion()?.name;
      const finished = await callTool(request.params.name, request.params.arguments, env, {
        signal: extra.signal,
        approvalWaitMs: options.approvalWaitMs?.(clientName) ?? 0,
        ...(options.approvalWaitIntervalMs === undefined
          ? {}
          : { approvalWaitIntervalMs: options.approvalWaitIntervalMs }),
      });
      return {
        content: [{ type: 'text', text: finished.text }],
        structuredContent: { ...finished.structured },
      };
    },
  );
  return server;
}
