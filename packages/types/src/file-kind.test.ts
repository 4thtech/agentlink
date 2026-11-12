// REL051-A12 (WP-A2): the file type table. The sender labels a file by its extension; the receiver
// derives the kind from the name itself and never trusts the sender's MIME type.
import { describe, expect, it } from 'vitest';
import {
  FILE_KINDS,
  FILE_KIND_LABELS,
  FILE_TEXT_MAX_BYTES,
  fileKindOf,
  isTextKind,
  mimeForName,
  textOfFile,
} from './file-kind.js';

describe('mimeForName (sender, by extension)', () => {
  it.each([
    ['plan.md', 'text/markdown'],
    ['README.markdown', 'text/markdown'],
    ['notes.txt', 'text/plain'],
    ['data.json', 'application/json'],
    ['fix.patch', 'text/x-diff'],
    ['fix.diff', 'text/x-diff'],
    ['main.ts', 'text/plain'],
    ['app.py', 'text/plain'],
    ['shot.png', 'image/png'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['pic.webp', 'image/webp'],
    ['tool.exe', 'application/octet-stream'],
    ['archive.tar.gz', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
    ['.md', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ])('%s → %s', (name, mime) => {
    expect(mimeForName(name)).toBe(mime);
  });

  it('every MIME it gives passes the payload MIME pattern', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
    for (const name of ['a.md', 'a.json', 'a.patch', 'a.ts', 'a.png', 'a.bin', 'a.csv']) {
      expect(mimeForName(name)).toMatch(pattern);
    }
  });
});

describe('fileKindOf (receiver, from the name only)', () => {
  it.each([
    ['plan.md', 'markdown'],
    ['PLAN.MD', 'markdown'],
    ['notes.txt', 'text'],
    ['run.log', 'text'],
    ['main.ts', 'code'],
    ['App.tsx', 'code'],
    ['script.py', 'code'],
    ['lib.rs', 'code'],
    ['Makefile', 'code'],
    ['data.json', 'json'],
    ['fix.patch', 'patch'],
    ['fix.diff', 'patch'],
    ['shot.png', 'image'],
    ['report.pdf', 'other'],
    ['tool.exe', 'other'],
    ['noext', 'other'],
    ['', 'other'],
    // The `.download` the receiver adds to OS-actionable names (04 §4.1) is not the type.
    ['app.js.download', 'code'],
    ['tool.exe.download', 'other'],
    // A suffix the receiver adds to a taken name keeps the extension.
    ['plan (2).md', 'markdown'],
    // Paths and look-alikes never steer it.
    ['../../etc/passwd', 'other'],
    ['dir/plan.md', 'markdown'],
    ['plan.md‮', 'other'],
    ['plan.m\u0000d', 'other'],
    ['plan.ｍｄ', 'other'],
  ])('%j → %s', (name, kind) => {
    expect(fileKindOf(name)).toBe(kind);
  });

  it('a non-string is other', () => {
    expect(fileKindOf(undefined as unknown as string)).toBe('other');
  });

  it('text kinds are markdown, text, code, json and patch; every kind has a label', () => {
    expect(FILE_KINDS.filter(isTextKind)).toEqual(['markdown', 'text', 'code', 'json', 'patch']);
    for (const kind of FILE_KINDS) expect(FILE_KIND_LABELS[kind]).toMatch(/^[A-Z]/);
    expect(FILE_KIND_LABELS.markdown).toBe('Markdown');
  });
});

describe('textOfFile (valid UTF-8, no NUL, at most 64 KB)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('valid UTF-8 text comes back as it is', () => {
    expect(textOfFile(enc('# Plan\n\n- step ✓\n'))).toBe('# Plan\n\n- step ✓\n');
    expect(textOfFile(new Uint8Array(0))).toBe('');
  });

  it('invalid UTF-8 or a NUL byte is not text', () => {
    expect(textOfFile(new Uint8Array([0x23, 0xff, 0xfe]))).toBeUndefined();
    expect(textOfFile(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined();
  });

  it('the cap is 65 536 bytes: at the cap text, one byte more not', () => {
    expect(FILE_TEXT_MAX_BYTES).toBe(65_536);
    expect(textOfFile(new Uint8Array(FILE_TEXT_MAX_BYTES).fill(0x61))).toHaveLength(65_536);
    expect(textOfFile(new Uint8Array(FILE_TEXT_MAX_BYTES + 1).fill(0x61))).toBeUndefined();
  });
});
