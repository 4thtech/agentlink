// OD-M (WIN-DESK-2): on Windows the data folder's protection is its ACL, not a file mode. At start the
// shell reads the folder's security descriptor (SDDL from Get-Acl) and the user's SID (whoami) and
// accepts only an ACL that gives access to this user, SYSTEM and Administrators (the set a folder
// under %USERPROFILE% inherits); anything wider (Everyone, Users, Authenticated Users, another
// user, a null DACL) stops the start with a fixed page. The runners are stubbed: no icacls here.
import { describe, expect, it } from 'vitest';
import {
  ACL_TIMEOUT_MS,
  aclVerdict,
  checkDataFolderAcl,
  dataFolderFor,
  decodeSaved,
  sddlFromSaved,
  parseDacl,
  parseWhoamiSid,
  type AclRunner,
} from '../../src/main/data-acl.js';

const USER = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const OTHER = 'S-1-5-21-1004336348-1177238915-682003330-1002';
// What a folder under C:\Users\ana inherits on Windows 10 and 11.
const INHERITED = `O:${USER}G:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;
const OWNER_ONLY = `O:${USER}D:PAI(A;OICI;FA;;;${USER})`;
const WHOAMI = `"desktop-1\\ana","${USER}"\r\n`;

describe('parsing', () => {
  it('reads the DACL entries of an SDDL string (aliases resolved)', () => {
    expect(parseDacl(INHERITED)).toEqual([
      { allow: true, inheritOnly: false, sid: 'S-1-5-18' },
      { allow: true, inheritOnly: false, sid: 'S-1-5-32-544' },
      { allow: true, inheritOnly: false, sid: USER },
    ]);
  });

  it('stops at the SACL and keeps deny and inherit-only entries apart', () => {
    const sddl = `O:BAD:P(D;;FA;;;WD)(A;OICIIO;GA;;;CO)(A;;FA;;;${USER})S:AI(AU;SAFA;FA;;;WD)`;
    expect(parseDacl(sddl)).toEqual([
      { allow: false, inheritOnly: false, sid: 'S-1-1-0' },
      { allow: true, inheritOnly: true, sid: 'S-1-3-0' },
      { allow: true, inheritOnly: false, sid: USER },
    ]);
  });

  it('a null DACL (no D: part, or NO_ACCESS_CONTROL) is "null"; garbage is undefined', () => {
    expect(parseDacl(`O:${USER}G:${USER}`)).toBe('null');
    expect(parseDacl(`O:${USER}D:NO_ACCESS_CONTROL`)).toBe('null');
    expect(parseDacl('')).toBeUndefined();
    expect(parseDacl('not sddl')).toBeUndefined();
    expect(parseDacl(`D:(A;;FA;;;${USER}`)).toBeUndefined();
    expect(parseDacl('D:(A;;FA)')).toBeUndefined();
  });

  it('a conditional entry keeps its SID (the condition is not split into entries)', () => {
    const sddl = `D:(XA;;FA;;;WD;(@User.x == "a;b"))(A;;FA;;;${USER})`;
    expect(parseDacl(sddl)).toEqual([
      { allow: true, inheritOnly: false, sid: 'S-1-1-0' },
      { allow: true, inheritOnly: false, sid: USER },
    ]);
  });

  it('reads the SID from whoami /user /fo csv /nh', () => {
    expect(parseWhoamiSid(WHOAMI)).toBe(USER);
    expect(parseWhoamiSid('"x","not-a-sid"')).toBeUndefined();
    expect(parseWhoamiSid('')).toBeUndefined();
  });
});

describe('the verdict', () => {
  it('accepts owner-only and the inherited user, SYSTEM and Administrators set', () => {
    expect(aclVerdict(OWNER_ONLY, USER)).toBe('ok');
    expect(aclVerdict(INHERITED, USER)).toBe('ok');
    // The SID is compared without regard to letter case.
    expect(aclVerdict(INHERITED, USER.toLowerCase())).toBe('ok');
  });

  // Seen on the windows-2022 runner (run 43490849095): the user is the built-in Administrator, and
  // icacls /save writes its SID as the alias LA. LA is always a member of Administrators; the
  // Guest account (LG) is not accepted.
  it('accepts the built-in Administrator (LA), refuses Guest (LG)', () => {
    const runner = 'D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)';
    expect(aclVerdict(runner, 'S-1-5-21-1-2-3-500')).toBe('ok');
    expect(aclVerdict(runner, USER)).toBe('ok');
    expect(aclVerdict(`${runner}(A;OICI;FA;;;LG)`, USER)).toBe('too_open');
  });

  it('accepts CREATOR OWNER only as an inherit-only entry, and ignores deny entries', () => {
    expect(aclVerdict(`D:(A;OICIIO;FA;;;CO)(A;;FA;;;${USER})`, USER)).toBe('ok');
    expect(aclVerdict(`D:(A;;FA;;;CO)(A;;FA;;;${USER})`, USER)).toBe('too_open');
    expect(aclVerdict(`D:(D;;FA;;;WD)(A;;FA;;;${USER})`, USER)).toBe('ok');
  });

  it.each([
    ['Everyone', 'WD'],
    ['Users', 'BU'],
    ['Authenticated Users', 'AU'],
    ['Everyone by SID', 'S-1-1-0'],
    ['Users by SID', 'S-1-5-32-545'],
    ['another user', OTHER],
    ['OWNER RIGHTS', 'OW'],
  ])('refuses an entry for %s', (_name, sid) => {
    expect(aclVerdict(`${INHERITED}(A;OICI;0x1200a9;;;${sid})`, USER)).toBe('too_open');
  });

  it('refuses an inherit-only entry for another account (the files inside get it)', () => {
    expect(aclVerdict(`${INHERITED}(A;OICIIO;FA;;;BU)`, USER)).toBe('too_open');
  });

  it('refuses a null DACL and an allow entry of an object type', () => {
    expect(aclVerdict(`O:${USER}`, USER)).toBe('too_open');
    expect(aclVerdict(`D:(OA;;FA;;;WD)(A;;FA;;;${USER})`, USER)).toBe('too_open');
  });

  it('cannot decide without a well-formed SDDL or SID', () => {
    expect(aclVerdict('garbage', USER)).toBe('unchecked');
    expect(aclVerdict(INHERITED, 'S-1-5-oops')).toBe('unchecked');
  });
});

describe('reading what icacls /save writes', () => {
  it('decodes UTF-16LE (with or without a byte order mark) and UTF-8', () => {
    const text = `.agentlink\r\n${INHERITED}\r\n`;
    const le = Buffer.from(text, 'utf16le');
    expect(decodeSaved(le)).toBe(text);
    expect(decodeSaved(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(text);
    expect(decodeSaved(Buffer.from(text, 'utf8'))).toBe(text);
  });

  it('takes the SDDL line, never the name line', () => {
    expect(sddlFromSaved(`.agentlink\r\n${INHERITED}\r\n`)).toBe(INHERITED);
    expect(sddlFromSaved(`D-folder\r\nD:AI(A;;FA;;;SY)\r\n`)).toBe('D:AI(A;;FA;;;SY)');
    expect(sddlFromSaved('.agentlink\r\n')).toBeUndefined();
    expect(sddlFromSaved('')).toBeUndefined();
  });
});

describe('checking the folder', () => {
  type Call = { file: string; args: readonly string[]; env: Record<string, string>; ms: number };
  const runner = (
    sddl: string | Error,
    whoami: string | Error = WHOAMI,
  ): AclRunner & { calls: Call[]; disposed: number } => {
    const calls: Call[] = [];
    const r = {
      calls,
      disposed: 0,
      run: (file: string, args: readonly string[], env: Record<string, string>, ms: number) => {
        calls.push({ file, args, env, ms });
        if (file.toLowerCase().endsWith('whoami.exe')) {
          return whoami instanceof Error ? Promise.reject(whoami) : Promise.resolve(whoami);
        }
        return sddl instanceof Error ? Promise.reject(sddl) : Promise.resolve('');
      },
      scratch: () =>
        Promise.resolve({
          dir: 'C:\\Users\\ana\\AppData\\Local\\Temp\\al-acl-1',
          read: (name: string) =>
            name === 'acl.txt' && typeof sddl === 'string'
              ? Promise.resolve(Buffer.from(`.agentlink\r\n${sddl}\r\n`, 'utf16le'))
              : Promise.reject(new Error('no file')),
          dispose: () => {
            r.disposed += 1;
            return Promise.resolve();
          },
        }),
    };
    return r;
  };

  it('is win32 only', async () => {
    const r = runner(INHERITED);
    await expect(checkDataFolderAcl('darwin', '/Users/ana/.agentlink', {}, r)).resolves.toBe('ok');
    expect(r.calls).toHaveLength(0);
  });

  it('runs icacls /save and whoami from System32 with a short fixed timeout, no shell', async () => {
    const r = runner(INHERITED);
    const env = { SystemRoot: 'C:\\Windows' };
    await expect(
      checkDataFolderAcl('win32', 'C:\\Users\\a"; rm\\.agentlink', env, r),
    ).resolves.toBe('ok');
    const ic = r.calls.find((c) => c.file.endsWith('icacls.exe'));
    expect(ic?.file).toBe('C:\\Windows\\System32\\icacls.exe');
    // The folder is one argument; the output goes to a new private scratch folder.
    expect(ic?.args).toEqual([
      'C:\\Users\\a"; rm\\.agentlink',
      '/save',
      'C:\\Users\\ana\\AppData\\Local\\Temp\\al-acl-1\\acl.txt',
    ]);
    const who = r.calls.find((c) => c.file.endsWith('whoami.exe'));
    expect(who?.file).toBe('C:\\Windows\\System32\\whoami.exe');
    expect(who?.args).toEqual(['/user', '/fo', 'csv', '/nh']);
    for (const c of r.calls) expect(c.ms).toBe(ACL_TIMEOUT_MS);
    expect(ACL_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(r.disposed).toBe(1);
  });

  // Fable rules on "unchecked" (it does not stop the start); here it must never read as "ok".
  it('a timeout or a missing output file is unchecked, never ok, and the scratch is removed', async () => {
    const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    const r = runner(timedOut);
    await expect(checkDataFolderAcl('win32', 'C:\\x', {}, r)).resolves.toBe('unchecked');
    expect(r.disposed).toBe(1);
    const empty = runner('');
    await expect(checkDataFolderAcl('win32', 'C:\\x', {}, empty)).resolves.toBe('unchecked');
  });

  it('an odd SystemRoot falls back to C:\\Windows', async () => {
    const r = runner(INHERITED);
    await checkDataFolderAcl(
      'win32',
      'C:\\Users\\ana\\.agentlink',
      { SystemRoot: '\\\\evil\\x' },
      r,
    );
    expect(r.calls.every((c) => c.file.startsWith('C:\\Windows\\System32\\'))).toBe(true);
  });

  it('too open → too_open; a failed or unreadable check → unchecked', async () => {
    const open = runner(`${INHERITED}(A;OICI;FA;;;WD)`);
    await expect(checkDataFolderAcl('win32', 'C:\\x', {}, open)).resolves.toBe('too_open');
    await expect(checkDataFolderAcl('win32', 'C:\\x', {}, runner(new Error('no')))).resolves.toBe(
      'unchecked',
    );
    await expect(
      checkDataFolderAcl('win32', 'C:\\x', {}, runner(INHERITED, new Error('no'))),
    ).resolves.toBe('unchecked');
  });

  it('the data folder is .agentlink in the home folder, or the home folder before it exists', () => {
    const exists = (p: string): boolean => p === 'C:\\Users\\ana\\.agentlink';
    expect(dataFolderFor('C:\\Users\\ana', 'win32', exists)).toBe('C:\\Users\\ana\\.agentlink');
    expect(dataFolderFor('C:\\Users\\bo', 'win32', () => false)).toBe('C:\\Users\\bo');
  });
});
