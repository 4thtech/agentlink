// OD-M (WIN-DESK-2): runs the shell's data folder ACL check (src/main/data-acl.ts) against REAL
// folders on the Windows CI runner: a new folder under the runner's temp folder (inherited ACL) must
// be 'ok'; the same folder with read access for Everyone must be 'too_open'. Windows only; started by
// desktop.yml with `node --experimental-strip-types`. Prints fixed words only.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDataFolderAcl } from '../../src/main/data-acl.ts';

if (process.platform !== 'win32') {
  console.log('data-acl-check: Windows only, skipped.');
  process.exit(0);
}

const runner = {
  run: (file, args, env) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { env, windowsHide: true, timeout: 30_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    }),
};

// The user's own temp folder (under %USERPROFILE%), not RUNNER_TEMP on another drive.
const dir = mkdtempSync(join(tmpdir(), 'al-acl-'));
let failed = false;
try {
  const inherited = await checkDataFolderAcl('win32', dir, process.env, runner);
  console.log(`inherited ACL: ${inherited}`);
  if (inherited !== 'ok') failed = true;
  await runner.run(
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`,
    [dir, '/grant', '*S-1-1-0:(OI)(CI)R'],
    process.env,
  );
  const wide = await checkDataFolderAcl('win32', dir, process.env, runner);
  console.log(`with Everyone: ${wide}`);
  if (wide !== 'too_open') failed = true;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error('data-acl-check: unexpected result.');
  process.exit(1);
}
console.log('data-acl-check: ok.');
