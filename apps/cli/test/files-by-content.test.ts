// FILES-AI-1 (D-152; 06 §2.3 "Send by content", §9; 04 §4 "Written by the AI into the Send folder"):
// `agentlink_send` with `file: {name, content}` through the CLI's MCP server with the real Node
// platform on a temp HOME. The content is written by the Attach writer (`writeSendFolderFile`) into
// the root of `~/AgentLink/Send` only, exclusively, never through a link, mode 0600, then sent from
// the bytes in memory; bob saves exactly those bytes. Another allowed folder is never written to.
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import type { FilesPlatform } from '@4thtech-io/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodeFileOpener, nodeFilesPlatform } from '../src/runtime/files.js';
import { coreToolClient } from '@4thtech-io/mcp-tools/context.js';
import {
  RelayNetwork,
  call,
  connect,
  logLines,
  makeAgent,
  pair,
  presence,
  setPolicy,
  toolContext,
  type Agent,
} from './files-harness.js';

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const now = (): number => Math.floor(Date.now() / 1000);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => encodeHex(sha256(b));

const MARKER = 'BYCONTENT-MARKER-AI1';
const NAME_CANARY = 'BYCONTENT-NAME-AI1';

let root: string;
let aliceHome: string;
let bobHome: string;
let send: string;
let work: string;
let net: RelayNetwork;
let alice: Agent;
let bob: Agent;
let aliceMcp: Client;
let bobMcp: Client;
let tamper = false;
/** Each owner policy change needs a higher version. */
let policyVersion = 1;
const setAlicePolicy = (edit: Parameters<typeof setPolicy>[1]) => {
  policyVersion += 1;
  return setPolicy(alice, edit, policyVersion);
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-bycontent-')));
  aliceHome = path.join(root, 'alice');
  bobHome = path.join(root, 'bob');
  send = path.join(aliceHome, 'AgentLink', 'Send');
  work = path.join(aliceHome, 'Work');
  await mkdir(send, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true });
  await mkdir(bobHome, { recursive: true });
  await writeFile(path.join(work, 'hello.txt'), 'hello by path');

  const base = nodeFilesPlatform({ home: aliceHome, drop: false });
  const write = base.writeSendFolderFile;
  if (write === undefined) throw new Error('the Node platform has no Send folder writer');
  // A same-user process that edits the Send folder copy right after the write (06 §2.3).
  const files: FilesPlatform = {
    ...base,
    writeSendFolderFile: async (input) => {
      const written = await write(input);
      if (written.ok && tamper) await writeFile(written.realpath, 'EDITED AFTER THE WRITE');
      return written;
    },
  };

  net = new RelayNetwork();
  alice = await makeAgent({
    keyStore: new MemoryKeyStore(seed(91)),
    owner: new MemoryOwnerKeyStore(seed(191), presence()),
    declaredName: 'Alice',
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
    net,
    clock: now,
    files,
  });
  bob = await makeAgent({
    keyStore: new MemoryKeyStore(seed(92)),
    owner: new MemoryOwnerKeyStore(seed(192), presence()),
    declaredName: 'Bob',
    relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
    net,
    clock: now,
    files: nodeFilesPlatform({ home: bobHome, drop: false }),
  });
  await setPolicy(bob, () => {});
  await pair(alice, bob);
  aliceMcp = await connect(
    toolContext(
      coreToolClient(alice.client, { files: nodeFileOpener({ home: aliceHome }) }),
      'alice',
    ),
  );
  bobMcp = await connect(
    toolContext(coreToolClient(bob.client, { files: nodeFileOpener({ home: bobHome }) }), 'bob'),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  tamper = false;
  await setAlicePolicy((p) => {
    p.files.allowedFolders = ['~/AgentLink/Send', '~/Work'];
  });
});

/** Every result alice's sends gave (bob's fetch returns the decrypted text by design, A12). */
const aliceResults: string[] = [];
async function aliceSend(args: Record<string, unknown>) {
  const out = await call(aliceMcp, 'agentlink_send', args);
  aliceResults.push(`${out.text}\n${JSON.stringify(out.structured)}`);
  return out;
}

/** Bob's copy of the newest message's file 0. */
async function bobGets(): Promise<{ name: string; bytes: Uint8Array }> {
  const inbox = await call(bobMcp, 'agentlink_inbox', {});
  const messages = inbox.structured['messages'] as { envelopeId: string }[];
  const last = messages.at(-1);
  if (last === undefined) throw new Error('nothing received');
  const fetched = await call(bobMcp, 'agentlink_fetch_file', { envelopeId: last.envelopeId });
  const savedTo = String(fetched.structured['savedTo']);
  return {
    name: String(fetched.structured['name']),
    bytes: new Uint8Array(await readFile(savedTo)),
  };
}

