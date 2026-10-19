// M1-9d-1: the file tools through the CLI's MCP server with the real Node platform (04 §4, 06 §2.3,
// §9): `agentlink_send` with `path` checks the path with realpath against `files.allowedFolders`
// without opening it (src/runtime/files.ts over @4thtech-io/node's M1-15 guards), and
// `agentlink_fetch_file` saves into a real inbox folder on disk. Two real cores talk over an
// in-memory relay network; the drop is not configured here (files-drop.worker.test.ts runs the real
// drop Worker), so a file above the inline limit needs own storage.
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeFileOpener, nodeFilesPlatform } from '../src/runtime/files.js';
import { coreToolClient } from '../src/tools/context.js';
import {
  RelayNetwork,
  call,
  connect,
  fileBytes,
  logLines,
  makeAgent,
  pair,
  presence,
  results,
  setPolicy,
  type Agent,
  toolContext,
} from './files-harness.js';

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const now = (): number => Math.floor(Date.now() / 1000);

let root: string;
let aliceHome: string;
let bobHome: string;
let net: RelayNetwork;
let alice: Agent;
let bob: Agent;
let aliceMcp: Client;
let bobMcp: Client;
let opens = 0;

const SMALL = fileBytes(700, 'SMALL-NODE-9d1');

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-files-')));
  aliceHome = path.join(root, 'alice');
  bobHome = path.join(root, 'bob');
  await mkdir(path.join(aliceHome, 'Work'), { recursive: true });
  await mkdir(path.join(aliceHome, '.ssh'), { recursive: true });
  await mkdir(bobHome, { recursive: true });
  await writeFile(path.join(aliceHome, 'Work', 'hello.txt'), SMALL);
  await writeFile(path.join(aliceHome, 'Work', '.env'), 'SECRET-DOTENV');
  await writeFile(path.join(aliceHome, 'Work', 'big.bin'), fileBytes(64 * 1024));
  await writeFile(path.join(aliceHome, 'secret.txt'), 'SECRET-OUTSIDE');
  await writeFile(path.join(aliceHome, '.ssh', 'id_test'), 'SECRET-SSH');
  await symlink(path.join(aliceHome, 'secret.txt'), path.join(aliceHome, 'Work', 'link.txt'));

  net = new RelayNetwork();
  const countingOpener = nodeFileOpener({
    home: aliceHome,
    onOpen: () => {
      opens += 1;
    },
  });
  alice = await makeAgent({
    keyStore: new MemoryKeyStore(seed(81)),
    owner: new MemoryOwnerKeyStore(seed(181), presence()),
    declaredName: 'Alice',
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
    net,
    clock: now,
    files: nodeFilesPlatform({ home: aliceHome, drop: false }),
  });
  bob = await makeAgent({
    keyStore: new MemoryKeyStore(seed(82)),
    owner: new MemoryOwnerKeyStore(seed(182), presence()),
    declaredName: 'Bob',
    relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
    net,
    clock: now,
    files: nodeFilesPlatform({ home: bobHome, drop: false }),
  });
  await setPolicy(bob, () => {});
  await pair(alice, bob);
  await setPolicy(alice, (p) => {
    p.files.allowedFolders = ['~/Work'];
  });
  aliceMcp = await connect(toolContext(coreToolClient(alice.client, { files: countingOpener }), 'alice'));
  bobMcp = await connect(
    toolContext(coreToolClient(bob.client, { files: nodeFileOpener({ home: bobHome }) }), 'bob'),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('agentlink_send with path and agentlink_fetch_file on disk', () => {
  it('sends a small file inline; bob saves it into his inbox folder (0600, exact bytes)', async () => {
    const sent = await call(aliceMcp, 'agentlink_send', {
      to: 'Bob',
      text: 'here it is',
      path: '~/Work/hello.txt',
    });
    expect(sent.structured).toMatchObject({
      status: 'ok',
      file: {
        name: 'hello.txt',
        size: SMALL.length,
        plaintextSha256: encodeHex(sha256(SMALL)),
        delivery: 'inline',
        expiresAt: null,
      },
    });
    expect(opens).toBe(1);

    const inbox = await call(bobMcp, 'agentlink_inbox', {});
    const [message] = inbox.structured['messages'] as { envelopeId: string }[];
    expect(message).toBeDefined();
    const fetched = await call(bobMcp, 'agentlink_fetch_file', {
      envelopeId: message!.envelopeId,
      fileIndex: 0,
    });
    const savedTo = path.join(bobHome, 'AgentLink', 'Inbox', 'hello.txt');
    expect(fetched.structured).toMatchObject({
      status: 'ok',
      savedTo,
      name: 'hello.txt',
      size: SMALL.length,
      integrity: 'verified',
    });
    expect(new Uint8Array(await readFile(savedTo))).toEqual(SMALL);
    expect((await lstat(savedTo)).mode & 0o777).toBe(0o600);

    // A second fetch never overwrites: it gets a new name.
    const again = await call(bobMcp, 'agentlink_fetch_file', { envelopeId: message!.envelopeId });
    expect(again.structured).toMatchObject({ status: 'ok', name: 'hello (1).txt' });
  });

  it('refuses traversal, hidden, protected and relative paths with fixed errors, never opening them', async () => {
    const before = { opens, published: net.published };
    const cases: [string, Record<string, unknown>][] = [
      [`${aliceHome}/Work/../secret.txt`, { status: 'rejected', code: 'PATH_NOT_ALLOWED' }],
      [`${aliceHome}/Work/.env`, { status: 'rejected', code: 'PATH_NOT_ALLOWED' }],
      ['~/.ssh/id_test', { status: 'rejected', code: 'PATH_NOT_ALLOWED' }],
      ['Work/hello.txt', { status: 'rejected', code: 'PATH_NOT_ALLOWED' }],
      [`${aliceHome}/Work`, { status: 'rejected', code: 'PATH_NOT_ALLOWED' }],
      [`${aliceHome}/Work/missing.txt`, { status: 'not_found', code: 'FILE_NOT_FOUND' }],
      // A symbolic link inside the allowed folder that points outside it (04 §4).
      [`${aliceHome}/Work/link.txt`, { status: 'needs_setup', code: 'OUTSIDE_ALLOWED_FOLDER' }],
      [`${aliceHome}/secret.txt`, { status: 'needs_setup', code: 'OUTSIDE_ALLOWED_FOLDER' }],
    ];
    for (const [arg, expected] of cases) {
      const result = await call(aliceMcp, 'agentlink_send', { to: 'Bob', path: arg });
      expect(result.structured, arg).toMatchObject(expected);
      const shown = `${result.text}\n${JSON.stringify(result.structured)}`;
      for (const part of ['SECRET', aliceHome, 'secret.txt', '.env', 'id_test', 'link.txt']) {
        expect(shown, arg).not.toContain(part);
      }
    }
    expect(opens).toBe(before.opens);
    expect(net.published).toBe(before.published);
  });

  it('with no allowed folder the send needs setup, in plain language, and reads nothing', async () => {
    await writeFile(path.join(bobHome, 'note.txt'), 'x');
    const result = await call(bobMcp, 'agentlink_send', {
      to: 'Alice',
      path: path.join(bobHome, 'note.txt'),
    });
    expect(result.structured).toMatchObject({ status: 'needs_setup', code: 'NO_ALLOWED_FOLDER' });
    expect(result.structured['nextStep']).toMatch(/allow/i);
  });

  it('a file above the inline limit with no storage available needs setup (own storage)', async () => {
    const result = await call(aliceMcp, 'agentlink_send', {
      to: 'Bob',
      path: `${aliceHome}/Work/big.bin`,
    });
    expect(result.structured).toMatchObject({ status: 'needs_setup', code: 'NEEDS_OWN_STORAGE' });
  });

  it('fetch_file for an unknown envelope or file index is not_found', async () => {
    const result = await call(bobMcp, 'agentlink_fetch_file', {
      envelopeId: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(result.structured).toMatchObject({ status: 'not_found' });
  });

  it('no result or log line carries a URL, a file key or alice\'s file paths (canary scan)', () => {
    const all = [...results, ...logLines].join('\n');
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toMatch(/fileKey|ciphertextSha256/);
    expect(all).not.toContain(aliceHome);
    expect(all).not.toContain('SECRET');
  });
});
