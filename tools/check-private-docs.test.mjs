// DOCS-COMPACT-A: tests for check-private-docs.mjs.
import { describe, expect, it } from 'vitest';
import { findPrivateDocs } from './check-private-docs.mjs';

describe('findPrivateDocs', () => {
  it('finds the private specs under the old path, the new path and anywhere else', () => {
    expect(
      findPrivateDocs([
        'docs/foundation/01-commercial-brief.md',
        'specs/09-repositories-and-reuse.md',
        'specs/01-pricing-draft.md',
        'docs/foundation/09-something.md',
        'notes/09-Repositories-And-Reuse.md',
        'specs/04-security-and-crypto.md',
        'specs/decisions/01-first.md',
        'docs/process/01-x.md',
      ]),
    ).toEqual([
      'docs/foundation/01-commercial-brief.md',
      'specs/09-repositories-and-reuse.md',
      'specs/01-pricing-draft.md',
      'docs/foundation/09-something.md',
      'notes/09-Repositories-And-Reuse.md',
    ]);
  });
});