describe('agentlink_send with file on disk (06 §2.3)', () => {
  it('saves into the root of ~/AgentLink/Send (0600), sends it, and bob saves exactly the bytes', async () => {
    const content = `# Plan\n\nčšž 😀 ${MARKER}`;
    const sent = await aliceSend({
      to: 'Bob',
      text: 'the plan',
      file: { name: 'plan.md', content },
    });
    expect(sent.structured).toMatchObject({
      status: 'ok',
      file: {
        name: 'plan.md',
        size: utf8(content).length,
        plaintextSha256: hex(utf8(content)),
        delivery: 'inline',
        expiresAt: null,
      },
    });
    expect(String(sent.structured['summary'])).toMatch(
      /^Saved “plan\.md” in the user's Send folder \(~\/AgentLink\/Send\) and sent it to /,
    );
    const saved = path.join(send, 'plan.md');
    expect(await readFile(saved, 'utf8')).toBe(content);
    expect((await lstat(saved)).mode & 0o777).toBe(0o600);
    expect(await readdir(work)).toEqual(['hello.txt']);
    const got = await bobGets();
    expect(got.name).toBe('plan.md');
    expect(hex(got.bytes)).toBe(hex(utf8(content)));
  });

  it('the Send folder copy changed between the write and the send: bob still gets the input', async () => {
    tamper = true;
    const content = `the real input ${MARKER}`;
    const sent = await aliceSend({
      to: 'Bob',
      file: { name: 'tamper.md', content },
    });
    expect(sent.structured).toMatchObject({ status: 'ok' });
    expect(await readFile(path.join(send, 'tamper.md'), 'utf8')).toBe('EDITED AFTER THE WRITE');
    expect(hex((await bobGets()).bytes)).toBe(hex(utf8(content)));
  });

  it('a clash takes notes (2).md and a planted link at the target name is never followed', async () => {
    const victim = path.join(aliceHome, 'victim.txt');
    await writeFile(victim, 'keep me');
    await symlink(victim, path.join(send, 'linked.md'));
    const sent = await aliceSend({
      to: 'Bob',
      file: { name: 'linked.md', content: 'not into the link' },
    });
    expect(sent.structured).toMatchObject({ status: 'ok', file: { name: 'linked (2).md' } });
    expect(await readFile(victim, 'utf8')).toBe('keep me');
    expect((await lstat(path.join(send, 'linked.md'))).isSymbolicLink()).toBe(true);
    expect((await bobGets()).name).toBe('linked (2).md');
  });

  it('no folder allowed: needs_setup NO_ALLOWED_FOLDER, nothing written', async () => {
    await setAlicePolicy((p) => {
      p.files.allowedFolders = [];
    });
    const before = await readdir(send);
    const result = await aliceSend({
      to: 'Bob',
      file: { name: 'none.md', content: 'x' },
    });
    expect(result.structured).toMatchObject({ status: 'needs_setup', code: 'NO_ALLOWED_FOLDER' });
    expect(await readdir(send)).toEqual(before);
  });

  it('Send folder not allowed, a link or missing while another is allowed: SEND_FOLDER_UNAVAILABLE, the other untouched', async () => {
    await setAlicePolicy((p) => {
      p.files.allowedFolders = ['~/Work'];
    });
    const notAllowed = await aliceSend({
      to: 'Bob',
      file: { name: 'x.md', content: 'x' },
    });
    expect(notAllowed.structured).toMatchObject({
      status: 'error',
      code: 'SEND_FOLDER_UNAVAILABLE',
    });
    expect(await readdir(work)).toEqual(['hello.txt']);

    await setAlicePolicy((p) => {
      p.files.allowedFolders = ['~/AgentLink/Send', '~/Work'];
    });
    const moved = `${send}-moved`;
    await rm(moved, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.rename(send, moved));
    try {
      const missing = await aliceSend({
        to: 'Bob',
        file: { name: 'x.md', content: 'x' },
      });
      expect(missing.structured).toMatchObject({ code: 'SEND_FOLDER_UNAVAILABLE' });
      await symlink(work, send);
      const linked = await aliceSend({
        to: 'Bob',
        file: { name: 'x.md', content: 'x' },
      });
      expect(linked.structured).toMatchObject({ code: 'SEND_FOLDER_UNAVAILABLE' });
      expect(await readdir(work)).toEqual(['hello.txt']);
    } finally {
      await rm(send, { force: true });
      await import('node:fs/promises').then((fs) => fs.rename(moved, send));
    }
  });

  it('a name with a folder part and a type outside the allowlist write nothing', async () => {
    const before = await readdir(send);
    for (const [name, code] of [
      ['../Work/evil.md', 'FILE_NAME'],
      ['evil.md.exe', 'FILE_TYPE'],
    ] as const) {
      const r = await aliceSend({
        to: 'Bob',
        file: { name, content: 'x' },
      });
      expect(r.structured, name).toMatchObject({ status: 'rejected', code });
    }
    expect(await readdir(send)).toEqual(before);
    expect(await readdir(work)).toEqual(['hello.txt']);
  });

  it('path keeps resolving ~-relative paths', async () => {
    const r = await aliceSend({ to: 'Bob', path: '~/Work/hello.txt' });
    expect(r.structured).toMatchObject({ status: 'ok', file: { name: 'hello.txt' } });
  });

  it('a redaction scan: neither the requested name nor the content in any result or log line', async () => {
    await aliceSend({
      to: 'Bob',
      file: { name: `${NAME_CANARY}/x.md`, content: MARKER },
    });
    await aliceSend({
      to: 'Bob',
      file: { name: `${NAME_CANARY}.exe`, content: MARKER },
    });
    const all = [...aliceResults, ...logLines].join('\n');
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain(NAME_CANARY);
    expect(all).not.toContain(aliceHome);
  });
});
