// Suite `invite-link` (M1-7c; 04 §3.6 encoding, D-69, G-12): the one invite codec of
// @4thtech-io/core, run from source. `decodeInviteLink` gives the strictly valid invite, compared as
// its JCS text, or refuses with `invite_invalid` (`outcome: reject`). Any other error is a bug and
// fails the case. The decoder uses the platform DecompressionStream("deflate-raw"), so this suite
// checks every decoder step in Node, the three browsers and workerd.
import { decodeInviteLink } from '@4thtech-io/core/invite-link';
import { canonicalize, type JsonValue } from '@4thtech-io/crypto';
import type { Comparison, SuiteModule } from '../suite';

function parseInput(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (i?.op === 'decodeInviteLink' && typeof i.link === 'string') return i.link;
  throw new TypeError('invite-link: input does not match any op of case.schema.json');
}

const isRefusal = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly code?: unknown }).code === 'invite_invalid';

export const inviteLink: SuiteModule = {
  async evaluate(testCase): Promise<readonly Comparison[]> {
    const link = parseInput(testCase.input);
    try {
      const invite = await decodeInviteLink(link);
      return [{ field: 'inviteJcs', actual: canonicalize(invite as unknown as JsonValue) }];
    } catch (error) {
      if (isRefusal(error)) return [{ field: 'outcome', actual: 'reject' }];
      throw error;
    }
  },
};
