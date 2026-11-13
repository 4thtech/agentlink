// OD-M (WIN-DESK-2): runs the shell's data folder ACL check (src/main/data-acl.ts) against REAL
// folders on the Windows CI runner, with the same runner as the shell (main.ts runQuiet, aclScratch):
// a new folder under the user's temp folder (inherited ACL) must be 'ok' and the same folder with read
// access for Everyone must be 'too_open', each well inside ACL_TIMEOUT_MS. Windows only; started by
// desktop.yml with `node --experimental-strip-types`. Prints fixed words, timings and, on a failure,
// the parsed entries with this user's SID shown as USER.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACL_TIMEOUT_MS,
  checkDataFolderAcl,
  decodeSaved,
  parseDacl,
  parseWhoamiSid,
  sddlFromSaved,
} from '../../src/main/data-acl.ts';

if (process.platform !== 'win32') {
  console.log('data-acl-check: Windows only, skipped.');
  process.exit(0);
}

const runner = {
  run: (file, args, env, ms) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
        { env, windowsHide: true, timeout: ms, encoding: 'utf8' },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end();
    }),
  scratch: async () => {
    const d = await mkdtemp(join(tmpdir(), 'agentlink-acl-'));
    return {
      dir: d,
      read: (name) => readFile(join(d, name)),
      dispose: () => rm(d, { recursive: true, force: true }),
    };
  },
};

const sys32 = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`;

/** On a failure: what icacls wrote and how it parsed (this user's SID shown as USER). */
async function explain(folder) {
  const s = await runner.scratch();
  try {
    const who = await runner.run(
      `${sys32}\\whoami.exe`,
      ['/user', '/fo', 'csv', '/nh'],
      process.env,
      30_000,
    );
    const sid = parseWhoamiSid(who) ?? 'none';
    await runner.run(
      `${sys32}\\icacls.exe`,
      [folder, '/save', join(s.dir, 'acl.txt')],
      process.env,
      30_000,
    );
    const text = decodeSaved(await s.read('acl.txt'));
    const sddl = sddlFromSaved(text);
    const dacl = sddl === undefined ? undefined : parseDacl(sddl);
    console.log(`  saved lines: ${String(text.split(/\r?\n/).filter(Boolean).length)}`);
    console.log(`  sddl: ${sddl === undefined ? 'none' : sddl.split(sid).join('USER')}`);
    console.log(
      `  dacl: ${
        dacl === undefined || dacl === 'null'
          ? String(dacl)
          : dacl
              .map(
                (e) =>
                  `${e.allow ? 'allow' : 'deny'}${e.inheritOnly ? '/io' : ''}:${e.sid === sid ? 'USER' : e.sid}`,
              )
              .join(' ')
      }`,
    );
  } catch (error) {
    console.log(`  explain: failed (${String(error?.code ?? error?.signal ?? 'error')})`);
  } finally {
    await s.dispose();
  }
}

async function timed(label, folder, expected) {
  const started = Date.now();
  const result = await checkDataFolderAcl('win32', folder, process.env, runner);
  const ms = Date.now() - started;
  console.log(`${label}: ${result} in ${String(ms)} ms`);
  if (result === expected && ms < ACL_TIMEOUT_MS) return true;
  await explain(folder);
  return false;
}

// The user's own temp folder (under %USERPROFILE%), not RUNNER_TEMP on another drive.
const dir = mkdtempSync(join(tmpdir(), 'al-acl-'));
let ok = true;
try {
  ok = (await timed('inherited ACL', dir, 'ok')) && ok;
  await runner.run(
    `${sys32}\\icacls.exe`,
    [dir, '/grant', '*S-1-1-0:(OI)(CI)R'],
    process.env,
    30_000,
  );
  ok = (await timed('with Everyone', dir, 'too_open')) && ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!ok) {
  console.error('data-acl-check: unexpected result.');
  process.exit(1);
}
console.log('data-acl-check: ok.');
