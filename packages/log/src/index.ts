// @agentlink/log: the shared redacting logger (04 §1 I-7, §8.4). Zero dependencies; runs in Node,
// browsers and Workers. The canary test helper lives in "@agentlink/log/testing".

export { consoleSink, type ConsoleSinkOptions } from './console.js';
export {
  createLogger,
  LEVELS,
  type Fields,
  type Level,
  type Logger,
  type LoggerOptions,
  type Sink,
} from './logger.js';
export {
  isSensitiveKey,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  redact,
  REDACTED,
  redactString,
  SENSITIVE_KEYS,
  stripUrls,
  type JsonValue,
} from './redact.js';
