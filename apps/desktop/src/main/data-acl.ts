// OD-M (WIN-DESK-2, R-WIN §6 item 2): who can open the data folder on Windows.
//
// On NTFS `mode: 0o600/0o700` and `chmod` do nothing: a folder's protection is its ACL. A folder under
// %USERPROFILE% inherits an ACL that gives access to the user, SYSTEM and Administrators, which is
// "no other user" in practice (owner decision OD-M: accept that inherited set, and owner-only, and
// document it). Before every core start on Windows the shell reads the data folder's security
// descriptor and refuses to start when it gives access to anyone else (Everyone, Users,
// Authenticated Users, another user, or a null DACL), with a fixed page that says how to fix it.
//
// How it reads it (no new dependency, no native code): `icacls <folder> /save <file>` writes the
// folder's DACL as SDDL (security identifiers, not account names, so it does not depend on the
// Windows language) into a new private scratch folder, and `whoami /user` prints this user's SID.
// Both are started from %SystemRoot%\System32 by absolute path, without a shell, stdin closed, each
// killed after ACL_TIMEOUT_MS (PowerShell's Get-Acl timed out at 30 s on a cold CI runner, so it is
// not used). A check that cannot run or cannot be read ("unchecked") does not stop the start (Fable
// rules on this) but leaves a fixed line in core.log (main.ts); it is never read as "ok".
//
// What this is NOT: a security boundary against a same-user process (it can change the ACL back, or
// read the folder itself). It catches a folder made readable to other people on this computer.
// SYSTEM and Administrators can read any file anyway. Nothing here is logged.
import { join, win32 } from 'node:path';

/** A new empty private folder for icacls's output (its own temp folder), read and removed after. */
export interface AclScratch {
  readonly dir: string;
  readonly read: (name: string) => Promise<Uint8Array>;
  readonly dispose: () => Promise<void>;
}

/** Runs an executable (absolute path, no shell, stdin closed, killed after `ms`) → its stdout. */
export interface AclRunner {
  readonly run: (
    file: string,
    args: readonly string[],
    env: Record<string, string>,
    ms: number,
  ) => Promise<string>;
  readonly scratch: () => Promise<AclScratch>;
}

/** The fixed limit for each tool (icacls and whoami take well under a second). */
export const ACL_TIMEOUT_MS = 5000;

export type AclVerdict = 'ok' | 'too_open' | 'unchecked';

/** One DACL entry: whether it grants access, applies only to the items inside, and to whom. */
export interface AclEntry {
  readonly allow: boolean;
  readonly inheritOnly: boolean;
  readonly sid: string;
}

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const CREATOR_OWNER = 'S-1-3-0';

/** SDDL aliases for well-known SIDs (the ones that matter here, and the usual wider ones). */
const ALIASES: Readonly<Record<string, string>> = {
  SY: SYSTEM,
  BA: ADMINISTRATORS,
  CO: CREATOR_OWNER,
  WD: 'S-1-1-0',
  BU: 'S-1-5-32-545',
  AU: 'S-1-5-11',
  OW: 'S-1-3-4',
  IU: 'S-1-5-4',
  NU: 'S-1-5-2',
  AN: 'S-1-5-7',
  BG: 'S-1-5-32-546',
};

const SID = /^S-1-\d+(?:-\d+)+$/i;
const DENY_TYPES = new Set(['D', 'OD', 'XD']);

/**
 * The DACL of an SDDL string: its entries, 'null' when there is none (everyone has full access), or
 * undefined when the text is not SDDL.
 */
export function parseDacl(sddl: string): readonly AclEntry[] | 'null' | undefined {
  const text = sddl.trim();
  if (!/^(O:|G:|D:|S:)/.test(text)) return undefined;
  const at = text.indexOf('D:');
  if (at < 0) return 'null';
  let i = at + 2;
  // The DACL flags (P, AI, AR, NO_ACCESS_CONTROL) up to the first entry or the SACL.
  let flags = '';
  while (i < text.length && text[i] !== '(' && !text.startsWith('S:', i)) flags += text[i++];
  if (flags.includes('NO_ACCESS_CONTROL')) return 'null';
  if (!/^[A-Z_]*$/.test(flags)) return undefined;
  const entries: AclEntry[] = [];
  while (i < text.length && text[i] === '(') {
    // One entry, with nested parentheses (a conditional entry's condition) kept inside it.
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) return undefined;
    const fields = text.slice(i + 1, end).split(';');
    if (fields.length < 6) return undefined;
    const type = (fields[0] ?? '').toUpperCase();
    const aceFlags = (fields[1] ?? '').toUpperCase();
    const who = (fields[5] ?? '').trim();
    const sid = ALIASES[who.toUpperCase()] ?? who;
    if (type === '' || sid === '') return undefined;
    entries.push({
      // Anything that is not a known deny type counts as granting (fail closed).
      allow: !DENY_TYPES.has(type),
      inheritOnly: flagPairs(aceFlags).includes('IO'),
      sid,
    });
    i = end + 1;
  }
  if (i < text.length && !text.startsWith('S:', i)) return undefined;
  return entries;
}

