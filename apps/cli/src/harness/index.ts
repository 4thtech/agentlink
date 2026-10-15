// Harness detection and config writers for `agentlink init` (M1-9a).
export { unifiedDiff } from './diff.js';
export { HARNESS_MESSAGES, HarnessError, type HarnessErrorCode } from './errors.js';
export { MAX_CONFIG_BYTES } from './files.js';
export {
  HARNESSES,
  PACKAGE_NAME,
  applyHarness,
  detectHarnesses,
  displayPath,
  planHarness,
  type HarnessContext,
  type HarnessId,
  type HarnessPlan,
} from './harnesses.js';
export { addJsonMcpServer, type JsonEdit } from './json-config.js';
export { addTomlMcpServer, agentlinkTable, scanToml, type TomlEdit } from './toml-config.js';
