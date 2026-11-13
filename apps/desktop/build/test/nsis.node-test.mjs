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
