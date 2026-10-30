// W4-AUTO-SAVE (S2; D-142; 04 §4.1 "Name sanitisation", "No handling by extension"; Decision 51):
// the name a received file is saved under, for every save (automatic, Save, agentlink_fetch_file).
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_NAME_BYTES,
  needsDownloadSuffix,
  savedFileName,
  withNameSuffix,
  withRandomNameSuffix,
} from './file-name.js';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('savedFileName (04 §4.1)', () => {
  it('removes bidi overrides, so a name cannot hide its real extension', () => {
    const name = savedFileName('invoice\u202Efdp.exe');
    expect(name).toBe('invoicefdp.exe.download');
    expect(name).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b]/u);
  });

  it('prefixes a Windows reserved name and keeps only the last path segment', () => {
    expect(savedFileName('CON.txt')).toBe('_CON.txt');
    expect(savedFileName('../x')).toBe('x');
    expect(savedFileName('..\\..\\.ssh\\authorized_keys')).toBe('authorized_keys');
  });

  it('appends .download to names the shell acts on, case-insensitively, after sanitisation', () => {
    expect(savedFileName('evil.lnk')).toBe('evil.lnk.download');
    expect(savedFileName('EVIL.LNK')).toBe('EVIL.LNK.download');
    expect(savedFileName('desktop.ini')).toBe('desktop.ini.download');
    expect(savedFileName('Autorun.INF')).toBe('Autorun.INF.download');
    expect(savedFileName('evil.lnk.')).toBe('evil.lnk.download'); // trailing dot removed first
    for (const ext of [
      'url',
      'scf',
      'library-ms',
      'searchConnector-ms',
      'desktop',
      'webloc',
      'inetloc',
      'fileloc',
      'command',
      'tool',
      'terminal',
      'exe',
      'scr',
      'pif',
      'bat',
      'cmd',
      'ps1',
      'vbs',
      'js',
      'hta',
      'msi',
      'website',
      'settingcontent-ms',
    ]) {
      expect(needsDownloadSuffix(`a.${ext}`), ext).toBe(true);
      expect(savedFileName(`a.${ext.toUpperCase()}`)).toBe(`a.${ext.toUpperCase()}.download`);
    }
    expect(savedFileName('report.pdf')).toBe('report.pdf');
    expect(savedFileName('notes.txt.download')).toBe('notes.txt.download');
  });

  it('folds the extension through upper and lower case (IR SEC L4: long s, Kelvin sign)', () => {
    expect(needsDownloadSuffix('evil.\u017Fcr')).toBe(true); // ſcr → SCR → scr
    expect(needsDownloadSuffix('evil.ln\u212A')).toBe(true); // Kelvin sign K → k
    expect(needsDownloadSuffix('desktop.\u0131ni')).toBe(true); // dotless ı → I → i
    expect(savedFileName('evil.\u017Fcr')).toBe('evil.\u017Fcr.download');
  });

  it('a 300-byte name is cut to 255 bytes on a code-point boundary, the extension kept', () => {
    const long = `${'é'.repeat(150)}.pdf`; // 304 bytes
    const name = savedFileName(long);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name).not.toContain('�');
    expect([...name.slice(0, -4)].every((c) => c === 'é')).toBe(true);
  });

  it('the 255-byte check is on the final name, after .download', () => {
    const long = `${'a'.repeat(260)}.lnk`;
    const name = savedFileName(long);
    expect(bytes(name)).toBe(MAX_FILE_NAME_BYTES);
    expect(name.endsWith('.lnk.download')).toBe(true);
    const emoji = savedFileName(`${'😀'.repeat(70)}.exe`); // 4-byte code points
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(emoji.endsWith('.exe.download')).toBe(true);
    expect(emoji).not.toContain('�');
  });

  it('an empty result becomes file', () => {
    expect(savedFileName('‮​')).toBe('file');
    expect(savedFileName('...')).toBe('file');
  });
});

describe('numbered names keep the extension and .download (04 §4.1)', () => {
  it('"{stem} (2){ext}", with .download after the last extension', () => {
    expect(withNameSuffix('report.pdf', 2)).toBe('report (2).pdf');
    expect(withNameSuffix('evil.lnk.download', 2)).toBe('evil (2).lnk.download');
    expect(withRandomNameSuffix('evil.lnk.download', 'Ab3dE6gH')).toBe(
      'evil (Ab3dE6gH).lnk.download',
    );
  });

  it('stays within 255 bytes with the suffix', () => {
    const name = savedFileName(`${'é'.repeat(200)}.lnk`);
    const numbered = withNameSuffix(name, 999);
    expect(bytes(numbered)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(numbered.endsWith(' (999).lnk.download')).toBe(true);
  });
});