/** SDDL entry flags come in two-letter pairs (OI, CI, NP, IO, ID, SA, FA). */
function flagPairs(flags: string): string[] {
  const out: string[] = [];
  for (let k = 0; k + 1 < flags.length; k += 2) out.push(flags.slice(k, k + 2));
  return out;
}

/** This user's SID from `whoami /user /fo csv /nh` ("domain\name","S-1-5-21-…"). */
export function parseWhoamiSid(out: string): string | undefined {
  const m = /"(S-1-\d+(?:-\d+)+)"\s*$/i.exec(out.trim());
  return m?.[1];
}

/**
 * 'ok' when every entry that grants access names this user, SYSTEM or Administrators (or CREATOR
 * OWNER on an inherit-only entry: the creator of an item inside, a same-user process); 'too_open'
 * when any other account is granted access or there is no DACL; 'unchecked' when the input cannot
 * be read.
 */
export function aclVerdict(sddl: string, userSid: string): AclVerdict {
  if (!SID.test(userSid)) return 'unchecked';
  const dacl = parseDacl(sddl);
  if (dacl === undefined) return 'unchecked';
  if (dacl === 'null') return 'too_open';
  const user = userSid.toUpperCase();
  for (const entry of dacl) {
    if (!entry.allow) continue;
    const sid = entry.sid.toUpperCase();
    if (sid === user || sid === SYSTEM || sid === ADMINISTRATORS) continue;
    if (sid === CREATOR_OWNER && entry.inheritOnly) continue;
    return 'too_open';
  }
  return 'ok';
}

const BASIC_ENV = [
  'windir',
  'SystemDrive',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'APPDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const;

/** %SystemRoot% when it is a plain `X:\Windows`-style folder, else C:\Windows. */
function systemRoot(env: Readonly<Record<string, string | undefined>>): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  return root !== undefined && /^[A-Za-z]:\\[A-Za-z0-9 ._-]+$/.test(root) ? root : 'C:\\Windows';
}

/**
 * The folder to check: `.agentlink` in the home folder, or, before it exists, the home folder it
 * will inherit its ACL from.
 */
export function dataFolderFor(
  homeDir: string,
  platform: string,
  exists: (path: string) => boolean,
): string {
  const folder =
    platform === 'win32' ? win32.join(homeDir, '.agentlink') : join(homeDir, '.agentlink');
  return exists(folder) ? folder : homeDir;
}

/** Checks `folder` on Windows (anything else: 'ok'). Never throws. */
export async function checkDataFolderAcl(
  platform: string,
  folder: string,
  env: Readonly<Record<string, string | undefined>>,
  runner: AclRunner,
): Promise<AclVerdict> {
  if (platform !== 'win32') return 'ok';
  const root = systemRoot(env);
  const system32 = `${root}\\System32`;
  // The OS basics the tools need; nothing that changes what runs (no PATH).
  const base: Record<string, string> = { SystemRoot: root };
  for (const name of BASIC_ENV) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  base['SystemRoot'] = root;
  let scratch: AclScratch | undefined;
  try {
    scratch = await runner.scratch();
    const saved = win32.join(scratch.dir, SAVED_NAME);
    const [, whoami] = await Promise.all([
      runner.run(`${system32}\\icacls.exe`, [folder, '/save', saved], base, ACL_TIMEOUT_MS),
      runner.run(`${system32}\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], base, ACL_TIMEOUT_MS),
    ]);
    const sddl = sddlFromSaved(decodeSaved(await scratch.read(SAVED_NAME)));
    const sid = parseWhoamiSid(whoami);
    return sid === undefined || sddl === undefined ? 'unchecked' : aclVerdict(sddl, sid);
  } catch {
    // A timeout, a tool that does not run, no output: unchecked, never ok.
    return 'unchecked';
  } finally {
    await scratch?.dispose().catch(() => undefined);
  }
}

/** The name of icacls's output file in the scratch folder. */
const SAVED_NAME = 'acl.txt';

/** icacls writes UTF-16LE (some versions with a byte order mark); anything else is read as UTF-8. */
export function decodeSaved(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[1] === 0 && b[0] !== 0) return b.toString('utf16le');
  return b.toString('utf8');
}

/** The SDDL line of `icacls <folder> /save` output (the line after the folder's name). */
export function sddlFromSaved(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  return lines.find((l, i) => i > 0 && /^(O:|G:|D:|S:)/.test(l));
}
