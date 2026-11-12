import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nsisScript } from '../lib/nsis.mjs';

test('NSIS script: per-user, scheme with -- separator, uninstaller keeps ~/.agentlink', () => {
  const s = nsisScript({ version: '0.5.0', sourceDir: 'C:\\stage\\AgentLink', outFile: 'C:\\out\\setup.exe' });
  assert.match(s, /RequestExecutionLevel user/);
  assert.match(s, /\$LOCALAPPDATA\\Programs\\AgentLink/);
  assert.match(s, /HKCU/);
  assert.match(s, /Software\\Classes\\agentlink\\shell\\open\\command/);
  assert.ok(s.includes('-- \\"%1\\"'), 'command is "<exe>" -- "%1"');
  assert.match(s, /4thTech\.AgentLink/);
  assert.doesNotMatch(s, /\.agentlink/);
  assert.doesNotMatch(s, /HKLM/);
  assert.doesNotMatch(s, /\$PROFILE/);
});

test('NSIS script rejects an unsafe version', () => {
  assert.throws(() => nsisScript({ version: '1"; ExecShell', sourceDir: 'a', outFile: 'b' }));
});
