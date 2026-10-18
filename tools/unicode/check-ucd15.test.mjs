// M1-21-b (D-74, D-77): the UCD 15.0.0 table of @4thtech-io/types is generated from the vendored
// DerivedGeneralCategory.txt only, and the `pnpm lint` drift check fails on an edited table entry,
// on an edited vendored file and on an edited pinned hash, and passes on the committed state.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATOR = 'tools/unicode/generate_ucd15_table.py';
const CHECK = 'tools/unicode/check-ucd15.mjs';
const SOURCE = 'tools/unicode/ucd-15.0.0/DerivedGeneralCategory.txt';
const SUMS = 'tools/unicode/ucd-15.0.0/SHA256SUMS';
const TABLE = 'packages/types/src/ucd15.ts';
const PINNED = 'fe29a45c0882500e591140aaa5c4f5067e6a5d746806148af34400c48b9c06f9';
// Any python3: the generator needs no unicodedata, so its version must not matter.
const python = process.env.UCD_PYTHON || 'python3';

const dir = mkdtempSync(join(tmpdir(), 'ucd15-drift-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (path) => readFileSync(join(root, path), 'utf8');
const copy = (name, text) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const generate = (...args) =>
  spawnSync(python, ['-I', GENERATOR, '--check', ...args], { cwd: root, encoding: 'utf8' });
const lint = (...args) =>
  spawnSync(process.execPath, [CHECK, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, UCD_PYTHON: python },
  });

describe('vendored UCD 15.0.0 file', () => {
  it('is the pinned file: SHA-256, SHA256SUMS, header and generator constant agree', () => {
    const bytes = readFileSync(join(root, SOURCE));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PINNED);
    expect(read(SUMS)).toBe(`${PINNED}  DerivedGeneralCategory.txt\n`);
    expect(bytes.toString('utf8').split('\n', 2)[0]).toBe('# DerivedGeneralCategory-15.0.0.txt');
    expect(read(GENERATOR)).toContain(`"${PINNED}"`);
  });

  it('the generator reads only the vendored file, never unicodedata', () => {
    expect(read(GENERATOR)).not.toMatch(/unicodedata/);
    expect(read(TABLE)).not.toMatch(/CPython|unicodedata|provenance gap|D-77/);
  });
});

describe('drift check', () => {
  it('passes on the committed state (generator and lint wrapper)', () => {
    const run = generate();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const wrapped = lint();
    expect(wrapped.stderr).toBe('');
    expect(wrapped.status).toBe(0);
  });

  it('fails on an edited table entry', () => {
    const table = read(TABLE);
    // U+00AD SOFT HYPHEN is Cf (index 1); claim it is Cc (index 0).
    const edited = table.replace('0xad, 0xad, 1,', '0xad, 0xad, 0,');
    expect(edited).not.toBe(table);
    const target = copy('ucd15.ts', edited);
    const run = generate('--table', target);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/differs from the generator output/);
    expect(lint('--table', target).status).not.toBe(0);
  });

  it('fails on a table with CRLF line ends', () => {
    const edited = read(TABLE).replace(/\n/g, '\r\n');
    const run = generate('--table', copy('crlf.ts', edited));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/differs from the generator output/);
  });

  it('fails on a dropped table range', () => {
    const table = read(TABLE);
    const edited = table.replace(' 0x61c, 0x61c, 1,', '');
    expect(edited).not.toBe(table);
    expect(generate('--table', copy('dropped.ts', edited)).status).toBe(1);
  });

  it('fails on an edited vendored file, even one that would yield the same table', () => {
    const source = read(SOURCE);
    // A comment-only change: the parsed categories are the same, the pinned hash is not.
    const edited = source.replace('# EOF', '# EOF ');
    expect(edited).not.toBe(source);
    const target = copy('DerivedGeneralCategory.txt', edited);
    const run = generate('--source', target);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/SHA-256/);
    expect(lint('--source', target).status).not.toBe(0);
  });

  it('fails on an edited category in the vendored file', () => {
    const source = read(SOURCE);
    const edited = source.replace('00AD          ; Cf', '00AD          ; Pd');
    expect(edited).not.toBe(source);
    const run = generate('--source', copy('cat.txt', edited));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/SHA-256/);
  });

  it('fails on an edited SHA256SUMS', () => {
    const sums = read(SUMS).replace(PINNED, PINNED.slice(0, -1) + '0');
    const run = lint('--sums', copy('SHA256SUMS', sums));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/SHA256SUMS/);
  });

  it('runs in `pnpm lint` (the tools package check script)', () => {
    const scripts = JSON.parse(read('tools/package.json')).scripts;
    expect(scripts.check).toContain('node unicode/check-ucd15.mjs');
  });
});
