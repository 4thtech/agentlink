import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nsisScript } from '../lib/nsis.mjs';

test('NSIS script: per-user, scheme with -- separator, uninstaller keeps ~/.agentlink', () => {
  const s = nsisScript({
    version: '0.5.0',
    sourceDir: 'C:\\stage\\AgentLink',
    outFile: 'C:\\out\\setup.exe',
  });
  assert.match(s, /RequestExecutionLevel user/);
  assert.match(s, /\$LOCALAPPDATA\\Programs\\AgentLink/);
  assert.match(s, /HKCU/);
  assert.match(s, /Software\\Classes\\agentlink\\shell\\open\\command/);
  assert.ok(
    s.includes('AgentLink.exe$\\" -- $\\"%1$\\"'),
    'command is "<exe>" -- "%1" (NSIS quoting)',
  );
  assert.match(s, /4thTech\.AgentLink/);
  assert.doesNotMatch(s, /\.agentlink/);
  assert.doesNotMatch(s, /HKLM/);
  assert.doesNotMatch(s, /\$PROFILE/);
});

test('uninstall deletes recursively only after the folder guards, never anything else', () => {
  const s = nsisScript({ version: '0.5.0', sourceDir: 'a', outFile: 'b' });
  const un = s.slice(s.indexOf('Section "Uninstall"'));
  const rm = un.indexOf('RMDir /r "$INSTDIR"');
  assert.ok(rm > 0);
  assert.equal(un.split('RMDir /r').length - 1, 1, 'one recursive delete only');
  for (const guard of [
    'StrCmp "$INSTDIR" "$LOCALAPPDATA\\Programs\\AgentLink"',
    'IfFileExists "$INSTDIR\\AgentLink.exe"',
    'IfFileExists "$INSTDIR\\Uninstall.exe"',
  ]) {
    const at = un.indexOf(guard);
    assert.ok(at >= 0 && at < rm, guard);
  }
  assert.doesNotMatch(un, /\$PROFILE|\$APPDATA|\$DOCUMENTS|\$LOCALAPPDATA"/);
});

test('NSIS script rejects an unsafe version', () => {
  assert.throws(() => nsisScript({ version: '1"; ExecShell', sourceDir: 'a', outFile: 'b' }));
});

test('N7 (IR-N7-1 M-1): the Start menu shortcut carries the app’s AppUserModelID', async () => {
  const { APP_USER_MODEL_ID } = await import('../lib/nsis.mjs');
  const { readFileSync } = await import('node:fs');
  // The same ID the app sets at startup (apps/desktop/src/main/notify.ts).
  const notify = readFileSync(new URL('../../src/main/notify.ts', import.meta.url), 'utf8');
  assert.ok(notify.includes(`APP_USER_MODEL_ID = '${APP_USER_MODEL_ID}'`));
  assert.equal(APP_USER_MODEL_ID, '4thTech.AgentLink');
  const s = nsisScript({ version: '0.5.3', sourceDir: 'a', outFile: 'b' });
  const install = s.slice(s.indexOf('Section "Install"'), s.indexOf('Section "Uninstall"'));
  const link = install.indexOf('CreateShortCut "$SMPROGRAMS\\AgentLink\\AgentLink.lnk"');
  const call = install.indexOf('Call SetShortcutAumid');
  assert.ok(link > 0 && call > link, 'the ID is set after the shortcut exists');
  assert.ok(install.includes('StrCpy $0 "$SMPROGRAMS\\AgentLink\\AgentLink.lnk"'));
  const fn = s.slice(s.indexOf('Function SetShortcutAumid'), s.indexOf('FunctionEnd'));
  // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5, as a VT_LPWSTR (31).
  assert.match(fn, /\{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3\}", i 5/);
  assert.match(fn, /&i2 31/);
  assert.ok(fn.includes(`&w64 "${APP_USER_MODEL_ID}"`));
  // IPropertyStore::SetValue and Commit, then IPersistFile::Save; the stock System plugin only.
  assert.match(fn, /\$4->6\(p r5, p r6\)/);
  assert.match(fn, /\$4->7\(\)/);
  assert.match(fn, /\$3->6\(p 0, i 1\)/);
  assert.doesNotMatch(s, /WinShell::|!addplugindir/);
});

// WIN-DESK-2 (R-WIN §6 item 11): install and uninstall stop while AgentLink runs (its files are in
// use), with a fixed message and Retry; a silent run fails instead of waiting.
test('install and uninstall check for a running copy first', () => {
  const s = nsisScript({ version: '0.5.3', sourceDir: 'a', outFile: 'b' });
  for (const [fn, init] of [
    ['Function .onInit', 'Call CheckNotRunning'],
    ['Function un.onInit', 'Call un.CheckNotRunning'],
  ]) {
    const at = s.indexOf(fn);
    assert.ok(at >= 0, fn);
    assert.ok(s.slice(at, s.indexOf('FunctionEnd', at)).includes(init), init);
  }
  const check = s.slice(s.indexOf('!macro CHECK_NOT_RUNNING'), s.indexOf('!macroend'));
  // An exe that is running cannot be opened for writing; nothing is written or closed by force.
  for (const file of ['$INSTDIR\\AgentLink.exe', '$INSTDIR\\resources\\node\\node.exe']) {
    assert.ok(check.includes(`IfFileExists "${file}"`), file);
    assert.ok(check.includes(`FileOpen $R0 "${file}" a`), file);
  }
  assert.match(check, /MB_RETRYCANCEL/);
  assert.match(check, /IfSilent/);
  assert.ok(check.includes('AgentLink is running.'));
  assert.ok(check.includes('Quit AgentLink'));
  assert.doesNotMatch(check, /FileWrite|taskkill|KillProc|Delete /);
  assert.ok(s.includes('!insertmacro CHECK_NOT_RUNNING ""'));
  assert.ok(s.includes('!insertmacro CHECK_NOT_RUNNING "un."'));
});

// WIN-INAPP-UPDATE: the app's in-app update runs this setup silently (`/S`) after the app quit. A
// silent run must fail loudly (exit code) rather than skip a file, must also wait for the presence
// helper, never touch the person's data or desktop shortcut choice, and keep the one install folder.
test('silent upgrade: no skipped files, the helper checked too, data and the desktop shortcut kept', () => {
  const s = nsisScript({ version: '0.5.6', sourceDir: 'a', outFile: 'b' });
  // A file that cannot be written fails the silent run (exit code ≠ 0), never "ignored" with exit 0.
  assert.match(s, /\nAllowSkipFiles off\n/);
  assert.match(s, /\nSetOverwrite on\n/);
  // Same install folder every time (no directory page; the app updates only this folder).
  assert.match(s, /\nInstallDir "\$LOCALAPPDATA\\Programs\\AgentLink"\n/);
  assert.doesNotMatch(s, /MUI_PAGE_DIRECTORY/);
  // The presence helper is in use while AgentLink runs, like the app and node.exe.
  const check = s.slice(s.indexOf('!macro CHECK_NOT_RUNNING'), s.indexOf('!macroend'));
  const helper = '$INSTDIR\\resources\\native\\agentlink-presence.exe';
  assert.ok(check.includes(`IfFileExists "${helper}"`));
  assert.ok(check.includes(`FileOpen $R0 "${helper}" a`));
  // In place over an older copy: the old resources go first (no stale core files), only after the
  // same folder guards as the uninstaller; nothing else is removed.
  const install = s.slice(s.indexOf('Section "Install"'), s.indexOf('SectionEnd'));
  const rm = install.indexOf('RMDir /r "$INSTDIR\\resources"');
  const file = install.indexOf('File /r');
  assert.ok(rm > 0 && rm < file, 'old resources removed before the new files');
  for (const guard of [
    'StrCmp "$INSTDIR" "$LOCALAPPDATA\\Programs\\AgentLink"',
    'IfFileExists "$INSTDIR\\AgentLink.exe"',
  ]) {
    const at = install.indexOf(guard);
    assert.ok(at >= 0 && at < rm, guard);
  }
  assert.equal(install.split('RMDir /r').length - 1, 1);
  // IR Fable r1: never through a junction or link (reparse point) at the folder or at resources.
  for (const target of ['$INSTDIR', '$INSTDIR\\resources']) {
    const at = install.indexOf(`GetFileAttributesW(w "${target}")`);
    assert.ok(at >= 0 && at < rm, target);
  }
  assert.equal(install.split('IntOp $0 $0 & 0x400').length - 1, 2);
  assert.doesNotMatch(install, /\.agentlink|\$PROFILE|\$APPDATA|\$DOCUMENTS/);
  // The desktop shortcut: only the finish page creates it (a silent run has none), nothing in the
  // install deletes it, so the person's choice stays as it was.
  assert.doesNotMatch(install, /\$DESKTOP/);
  const desktop = s.slice(s.indexOf('Function CreateDesktopShortcut'));
  assert.ok(desktop.includes('CreateShortCut "$DESKTOP\\AgentLink.lnk"'));
});
