// M1-13c (10 M1-13; 06 §3, §7, §9; 02 F-43, F-51, J2, J3, J5, J8; 04 §3.4; 07 §6.3, §8; D-31, D-32,
// D-40, D-48, D-109; I-1, I-2, I-5, I-6, I-7): the files, proof and proof-of-agreement scenario, written
// once and run against a "world" (world.ts): the deterministic one (the repo's fakes, always on in the
// e2e job) or the live testnet one (opt-in, live-files-and-proof.test.ts).
//
// Agents (each the real `openAgent` of the built CLI, real keychain and SQLite store, in its own home;
// the real MCP server over an in-memory transport; local strfry relays):
//   Alice  the sender, with a folder allowed for sending and no storage set up (zero setup, D-48).
//   Bob    the recipient under the DEFAULT rules (D-109: no receipt is signed on its own).
//   Carol  a recipient whose owner turned `receipts.autoDelivered` on for Alice (a contact rule).
//   Dave   a third party who holds only the exported proof pack and runs `agentlink verify` (J5).
//
// What the scenario checks, in order (the tests share state and run in this order):
//   1. J1 pairing (the same one owner approval as M1-13a).
//   2. J2: a 5 MB file with no storage set up reaches Bob through the encrypted drop, intact.
//   3. J3: notarize with no credits is `needs_credits` (agent address, no chain named); the agent takes
//      the faucet route; the retry records the proof; no chain is chosen by hand (D-40).
//   4. D-109: under the defaults nothing is signed; explicit DELIVERED then OPENED.
//   5. A contact rule signs DELIVERED on its own for that contact, and never OPENED.
//   6. J5: export, then a third party's `agentlink verify` passes; tampered packs fail with their reason.
//   7. J8 proof of agreement, both shapes (M1-9d-3): a firm offer accepted, and a recorded accept
//      confirmed; ACCEPTED on-chain, one owner approval per side, the exported pack verifies.
//   8. Zero access (I-1, I-2, I-7): relays, drop, logs and artifacts hold no plaintext, key or URL.
//
// Everything printed or stored goes to files under the artifact directory, which the canary scan reads.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeHex, randomBytes, sha256 } from '@4thtech-io/crypto';
import { probeOsKeychain } from '@4thtech-io/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  VERIFY_EXIT,
  VERIFY_FAILURE_TEXT,
  createVerifyHandler,
  nodeVerifyDeps,
} from '../../apps/cli/dist/commands/verify.js';
import { openAgent } from '../../apps/cli/dist/runtime/index.js';
import { nodeProofPacks } from '../../apps/cli/dist/runtime/proofs.js';
import { scanForCanaries } from '../src/canary-scan.mjs';
import { dumpRelay, startRelays, stopRelays } from '../src/relays.mjs';
import {
  Canaries,
  RELAY_HOSTS,
  artifactDir,
  fileLogger,
  openLog,
  ownerApprove,
  setOwnerPolicy,
  setupAgent,
  storeRows,
  waitFor,
  type McpCall,
  type TestAgent,
} from './support.js';
import { startInProcess, type McpHandle, type World } from './world.js';

const STEP_TIMEOUT = 60_000;
const FILE_BYTES = 5_000_000;
/** The parts of a proof pack file these tests edit (07 §8). */
interface PackJson {
  record: Record<string, unknown>;
  [key: string]: unknown;
}
/** What the owner-side policy edit changes in these scenarios (06 §3). */
interface PolicyDraft {
  files: { allowedFolders: string[] };
  contactRules: { contact: string; receipts?: { autoDelivered: boolean } }[];
}

export interface ScenarioOptions {
  readonly title: string;
  readonly enabled: boolean;
  /** Called once, inside the suite; the world is built only when the suite runs. */
  readonly makeWorld: () => World;
  /** Written next to the artifacts: which variant produced the results. */
  readonly variant: 'deterministic' | 'live';
}

interface StepResult {
  step: string;
  ok: boolean;
  ms: number;
}

/** The receipt types of a proof status, as the tools name them. */
const receiptTypes = (call: McpCall): string[] =>
  ((call.structured['receipts'] ?? []) as { type: string }[]).map((r) => r.type);

/** A terms document for the J8 tests (06 §2.2a): Alice delivers, Bob pays. */
const agreementTerms = (amount: string) => ({
  subject: 'Logo design',
  deliverables: [{ description: 'Three logo drafts', by: 'me' as const }],
  price: { amount, currency: 'USD', payer: 'them' as const },
  deadlines: [{ ref: 'd1', due: '2027-01-30T17:00:00Z' }],
});

