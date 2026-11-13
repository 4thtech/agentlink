// OD-M (WIN-DESK-2): on Windows the data folder's protection is its ACL, not a file mode. At start the
// shell reads the folder's security descriptor (SDDL from Get-Acl) and the user's SID (whoami) and
// accepts only an ACL that gives access to this user, SYSTEM and Administrators (the set a folder
// under %USERPROFILE% inherits); anything wider (Everyone, Users, Authenticated Users, another
// user, a null DACL) stops the start with a fixed page. The runners are stubbed: no PowerShell here.
import { describe, expect, it } from 'vitest';
import {
  ACL_SCRIPT,
  aclVerdict,
  checkDataFolderAcl,
  dataFolderFor,
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

describe('checking the folder', () => {
  const runner = (sddl: string | Error, whoami: string | Error = WHOAMI): AclRunner & {
    calls: { file: string; args: readonly string[]; env: Record<string, string> }[];
  } => {
    const calls: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
    return {
      calls,
      run: (file, args, env) => {
        calls.push({ file, args, env });
        const out = file.toLowerCase().endsWith('whoami.exe') ? whoami : sddl;
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
    };
  };

  it('is win32 only', async () => {
    const r = runner(INHERITED);
    await expect(checkDataFolderAcl('darwin', '/Users/ana/.agentlink', {}, r)).resolves.toBe('ok');
    expect(r.calls).toHaveLength(0);
  });

  it('runs Windows PowerShell and whoami from System32, the path only through the environment', async () => {
    const r = runner(INHERITED);
    const env = { SystemRoot: 'C:\\Windows' };
    await expect(checkDataFolderAcl('win32', 'C:\\Users\\a"; rm\\.agentlink', env, r)).resolves.toBe(
      'ok',
    );
    const ps = r.calls.find((c) => c.file.endsWith('powershell.exe'));
    expect(ps?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(ps?.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT]);
    expect(ps?.args.join(' ')).not.toContain('.agentlink');
    expect(ps?.env['AGENTLINK_ACL_PATH']).toBe('C:\\Users\\a"; rm\\.agentlink');
    const who = r.calls.find((c) => c.file.endsWith('whoami.exe'));
    expect(who?.file).toBe('C:\\Windows\\System32\\whoami.exe');
    expect(who?.args).toEqual(['/user', '/fo', 'csv', '/nh']);
  });

  it('an odd SystemRoot falls back to C:\\Windows', async () => {
    const r = runner(INHERITED);
    await checkDataFolderAcl('win32', 'C:\\Users\\ana\\.agentlink', { SystemRoot: '\\\\evil\\x' }, r);
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
