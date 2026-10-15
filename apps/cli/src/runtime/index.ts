// The CLI runtime (M1-9k): opening an agent, the agent directory, the agent-name rule and the
// terminal guards. Commands and the `agentlink mcp` server use only this entry.
export { AGENT_NAME_PATTERN, DEFAULT_AGENT_NAME, isAgentName } from './agent-name.js';
export {
  CONFIG_FILE,
  STORE_FILE,
  agentPaths,
  listAgentNames,
  parseAgentConfig,
  readAgentConfig,
  writeAgentConfig,
  type AgentConfig,
  type AgentPaths,
} from './agent-dir.js';
export { RUNTIME_MESSAGES, RuntimeError, type RuntimeErrorCode } from './errors.js';
export {
  HARNESS_MARKERS,
  checkOwnerTerminal,
  harnessMarkerSet,
  isInteractive,
  type Env,
  type OwnerTerminalCheck,
  type TerminalContext,
} from './guards.js';
export {
  NO_AGENT_MESSAGE,
  nodeRuntimeDeps,
  openAgent,
  type OpenAgentOptions,
  type OpenAgentResult,
  type OpenedAgent,
  type RuntimeDeps,
} from './open-agent.js';
