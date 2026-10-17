// Harness detection and config writers for `agentlink init` (M1-9a).
export { unifiedDiff } from './diff.js';
export { HARNESS_MESSAGES, HarnessError, type HarnessErrorCode } from './errors.js';
export { MAX_CONFIG_BYTES } from './files.js';
export {
  CONFIG_PATH_HARNESSES,
  HARNESSES,
  HARNESS_IDS,
  PACKAGE_NAME,
  applyHarness,
  configParts,
  detectHarnesses,
  displayPath,
  harnessById,
  isHarnessId,
  planHarness,
  resolveConfigTarget,
  type ConfigTarget,
  type HarnessContext,
  type HarnessDef,
  type HarnessId,
  type HarnessPlan,
} from './harnesses.js';
export { addJsonMcpServer, type JsonEdit } from './json-config.js';
export { addTomlMcpServer, agentlinkTable, scanToml, type TomlEdit } from './toml-config.js';
