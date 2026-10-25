// `agentlink_export_proof_pack` (06 §2.4, §2.0, §3; 07 §8; 04 §5; D-55, D-101; M1-9d-2).
//
// Core `exportProofPack` (M1-7g) builds the 07 §8 pack of one of this agent's own records. The
// content key goes into it only with the owner's approval (`proofs.allowKeyDisclosure`, never
// `allow`): the first call returns `pending_approval` and nothing is written; only the call that
// names the approved `approvalId` gets the pack. The recipient and its salt are disclosed only when
// asked (`includeRecipient`, default false; 04 §5 "unlinkable unless disclosed").
//
// The pack is written by the platform into `proofs.exportFolder` (a new 0600 file, never
// overwriting, never following a link). The result carries the saved path and the record ID only:
// never the pack, the content key or the salt (I-7). Not read-only (it writes a file), not
// idempotent (each call saves a new file), not open-world (06 §2.0).
import type { ExportProofPackInput } from '@4thtech-io/core';
import type { ToolContext } from './context.js';
import {
  invalidArgument,
  isOutput,
  needsIdentity,
  notAvailable,
  oneTarget,
  proofRefusal,
  proofThrown,
} from './proofs-common.js';
import { exportDisclosure, withDisclosure } from './strings/privacy.js';
import { fail, internalError, ok, pendingApproval, type HandlerOutput } from './result.js';
import { NPX_COMMAND } from './cli-command.js';

export const EXPORT_TEXT = Object.freeze({
  saved:
    'Saved the proof file into the AgentLink proofs folder. Anyone with it can check the proof on the AgentLink verify page.',
  savedWithContent:
    'Saved the proof file into the AgentLink proofs folder. It includes the message content: share it only with people who may read it.',
  approval:
    "Including the message content in a proof file needs the owner's approval, so nothing was saved yet.",
  notRecorded: "That message has no recorded proof yet, so there's nothing to save.",
  notRecordedNextStep:
    'Add proof first with agentlink_notarize, or check its state with agentlink_get_proof.',
  received:
    "A proof file can be saved only for messages this agent recorded, so there's nothing to save.",
  receivedNextStep: 'Ask the contact who recorded it to share their proof file.',
  folder: "The AgentLink proofs folder can't take files right now, so nothing was saved.",
  folderNextStep:
    'Tell the user their AgentLink proofs folder is missing, hidden or protected. Only they can choose another one.',
  rules: "The owner's rules can't be read right now, so nothing was saved.",
  rulesNextStep: `Tell the user to run \`${NPX_COMMAND} doctor\` in their own terminal to check their rules.`,
  policyDenied: "The owner's rules don't allow sharing the message content, so nothing was saved.",
  policyDeniedNextStep:
    'Call again without includeContentKey to save a proof file without the content.',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function refusal(code: string): HandlerOutput {
  switch (code) {
    case 'NOT_RECORDED':
      return fail('not_found', EXPORT_TEXT.notRecorded, EXPORT_TEXT.notRecordedNextStep, code);
    case 'RECORD_UNAVAILABLE':
      return fail('error', EXPORT_TEXT.received, EXPORT_TEXT.receivedNextStep, code);
    case 'POLICY_DENIED':
      return fail('rejected', EXPORT_TEXT.policyDenied, EXPORT_TEXT.policyDeniedNextStep, code);
    default:
      return proofRefusal(code);
  }
}

export async function exportProofPackHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const target = oneTarget(input);
  if (target === undefined) return invalidArgument();
  const { includeContentKey, includeRecipient, approvalId } = input;
  const self = await needsIdentity(context);
  if (isOutput(self)) return self;
  const proofs = context.client.proofs;
  if (proofs === undefined) return notAvailable();

  const withKey = includeContentKey === true;
  const request: ExportProofPackInput = {
    ...target,
    ...(withKey ? { includeContentKey: true } : {}),
    includeRecipient: includeRecipient === true,
    ...(typeof approvalId === 'string' ? { approvalId } : {}),
  };
  let result;
  try {
    result = await proofs.exportPack(request);
  } catch (error) {
    return proofThrown(error);
  }
  switch (result.status) {
    case 'pending_approval':
      // Nothing is written before the owner approved (06 §2.4, §3).
      return pendingApproval(
        context,
        result.approvalId,
        withDisclosure(EXPORT_TEXT.approval, exportDisclosure()),
      );
    case 'rejected':
      context.logger.info('proof pack refused', { code: result.code });
      return refusal(result.code);
    case 'ok': {
      let json: string;
      try {
        json = `${JSON.stringify(result.pack, null, 2)}\n`;
      } catch {
        return internalError();
      }
      const saved = await proofs.savePack(result.recordId, json);
      if (!saved.ok) {
        return saved.reason === 'rules'
          ? fail('rejected', EXPORT_TEXT.rules, EXPORT_TEXT.rulesNextStep, 'POLICY_DENIED')
          : fail(
              'error',
              EXPORT_TEXT.folder,
              EXPORT_TEXT.folderNextStep,
              'EXPORT_FOLDER_UNAVAILABLE',
            );
      }
      context.logger.info('proof pack saved', { content: withKey });
      return ok(
        withDisclosure(
          withKey ? EXPORT_TEXT.savedWithContent : EXPORT_TEXT.saved,
          exportDisclosure(),
        ),
        {
          savedTo: saved.savedTo,
          recordId: result.recordId,
        },
      );
    }
    default:
      return internalError();
  }
}
