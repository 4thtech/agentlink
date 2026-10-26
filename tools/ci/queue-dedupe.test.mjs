import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CHORE-CI-QUEUE-DEDUPE: the merge queue already runs a workflow as `merge_group`; the same
// commit on its `gh-readonly-queue/**` branch must not run it a second time as `push`.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');

function read(file) {
  return readFileSync(join(dir, file), 'utf8');
}

function pushBlock(file) {
  const m = read(file).match(/^on:\n([\s\S]*?)^\S/m);
  const p = (m ? m[1] : '').match(/^ {2}push:\n((?: {4}.*\n|\n)*)/m);
  return p ? p[1] : null;
}

describe('push triggers skip merge-queue branches', () => {
  it('ci.yml ignores gh-readonly-queue/** pushes but keeps sync ignored and merge_group', () => {
    const block = pushBlock('ci.yml');
    expect(block).toMatch(/branches-ignore:.*sync/);
    expect(block).toMatch(/branches-ignore:.*gh-readonly-queue\/\*\*/);
    expect(read('ci.yml')).toMatch(/^ {2}merge_group:/m);
  });
  it('secret-scan-branches.yml ignores gh-readonly-queue/** (security.yml covers merge_group)', () => {
    expect(pushBlock('secret-scan-branches.yml')).toMatch(
      /branches-ignore:.*gh-readonly-queue\/\*\*/,
    );
    expect(read('security.yml')).toMatch(/^ {2}merge_group:/m);
  });
});
