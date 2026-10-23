// M1-35c: the shipped English strings (11 §5, DESIGN-ADJ-1 (a) copy items).
import { en, type StringKey } from './en.js';
import { formatMessage, type MessageValues } from './format.js';

export { en, type StringKey } from './en.js';
export { formatMessage, type MessageValues } from './format.js';
export { NEVER_SAY, isExemptKey, lintVocabulary, type LintOptions } from './lint.js';
export { pendingStrings, type PendingString } from './pending.js';

/** Look a string up by key and fill its placeholders. */
export function t(key: StringKey, values?: MessageValues): string {
  return formatMessage(en[key], values);
}
