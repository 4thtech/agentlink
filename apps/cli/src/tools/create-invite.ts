// `agentlink_create_invite` (06 §2.1; M1-9o). Creates a single-use invite record on this device:
// nothing leaves the device until the user shares the link (`openWorldHint: false`), and it needs no
// owner approval (the invite carries only this agent's own signed card, 04 §3.6).
//
// The link holds the invite secret. It goes into `inviteUrl` and `shareText` for the user's own agent
// to hand over, and nowhere else: never a log line (I-7). The `label` is agent-written, so the core
// stores it sealed as a suggested alias and it is shown restricted until the owner confirms it
// (06 §2.1); it is never echoed here.
import { CoreError } from '@agentlink/core';
import { copy, formatDate, renderCopy } from './strings/index.js';
import type { ToolContext } from './context.js';
import { INVITE_TEXT, inviteFailure } from './invite-common.js';
import { fail, notAvailable, type HandlerOutput } from './result.js';

const SUMMARY =
  'Invite ready: it works once, until {date}. Send it only to the person you want to connect with: whoever uses it first is connected.';

const rfc3339 = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface CreateInput {
  label?: string;
  expiresInDays?: number;
}

export async function createInviteHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const invites = context.client.invites;
  if (invites === undefined) return notAvailable();
  const args = input as CreateInput;
  try {
    const created = await invites.create({
      ...(args.label === undefined ? {} : { label: args.label }),
      ...(args.expiresInDays === undefined ? {} : { expiresInDays: args.expiresInDays }),
    });
    const date = formatDate(new Date(created.expiresAt * 1000));
    const shareText = copy('chat.status.ok.inviteShare', { date, inviteUrl: created.inviteUrl });
    const summary = renderCopy(SUMMARY, { date });
    const result = {
      status: 'ok' as const,
      summary,
      nextStep: INVITE_TEXT.createdNext,
      inviteUrl: created.inviteUrl,
      shareText,
      ownerFingerprint: created.ownerFingerprint.short,
      expiresAt: rfc3339(created.expiresAt),
    };
    // The text block carries the ready-to-send text, so a client that shows only text still has it.
    return { result, text: `${summary}\n${shareText}\n${INVITE_TEXT.createdNext}` };
  } catch (error) {
    if (error instanceof CoreError && error.code === 'name_invalid') {
      return fail(
        'error',
        INVITE_TEXT.invalidLabel,
        INVITE_TEXT.invalidLabelNextStep,
        'INVALID_ARGUMENT',
      );
    }
    if (error instanceof CoreError && error.code === 'invite_options_invalid') {
      return fail(
        'error',
        INVITE_TEXT.invalidOptions,
        INVITE_TEXT.invalidOptionsNextStep,
        'INVALID_ARGUMENT',
      );
    }
    const mapped = inviteFailure(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}
