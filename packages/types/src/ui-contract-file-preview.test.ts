// REL051-A34 (D-149; 08 §1): the safe in-app preview of a received text file. The contract the
// local server and the page share: the one path, the size cap, and the kind a file name gives.
//
// - The kind comes only from the sanitised name's last extension, lower-cased, from a fixed table;
//   the sender's MIME type is never consulted (it is untrusted, I-5).
// - Anything not on the table (binary, archives, images, executables, `.download`, no extension,
//   a dot file) has no kind and is never previewed.
import { describe, expect, it } from 'vitest';
import {
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_PATH,
  PREVIEW_KINDS,
  previewKindOf,
} from './ui-contract/file-preview.js';

describe('file preview contract (REL051-A34, D-149)', () => {
  it('has one fixed read path under the received files and a 256 KB cap', () => {
    expect(FILE_PREVIEW_PATH).toBe('/api/ui/files/received/preview');
    expect(FILE_PREVIEW_MAX_BYTES).toBe(256 * 1024);
    expect([...PREVIEW_KINDS]).toEqual(['markdown', 'code', 'json', 'patch', 'text']);
  });

  it('derives the kind from the last extension only', () => {
    expect(previewKindOf('plan.md')).toBe('markdown');
    expect(previewKindOf('ARCHITECTURE.MARKDOWN')).toBe('markdown');
    expect(previewKindOf('index.ts')).toBe('code');
    expect(previewKindOf('app.tsx')).toBe('code');
    expect(previewKindOf('main.py')).toBe('code');
    expect(previewKindOf('lib.rs')).toBe('code');
    expect(previewKindOf('build.sh')).toBe('code');
    expect(previewKindOf('page.html')).toBe('code');
    expect(previewKindOf('package.json')).toBe('json');
    expect(previewKindOf('fix.patch')).toBe('patch');
    expect(previewKindOf('fix.diff')).toBe('patch');
    expect(previewKindOf('notes.txt')).toBe('text');
    expect(previewKindOf('data.csv')).toBe('text');
  });

  it('gives no kind to anything else', () => {
    for (const name of [
      'tool.exe',
      'tool.exe.download',
      'plan.md.download',
      'photo.png',
      'archive.zip',
      'doc.pdf',
      'README',
      '.env',
      '.md',
      'plan.',
      '',
      'a'.repeat(300) + '.md',
    ]) {
      expect(previewKindOf(name), name).toBeUndefined();
    }
  });
});