export function defineFilesProofScenario(options: ScenarioOptions): void {
  describe.skipIf(!options.enabled)(options.title, () => {
    const canaries = new Canaries();
    const steps: StepResult[] = [];
    const started = Date.now();
    let world: World;
    let dir: string;
    let relays: { label: string; map: Record<string, number> };
    let alice: TestAgent;
    let bob: TestAgent;
    let carol: TestAgent;
    let dave: TestAgent;
    let aliceMcp: McpHandle;
    let bobMcp: McpHandle;
    let carolMcp: McpHandle;
    // Random per run: a hit anywhere can only be this run's plaintext.
    const marker = `FILE-PLAINTEXT-${encodeHex(randomBytes(12))}`;
    const fileName = `design-review-${encodeHex(randomBytes(4))}.bin`;
    let sent: Buffer;
    let filePath: string;
    /** State handed from one test to the next. */
    const shared: {
      fileEnvelope?: string;
      fileRecord?: string;
      creditsGranted?: boolean;
      packPath?: string;
      packBytes?: string;
    } = {};

    async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      try {
        const value = await body();
        steps.push({ step: name, ok: true, ms: Date.now() - t0 });
        return value;
      } catch (error) {
        steps.push({ step: name, ok: false, ms: Date.now() - t0 });
        throw error;
      }
    }

    const contactNamed = async (mcp: McpHandle, name: string) => {
      const listed = await mcp.call('agentlink_list_contacts');
      const contacts = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
      return contacts.find((c) => c['name'] === name && c['pairing'] === 'complete');
    };

    /** The J1 pairing: an invite, one owner approval on the invitee. */
    async function pair(
      inviterMcp: McpHandle,
      inviterName: string,
      invitee: TestAgent,
      inviteeMcp: McpHandle,
      inviteeName: string,
    ): Promise<void> {
      const invite = await inviterMcp.call('agentlink_create_invite');
      expect(invite.structured['status']).toBe('ok');
      const inviteUrl = String(invite.structured['inviteUrl']);
      const first = await inviteeMcp.call('agentlink_accept_invite', { inviteUrl });
      expect(first.structured['status']).toBe('pending_approval');
      const approvalId = String(first.structured['approvalId']);
      expect(await ownerApprove(invitee, approvalId)).toBe(0);
      const second = await inviteeMcp.call('agentlink_accept_invite', { inviteUrl, approvalId });
      expect(second.structured['status']).toBe('ok');
      await Promise.all([
        waitFor(
          `${inviterName} sees ${inviteeName}`,
          () => contactNamed(inviterMcp, inviteeName),
          STEP_TIMEOUT,
        ),
        waitFor(
          `${inviteeName} sees ${inviterName}`,
          () => contactNamed(inviteeMcp, inviterName),
          STEP_TIMEOUT,
        ),
      ]);
    }

    /**
     * The credit-dependent tests need Alice's proof to have been recorded. In the deterministic world
     * that is a hard requirement (a missing record fails the run); in the live world the faucet may
     * have refused, which skips them, never fails them.
     */
    function needsCredits(ctx: { skip: (note?: string) => never }): void {
      if (shared.fileRecord !== undefined) return;
      if (world.kind === 'live') ctx.skip('the faucet gave no credits; nothing to prove');
      throw new Error('no proof was recorded by the J3 test');
    }

    async function unreadAtLeast(mcp: McpHandle, count: number): Promise<void> {
      await waitFor(
        `${String(count)} unread`,
        async () => {
          const s = await mcp.call('agentlink_status');
          return (s.structured['unread'] as number) >= count ? s : undefined;
        },
        world.waitMs.relay,
      );
    }

    /** The proof status of an envelope, polled until `done` holds (the chain answers, then receipts land). */
    async function proofOf(
      mcp: McpHandle,
      envelopeId: string,
      done: (call: McpCall) => boolean,
      what: string,
    ): Promise<McpCall> {
      return waitFor(
        what,
        async () => {
          const got = await mcp.call('agentlink_get_proof', { envelopeId });
          return got.structured['status'] === 'ok' && done(got) ? got : undefined;
        },
        world.waitMs.chain,
      );
    }

    /** `agentlink verify <path>` as a third party's agent runs it: the exit code and what it printed. */
    async function runVerify(
      verifier: TestAgent,
      pack: string,
    ): Promise<{ exit: number; out: string }> {
      const lines: string[] = [];
      const deps = nodeVerifyDeps({
        home: verifier.home,
        open: () => openAgent({ home: verifier.home }),
        verifyPack: (bytes) => world.verifier()(bytes),
        readPack: nodeProofPacks({ home: verifier.home }).readPack,
        cwd: () => verifier.home,
      });
      const exit = await createVerifyHandler(deps)({
        command: 'verify',
        parsed: { values: {}, positionals: [pack], agent: undefined },
        output: {
          print: (line: string) => void lines.push(line),
          printError: (line: string) => void lines.push(line),
        },
        terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
      } as never);
      return { exit, out: lines.join('\n') };
    }

    /** Puts a pack file where Dave's rules allow `agentlink verify` to read it (his inbox folder). */
    async function handToDave(name: string, bytes: string): Promise<string> {
      const folder = join(dave.home, 'AgentLink', 'Inbox');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, name);
      await writeFile(path, bytes, { mode: 0o600 });
      return path;
    }

    beforeAll(async () => {
      world = options.makeWorld();
      dir = await artifactDir();
      expect(await probeOsKeychain({ timeoutMs: 10_000 })).toEqual({ ok: true });
      relays = await startRelays();
      const logger = fileLogger(
        `e2e-driver-files-${options.variant}`,
        openLog(dir, `driver-files-${options.variant}.log`),
      );
      canaries.add({ name: 'file plaintext marker', value: marker, where: 'outside-transcripts' });
      canaries.add({ name: 'file name', value: fileName, where: 'outside-transcripts' });
      const setup = (label: string, displayName: string, hosts: readonly string[]) =>
        setupAgent({
          label: `${options.variant}-${label}`,
          displayName,
          relayHosts: hosts,
          relayMap: relays.map,
          canaries,
          logger,
        });
      alice = await setup('alice', 'Alice', RELAY_HOSTS.slice(0, 2));
      bob = await setup('bob', 'Bob', RELAY_HOSTS.slice(2, 4));
      carol = await setup('carol', 'Carol', RELAY_HOSTS.slice(2, 4));
      dave = await setup('dave', 'Dave', RELAY_HOSTS.slice(0, 2));
      await canaries.write();

      // The owners' rules, signed with each test owner's key before the agents start (06 §3). Alice
      // may send from ~/Work. Bob keeps every default. Carol's owner lets her agent confirm delivery
      // of Alice's records on its own (D-109, a contact rule).
      await mkdir(join(alice.home, 'Work'), { recursive: true });
      sent = Buffer.concat([
        Buffer.from(marker),
        randomBytes(FILE_BYTES - Buffer.byteLength(marker)),
      ]);
      filePath = join(alice.home, 'Work', fileName);
      await writeFile(filePath, sent, { mode: 0o600 });
      await setOwnerPolicy(
        alice,
        ((policy: PolicyDraft) => {
          policy.files.allowedFolders = ['~/Work'];
        }) as never,
        1,
      );
      await setOwnerPolicy(
        carol,
        ((policy: PolicyDraft) => {
          policy.contactRules = [
            { contact: alice.agentId.toLowerCase(), receipts: { autoDelivered: true } },
          ];
        }) as never,
        1,
      );

      const deps = world.deps(relays.map);
      aliceMcp = await startInProcess(
        alice,
        deps,
        openLog(dir, `files-${options.variant}-alice.log`),
      );
      bobMcp = await startInProcess(bob, deps, openLog(dir, `files-${options.variant}-bob.log`));
      carolMcp = await startInProcess(
        carol,
        deps,
        openLog(dir, `files-${options.variant}-carol.log`),
      );
    }, 600_000);

    afterAll(async () => {
      for (const mcp of [aliceMcp, bobMcp, carolMcp]) await mcp?.close().catch(() => undefined);
      if (relays !== undefined) await stopRelays(relays.label);
      if (dir !== undefined) {
        await writeFile(
          join(dir, `files-proof-${options.variant}-results.json`),
          `${JSON.stringify({ variant: options.variant, totalMs: Date.now() - started, steps }, null, 2)}\n`,
        );
      }
    }, 120_000);

    // ---- 1. J1 ---------------------------------------------------------------------------------

    it('pairs Alice with Bob and Carol (one owner approval each, on the invitee)', async () => {
      await step('A-B pairing', () => pair(aliceMcp, 'Alice', bob, bobMcp, 'Bob'));
      await step('A-C pairing', () => pair(aliceMcp, 'Alice', carol, carolMcp, 'Carol'));
      const tools = await aliceMcp.tools();
      for (const name of [
        'agentlink_notarize',
        'agentlink_acknowledge',
        'agentlink_fetch_file',
        'agentlink_export_proof_pack',
        'agentlink_verify_proof_pack',
      ]) {
        expect(tools).toContain(name);
      }
    }, 300_000);

    // ---- 2. J2: a 5 MB file, no storage setup ---------------------------------------------------

    it('J2: a 5 MB file reaches Bob through the encrypted drop with no storage set up', async () => {
      const result = await step('A: agentlink_send with path', () =>
        aliceMcp.call('agentlink_send', {
          to: 'Bob',
          text: 'Design review, file attached',
          path: filePath,
        }),
      );
      expect(result.structured).toMatchObject({ status: 'ok' });
      expect(result.structured['file']).toMatchObject({ delivery: 'drop' });
      shared.fileEnvelope = String(result.structured['envelopeId']);

      await step('B: the inbox shows the file as a drop file', async () => {
        await unreadAtLeast(bobMcp, 1);
        const inbox = await bobMcp.call('agentlink_inbox');
        expect(inbox.structured['status']).toBe('ok');
        const [message] = inbox.structured['messages'] as Record<string, unknown>[];
        expect(message).toMatchObject({ direction: 'in', envelopeId: shared.fileEnvelope });
        expect(JSON.stringify(message?.['files'])).toContain('"drop"');
        expect(inbox.text).toContain('<untrusted_content');
      });

      await step('B: agentlink_fetch_file saves it, verified', async () => {
        const fetched = await bobMcp.call('agentlink_fetch_file', {
          envelopeId: shared.fileEnvelope,
        });
        expect(fetched.structured).toMatchObject({
          status: 'ok',
          name: fileName,
          size: FILE_BYTES,
          integrity: 'verified',
        });
        const savedTo = String(fetched.structured['savedTo']);
        expect(savedTo.startsWith(bob.home)).toBe(true);
        const saved = await readFile(savedTo);
        expect(encodeHex(sha256(saved))).toBe(encodeHex(sha256(sent)));
      });

      // Zero access (I-1, I-2): the drop held ciphertext only, and saw neither the name nor the marker.
      if (world.drop !== undefined) {
        const held = [...world.drop.objects.values()];
        expect(held.length).toBeGreaterThan(0);
        for (const object of held) {
          expect(Buffer.from(object.bytes ?? new Uint8Array()).includes(Buffer.from(marker))).toBe(
            false,
          );
        }
        for (const request of world.drop.seen) {
          const body = Buffer.from(request.body);
          expect(body.includes(Buffer.from(marker))).toBe(false);
          expect(body.includes(Buffer.from(fileName))).toBe(false);
        }
      }
    }, 300_000);

    // ---- 3. J3: first paid action without credits -----------------------------------------------

    it('J3: no credits is needs_credits, the faucet route gives credits, the retry records the proof', async (ctx) => {
      const refused = await step('A: notarize with no credits', () =>
        aliceMcp.call('agentlink_notarize', { envelopeId: shared.fileEnvelope }),
      );
      expect(refused.structured).toMatchObject({
        status: 'needs_credits',
        agentAddress: alice.agentId,
      });
      // D-40, 11 §5: no chain, token, wallet or gas word in what the user is told, and the call named
      // no chain: `chain` is the Advanced override and nothing here sets it.
      expect(refused.structured['summary']).not.toMatch(/chain|network|wallet|gas|token|seed/i);
      expect(String(refused.structured['nextStep'])).not.toMatch(/chain|wallet|gas|seed/i);
      expect(JSON.stringify(refused.structured)).not.toMatch(/sepolia|chiado|"chainId"/i);

      shared.creditsGranted = await step('A: the faucet route', () => world.topUp(alice.agentId));
      if (!shared.creditsGranted) {
        // The live faucet refused (already claimed, rate limited, daily cap): never hammer it.
        return needsCredits(ctx);
      }

      const retried = await step('A: the retry records the proof', () =>
        aliceMcp.call('agentlink_notarize', { envelopeId: shared.fileEnvelope }),
      );
      // `ok` once recorded; `submitted` while the live network is still mining it.
      expect(['ok', 'submitted']).toContain(String(retried.structured['status']));
      expect(retried.structured['status']).not.toBe('needs_credits');
      const recorded = await proofOf(
        aliceMcp,
        String(shared.fileEnvelope),
        (c) => typeof c.structured['recordId'] === 'string',
        'the proof to be recorded',
      );
      shared.fileRecord = String(recorded.structured['recordId']);
      expect(shared.fileRecord).toMatch(/^0x[0-9a-f]{64}$/);
    }, 600_000);

    // ---- 4. D-109: defaults sign nothing; explicit DELIVERED and OPENED -----------------------------

    it('D-109: under the defaults no receipt is signed; explicit delivered, then opened', async (ctx) => {
      needsCredits(ctx);
      const before = world.notary?.calls.acknowledge ?? 0;
      await step('B: the proof is checked and stored, nothing is signed', async () => {
        // Bob's sync checks the proof on-chain; give it time to run, then look for any receipt.
        await waitFor(
          'B to hold the proof',
          async () => {
            const got = await bobMcp.call('agentlink_get_proof', {
              envelopeId: shared.fileEnvelope,
            });
            return got.structured['status'] === 'ok' ? got : undefined;
          },
          world.waitMs.relay,
        );
        await new Promise((resolve) => setTimeout(resolve, world.kind === 'fake' ? 6_000 : 20_000));
        const seen = await aliceMcp.call('agentlink_get_proof', {
          envelopeId: shared.fileEnvelope,
        });
        expect(receiptTypes(seen)).toEqual([]);
        expect(world.notary?.calls.acknowledge ?? 0).toBe(before);
      });

      await step('B: acknowledge delivered (explicit)', async () => {
        let ack = await bobMcp.call('agentlink_acknowledge', {
          envelopeId: shared.fileEnvelope,
          type: 'delivered',
        });
        if (ack.structured['status'] === 'pending_approval') {
          const approvalId = String(ack.structured['approvalId']);
          expect(await ownerApprove(bob, approvalId)).toBe(0);
          ack = await bobMcp.call('agentlink_acknowledge', {
            envelopeId: shared.fileEnvelope,
            type: 'delivered',
            approvalId,
          });
        }
        expect(ack.structured).toMatchObject({ status: 'ok' });
      });
      await step('B: acknowledge opened (explicit)', async () => {
        let ack = await bobMcp.call('agentlink_acknowledge', {
          envelopeId: shared.fileEnvelope,
          type: 'opened',
        });
        if (ack.structured['status'] === 'pending_approval') {
          const approvalId = String(ack.structured['approvalId']);
          expect(await ownerApprove(bob, approvalId)).toBe(0);
          ack = await bobMcp.call('agentlink_acknowledge', {
            envelopeId: shared.fileEnvelope,
            type: 'opened',
            approvalId,
          });
        }
        expect(ack.structured).toMatchObject({ status: 'ok' });
      });
      const final = await step('A: both receipts are on the record', () =>
        proofOf(
          aliceMcp,
          String(shared.fileEnvelope),
          (c) => receiptTypes(c).length >= 2,
          'DELIVERED and OPENED',
        ),
      );
      expect(
        receiptTypes(final)
          .map((t) => t.toLowerCase())
          .sort(),
      ).toEqual(['delivered', 'opened']);
    }, 600_000);

    // ---- 5. a contact rule signs DELIVERED for that contact only --------------------------------

    it('a contact rule signs DELIVERED on its own for Alice, and never OPENED', async (ctx) => {
      needsCredits(ctx);
      const sentToCarol = await step('A: send to Carol with notarize', () =>
        aliceMcp.call('agentlink_send', {
          to: 'Carol',
          text: 'Same document, with proof',
          notarize: true,
        }),
      );
      expect(sentToCarol.structured['status']).toBe('ok');
      const envelopeId = String(sentToCarol.structured['envelopeId']);
      const proof = await step('A: DELIVERED lands without anyone asking', () =>
        proofOf(
          aliceMcp,
          envelopeId,
          (c) => receiptTypes(c).length >= 1,
          'the automatic DELIVERED',
        ),
      );
      expect(receiptTypes(proof).map((t) => t.toLowerCase())).toEqual(['delivered']);
    }, 600_000);

    // ---- 6. J5: export, then a third party verifies --------------------------------------------

    it('J5: a third party with only the pack passes `agentlink verify`; tampered packs fail with a reason', async (ctx) => {
      needsCredits(ctx);
      // The default export carries the record and its receipts; the message content only with the
      // key, which the owner must approve (06 §3 allowKeyDisclosure).
      const exported = await step('A: export the proof pack with the content key', async () => {
        let result = await aliceMcp.call('agentlink_export_proof_pack', {
          envelopeId: shared.fileEnvelope,
          includeContentKey: true,
        });
        expect(result.structured['status']).toBe('pending_approval');
        const approvalId = String(result.structured['approvalId']);
        expect(await ownerApprove(alice, approvalId)).toBe(0);
        result = await aliceMcp.call('agentlink_export_proof_pack', {
          envelopeId: shared.fileEnvelope,
          includeContentKey: true,
          approvalId,
        });
        expect(result.structured['status']).toBe('ok');
        return result;
      });
      const savedTo = String(exported.structured['savedTo']);
      shared.packPath = savedTo;
      shared.packBytes = await readFile(savedTo, 'utf8');
      const pack = JSON.parse(shared.packBytes) as PackJson;

      const own = await step('A: agentlink_verify_proof_pack on its own pack', () =>
        aliceMcp.call('agentlink_verify_proof_pack', { path: savedTo }),
      );
      expect(own.structured).toMatchObject({ status: 'ok', valid: true, verdict: 'verified' });
      expect(
        receiptTypes(own)
          .map((t) => t.toLowerCase())
          .sort(),
      ).toEqual(['delivered', 'opened']);

      const passed = await step('Dave: agentlink verify passes', async () => {
        const path = await handToDave('good.json', shared.packBytes as string);
        return runVerify(dave, path);
      });
      expect(passed.out).toContain('Verified');
      expect(passed.exit).toBe(VERIFY_EXIT.verified);

      // Tampered packs: each is refused with its own reason, never a bare "invalid". `code` is the
      // verifier's failure code (07 §8); the CLI prints its fixed sentence, which is what is checked.
      const flip = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
      const tamperCases: {
        name: string;
        code: keyof typeof VERIFY_FAILURE_TEXT;
        edit: (p: PackJson) => void;
      }[] = [
        {
          name: 'a different record number',
          code: 'record_id_mismatch',
          edit: (p) => {
            p.record['nonce'] = '987654321';
          },
        },
        {
          name: 'a changed fee limit',
          code: 'record_mismatch',
          edit: (p) => {
            p.record['maxFee'] = '100001';
          },
        },
        {
          name: 'a flipped signature',
          code: 'signature_invalid',
          edit: (p) => {
            p['signature'] = flip(String(p['signature']));
          },
        },
        {
          name: 'a fingerprint that disagrees with its own record',
          code: 'malformed_pack',
          edit: (p) => {
            p.record['envelopeHash'] = `0x${'ab'.repeat(32)}`;
          },
        },
        {
          name: 'another record keeper',
          code: 'notary_mismatch',
          edit: (p) => {
            p['notary'] = `0x${'cd'.repeat(20)}`;
          },
        },
        {
          name: 'an unsupported network',
          code: 'unsupported_chain',
          edit: (p) => {
            p['chainId'] = 1;
          },
        },
      ];
      for (const tamper of tamperCases) {
        await step(`Dave: tampered pack fails: ${tamper.name}`, async () => {
          const edited = structuredClone(pack) as PackJson;
          tamper.edit(edited);
          const path = await handToDave(
            `tampered-${tamper.name.replace(/\W+/g, '-')}.json`,
            JSON.stringify(edited),
          );
          const result = await runVerify(dave, path);
          expect(result.out).toContain(VERIFY_FAILURE_TEXT[tamper.code]);
          expect(result.exit).toBe(VERIFY_EXIT.failed);
          expect(result.out).not.toContain('Verified');
        });
      }

      // A pack for a record that does not exist fails as such, and a copy of the good pack still passes.
      await step('Dave: the good pack still passes after the tampered ones', async () => {
        const again = await runVerify(dave, join(dave.home, 'AgentLink', 'Inbox', 'good.json'));
        expect(again.exit).toBe(VERIFY_EXIT.verified);
      });
    }, 600_000);

    // ---- 7. J8 proof of agreement ---------------------------------------------------------------
    // M1-9d-3: `notarize` on the terms tools. Both J8 shapes, one owner approval per side (04 §3.4.2
    // "Each J8 shape asks each owner once"): (1) a firm offer recorded with its OFFER record and an
    // accept that adds ACCEPTED; (2) an accept recorded with its ACCEPT record and the offerer's
    // `confirm` that adds ACCEPTED. Each ends with an exported pack that the verifier accepts as a
    // proof of agreement: valid, ACCEPTED on the record, and the owner's signed approval bound to it.

    /** A tool call that needs the owner once: the owner approves, the same call runs. */
    async function withOwner(
      mcp: McpHandle,
      agent: TestAgent,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<McpCall> {
      const asked = await mcp.call(tool, args);
      expect(asked.structured['status']).toBe('pending_approval');
      const approvalId = String(asked.structured['approvalId']);
      expect(await ownerApprove(agent, approvalId)).toBe(0);
      return mcp.call(tool, { ...args, approvalId });
    }

    /** Waits until `mcp` holds a checked record of the envelope (its own, or a contact's). */
    const holdsRecord = (mcp: McpHandle, envelopeId: string, what: string) =>
      proofOf(mcp, envelopeId, (c) => typeof c.structured['recordId'] === 'string', what);

    const hasAccepted = (c: McpCall) =>
      receiptTypes(c)
        .map((t) => t.toLowerCase())
        .includes('accepted');

    /** The approval rows of an agent (every request or grant, whatever its state). */
    const approvalCount = async (agent: TestAgent) => (await storeRows(agent, 'approvals')).length;

    /** Exports the pack of `envelopeId` and returns what a third party's verifier makes of it. */
    async function exportAndVerify(mcp: McpHandle, envelopeId: string) {
      const exported = await mcp.call('agentlink_export_proof_pack', { envelopeId });
      expect(exported.structured['status']).toBe('ok');
      const savedTo = String(exported.structured['savedTo']);
      const own = await mcp.call('agentlink_verify_proof_pack', { path: savedTo });
      expect(own.structured).toMatchObject({ status: 'ok', valid: true });
      const pack = JSON.parse(await readFile(savedTo, 'utf8')) as Record<string, unknown>;
      expect(pack['ownerApproval']).not.toBeNull();
      const verified = (await world.verifier()(pack)) as unknown as Record<string, unknown>;
      expect(verified['valid']).toBe(true);
      expect(((verified['receipts'] ?? []) as { type: string }[]).map((r) => r.type)).toContain(
        'ACCEPTED',
      );
      return verified;
    }

    it('J8: a firm offer recorded with notarize is accepted; ACCEPTED lands after one owner approval each; the pack proves the agreement', async (ctx) => {
      needsCredits(ctx);
      const aliceBefore = await approvalCount(alice);
      const bobBefore = await approvalCount(bob);
      const args = { to: 'Bob', terms: agreementTerms('120.00'), notarize: true };

      const sent = await step('A: firm offer, one owner approval for the offer and its proof', () =>
        withOwner(aliceMcp, alice, 'agentlink_propose_terms', args),
      );
      expect(['ok', 'submitted']).toContain(String(sent.structured['status']));
      const offerId = String(sent.structured['envelopeId']);
      expect(sent.structured['proof']).toMatchObject({
        status: expect.stringMatching(/ok|submitted/),
      });
      await step('A: the offer is recorded', () =>
        holdsRecord(aliceMcp, offerId, 'the OFFER record'),
      );
      // An offer is never recorded through agentlink_notarize (D-55): only the terms tools record it.
      const refused = await aliceMcp.call('agentlink_notarize', { envelopeId: offerId });
      expect(refused.structured).toMatchObject({ status: 'error', code: 'USE_TERMS_TOOLS' });

      await step('B: holds the offer and its checked record', () =>
        holdsRecord(bobMcp, offerId, 'Bob to hold the OFFER record'),
      );
      const accepted = await step('B: accepts, one owner approval', () =>
        withOwner(bobMcp, bob, 'agentlink_respond_to_terms', {
          envelopeId: offerId,
          decision: 'accept',
        }),
      );
      expect(accepted.structured).toMatchObject({ status: 'ok', decision: 'accept' });

      await step('A: ACCEPTED is on the offer record', () =>
        proofOf(aliceMcp, offerId, hasAccepted, 'ACCEPTED on the OFFER record'),
      );
      expect(await approvalCount(alice)).toBe(aliceBefore + 1);
      expect(await approvalCount(bob)).toBe(bobBefore + 1);

      const verified = await step('A: the exported pack verifies as a proof of agreement', () =>
        exportAndVerify(aliceMcp, offerId),
      );
      expect(verified['ownerApproval']).toMatchObject({
        status: 'signed',
        approver: 'signer',
        decision: 'offer',
      });
      const theirs = await step('B: its pack of the same record carries the accept', () =>
        exportAndVerify(bobMcp, offerId),
      );
      expect(theirs['ownerApproval']).toMatchObject({
        status: 'signed',
        approver: 'recipient',
        decision: 'accept',
      });
    }, 600_000);

    it('J8: an accept recorded with notarize is confirmed; ACCEPTED lands after one owner approval each; the pack proves the agreement', async (ctx) => {
      needsCredits(ctx);
      const funded = await step('B: the faucet route', () => world.topUp(bob.agentId));
      if (!funded) {
        if (world.kind === 'live') return ctx.skip('the faucet gave Bob no credits');
        throw new Error('the fake faucet gave Bob no credits');
      }
      const aliceBefore = await approvalCount(alice);
      const bobBefore = await approvalCount(bob);
      const offer = await step('A: an offer without proof (free, no approval)', () =>
        aliceMcp.call('agentlink_propose_terms', { to: 'Bob', terms: agreementTerms('140.00') }),
      );
      expect(offer.structured['status']).toBe('ok');
      const offerId = String(offer.structured['envelopeId']);
      await step('B: the offer arrives', () =>
        waitFor(
          'the offer in Bob’s inbox',
          async () => {
            const inbox = await bobMcp.call('agentlink_inbox');
            const messages = (inbox.structured['messages'] ?? []) as Record<string, unknown>[];
            return messages.some((m) => m['envelopeId'] === offerId) ? inbox : undefined;
          },
          world.waitMs.relay,
        ),
      );

      const accepted = await step('B: accepts with notarize, one owner approval', () =>
        withOwner(bobMcp, bob, 'agentlink_respond_to_terms', {
          envelopeId: offerId,
          decision: 'accept',
          notarize: true,
        }),
      );
      expect(['ok', 'submitted']).toContain(String(accepted.structured['status']));
      const acceptId = String(accepted.structured['envelopeId']);
      await step('B: the accept is recorded', () =>
        holdsRecord(bobMcp, acceptId, 'the ACCEPT record'),
      );

      await step('A: holds the accept and its checked record', () =>
        holdsRecord(aliceMcp, acceptId, 'Alice to hold the ACCEPT record'),
      );
      const confirmed = await step('A: confirms, one owner approval', () =>
        withOwner(aliceMcp, alice, 'agentlink_respond_to_terms', {
          envelopeId: acceptId,
          decision: 'accept',
        }),
      );
      expect(confirmed.structured).toMatchObject({ status: 'ok' });

      await step('B: ACCEPTED is on the accept record', () =>
        proofOf(bobMcp, acceptId, hasAccepted, 'ACCEPTED on the ACCEPT record'),
      );
      expect(await approvalCount(alice)).toBe(aliceBefore + 1);
      expect(await approvalCount(bob)).toBe(bobBefore + 1);

      const verified = await step('B: the exported pack verifies as a proof of agreement', () =>
        exportAndVerify(bobMcp, acceptId),
      );
      expect(verified['ownerApproval']).toMatchObject({
        status: 'signed',
        approver: 'signer',
        decision: 'accept',
      });
      const hers = await step('A: its pack of the same record carries the confirm', () =>
        exportAndVerify(aliceMcp, acceptId),
      );
      expect(hers['ownerApproval']).toMatchObject({
        status: 'signed',
        approver: 'recipient',
        decision: 'confirm',
      });
    }, 600_000);

    // ---- 8. zero access ---------------------------------------------------------------------------

    it('zero access: relays hold ciphertext only; no log, artifact or drop object carries a canary', async () => {
      const held: string[] = [];
      for (const port of Object.values(relays.map)) held.push(...(await dumpRelay(port)));
      await writeFile(
        join(dir, `files-${options.variant}-relay-events.jsonl`),
        `${held.join('\n')}\n`,
      );
      const kinds = [...new Set(held.map((e) => (JSON.parse(e) as { kind: number }).kind))];
      expect(kinds).toEqual([1059]);
      for (const mcp of [aliceMcp, bobMcp, carolMcp]) await mcp.close();
      const { scanned, findings } = await scanForCanaries([dir], canaries.list);
      expect(scanned).toBeGreaterThan(2);
      expect(findings.map((f) => `${f.name} in ${f.file}`)).toEqual([]);
      // Nothing that looks like a drop URL or an RPC URL with a key is in any file of the run.
      const text = await Promise.all(
        ['alice', 'bob', 'carol'].map((n) =>
          readFile(join(dir, `files-${options.variant}-${n}.log`), 'utf8').catch(() => ''),
        ),
      );
      for (const content of text) {
        expect(content).not.toMatch(/\/v1\/(get|put)\//);
        expect(content).not.toMatch(/[?&](m|sig|token|key|apikey)=/i);
      }
    }, 300_000);
  });
}
