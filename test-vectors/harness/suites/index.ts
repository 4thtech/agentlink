import type { SuiteModule } from '../suite';
import { placeholderSha256 } from './placeholder-sha256';

/** Suite name (= directory under test-vectors/) to suite module. A vector file without one fails. */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['placeholder-sha256', placeholderSha256],
]);
