// @vitest-environment jsdom
// F49 (owner feedback, Windows): the backup code can be pasted, seen and kept.
// - normaliseBackupCode follows the server's rule (packages/crypto secret-code.ts) and never
//   changes a valid code, nor anything that is not a code's shape (a chosen passphrase).
// - BackupCodeField: Show/Hide, paste is never blocked.
// - copyBackupCode: the clipboard API, then the selection copy, else false (never silent).
// - inWorkingBrowser: copy never tells someone in Chrome/Edge to open Chrome or Edge.
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_CODE_FILE_NAME,
  BackupCodeField,
  backupCodeFileText,
  copyBackupCode,
  normaliseBackupCode,
  saveBackupCodeFile,
} from './backup-code.js';
import { inWorkingBrowser, otherBrowser } from './passkey-nudge.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';

describe('normaliseBackupCode', () => {
  it('keeps a valid code exactly (the server ignores its spaces, dashes and case itself)', () => {
    for (const ok of [CODE, 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX', 'abcdefghijklmnopqrstuvwx']) {
      expect(normaliseBackupCode(ok)).toBe(ok);
    }
  });

  it('removes what a Windows copy adds: line breaks, tabs, no-break and zero-width spaces, dashes', () => {
    expect(normaliseBackupCode('ABCD\r\nEFGH\nIJKL\tMNOP\u00a0QRST\u200bUVWX\r\n')).toBe(
      'ABCDEFGHIJKLMNOPQRSTUVWX',
    );
    expect(normaliseBackupCode('ABCD\u2013EFGH\u2014IJKL MNOP QRST UVWX')).toBe(
      'ABCDEFGHIJKL MNOP QRST UVWX',
    );
    expect(normaliseBackupCode('\ufeffabcd efgh ijkl mnop qrst uvwx ')).toBe(
      'abcd efgh ijkl mnop qrst uvwx ',
    );
  });

  it('leaves anything that is not a code shape exactly as typed (a passphrase, a short code)', () => {
    for (const other of [
      'correct horse\u00a0battery staple',
      'ABCD\nEFGH',
      'ABCDEFGHIJKLMNOPQRSTUVWXY',
      '\u00c0BCD EFGH IJKL MNOP QRST UVWX',
      '123456',
    ]) {
      expect(normaliseBackupCode(other)).toBe(other);
    }
  });
});

describe('inWorkingBrowser', () => {
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const edge = `${chrome} Edg/131.0.0.0`;
  const firefox =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
  const safari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
  it('Chrome and Edge on Windows, Safari on a Mac', () => {
    expect(otherBrowser('windows', chrome)).toBeUndefined();
    expect(otherBrowser('windows', edge)).toBeUndefined();
    expect(otherBrowser('windows', firefox)).toBe('Chrome or Edge');
    expect(inWorkingBrowser('mac', safari)).toBe(true);
    expect(otherBrowser('mac', chrome.replace('Windows NT 10.0; Win64; x64', 'Macintosh'))).toBe(
      'Safari',
    );
  });
});

describe('BackupCodeField and copy', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  let seen = '';
  function Harness(): ReactElement {
    const [v, setV] = useState('');
    seen = v;
    return createElement(BackupCodeField, { label: 'Backup code', value: v, onValue: setV });
  }

  it('Show/Hide toggles the field between masked and visible; paste is not blocked', async () => {
    await act(async () => root.render(createElement(Harness)));
    const input = host.querySelector('input')!;
    const toggle = host.querySelector<HTMLButtonElement>('[data-reveal-code]')!;
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle.click());
    expect(input.type).toBe('text');
    expect(toggle.textContent).toBe('Hide');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(input.id);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ABCD\nEFGH IJKL MNOP QRST UVWX',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toBe('ABCDEFGH IJKL MNOP QRST UVWX');
    expect(input.value).toBe('ABCDEFGH IJKL MNOP QRST UVWX');
  });

  // F49 low (IR 11-03): the cleanup is for what a copy adds, so a passphrase typed key by key with a
  // no-break space (Option+Space) or a typed dash is sent exactly as typed, even in a code's shape.
  async function input(value: string, inputType: string): Promise<void> {
    const el = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    });
  }

  it('typed key by key: never changed, even when it has a code shape', async () => {
    await act(async () => root.render(createElement(Harness)));
    const typed = 'ABCD\u00a0EFGH\u2013IJKL MNOP QRST UVWX';
    await input(typed, 'insertText');
    expect(seen).toBe(typed);
    await input(`${typed}\u00a0`, 'insertText');
    expect(seen).toBe(`${typed}\u00a0`);
    await input(typed, 'deleteContentBackward');
    expect(seen).toBe(typed);
  });

  it('pasted, dropped or filled in one piece: the separators a copy adds are removed', async () => {
    await act(async () => root.render(createElement(Harness)));
    await input('ABCD\u00a0EFGH\u2013IJKL\tMNOP QRST UVWX', 'insertFromPaste');
    expect(seen).toBe('ABCDEFGHIJKLMNOP QRST UVWX');
    await input('ABCD\u200bEFGH IJKL MNOP QRST UVWX', 'insertFromDrop');
    expect(seen).toBe('ABCDEFGH IJKL MNOP QRST UVWX');
    // A pasted passphrase (not a code's shape) is sent as pasted.
    await input('my own\u00a0passphrase\u2013here', 'insertFromPaste');
    expect(seen).toBe('my own\u00a0passphrase\u2013here');
  });

  it('copy uses the clipboard API when it works', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await expect(copyBackupCode(CODE)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(CODE);
  });

  it('copy falls back to the selection copy when the clipboard API refuses', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const exec = vi.fn((cmd: string) => cmd === 'copy');
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await expect(copyBackupCode(CODE)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // The helper's textarea is gone and holds nothing.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('copy reports failure when both fail (the page says so)', async () => {
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    await expect(copyBackupCode(CODE)).resolves.toBe(false);
  });

  it('Save as file downloads a local .txt with the code and one line (a blob URL, nothing sent)', () => {
    const made: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      made.push(b);
      return 'blob:local/1';
    });
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    expect(saveBackupCodeFile(CODE, 'Windows Hello')).toBe(true);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe(BACKUP_CODE_FILE_NAME);
    expect(clicks[0]?.href).toBe('blob:local/1');
    expect(made[0]?.type).toBe('text/plain;charset=utf-8');
    const text = backupCodeFileText(CODE, 'Windows Hello');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(2);
    expect(text).toContain(CODE);
    expect(text).toMatch(/never give the code to your AI/);
  });
});
