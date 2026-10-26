// Read-only file settings for the local UI (M1-11r-a; drop usage M1-11r-c). Display paths only: never a file's contents,
// a storage credential, a URL or a file key (zero access). The platform resolves each folder (04 §4);
// a platform failure resolves nothing, and its error text is never passed on (I-7).
import type { CoreContext } from '../context.js';
import { policyLimits, type EffectivePolicy } from '../policy-engine.js';
import type { FilesPlatform } from './platform.js';
import { readDropUsage, type DropUsage } from './usage.js';

/** The rules' `files.allowedFolders` as written, and the realpath of each that exists. */
export interface ResolvedFolders {
  readonly configured: readonly string[];
  readonly resolved: readonly string[];
}

export class FilesView {
  readonly #ctx: CoreContext;
  readonly #platform: FilesPlatform | undefined;
  readonly #policy: () => Promise<EffectivePolicy>;

  constructor(
    ctx: CoreContext,
    platform: FilesPlatform | undefined,
    policy: () => Promise<EffectivePolicy>,
  ) {
    this.#ctx = ctx;
    this.#platform = platform;
    this.#policy = policy;
  }

  /**
   * The allowed folders of the effective rules (none while they fail closed) and their realpaths.
   * Without a files platform, nothing is resolved.
   */
  async resolvedFolders(): Promise<ResolvedFolders> {
    const configured = Object.freeze([...policyLimits(await this.#policy()).allowedFolders]);
    let resolved: readonly string[] = [];
    if (this.#platform !== undefined && configured.length > 0) {
      try {
        resolved = [...(await this.#platform.allowedFolderRealpaths(configured))];
      } catch {
        this.#ctx.log.warn('allowed folders not resolved');
        resolved = [];
      }
    }
    return Object.freeze({ configured, resolved: Object.freeze(resolved) });
  }

  /**
   * The drop's weekly usage for the Storage page (files/usage.ts): ciphertext bytes this agent
   * reserved in the rolling 7 days against the quota. Numbers only (I-7).
   */
  dropUsage(): Promise<DropUsage> {
    return readDropUsage(this.#ctx, this.#platform);
  }
}
