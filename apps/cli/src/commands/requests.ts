// `agentlink requests` (M1-9l, moved from M1-9a; D-72; 06 §3, §8; 11 §6.2.1, §9; 07 §3.2).
//
// For requests from unknown senders: list, accept, ignore, ignore --all, block, blocked, unblock.
// The dispatcher requires an interactive terminal with no harness marker (a UX guard, not a
// boundary: G-1, D-67). In M1 these need no owner presence, the explicit exception of 11 §6.2.1:
// ignore and block only take away, and accept exposes, still wrapped, only what a same-user process
// can already read from the store. None of them is an MCP tool (I-4), and none creates a contact:
// a contact comes only from a completed pairing (04 §2.9, D-72).
//
// Output (06 §8, I-5): an unknown sender is never named. The request's content is shown inside the
// marked untrusted region, every value sanitized and cut; the fixed lines (how to act, the request
// ID) come after it. The core returns no payload for a request, so the region holds only the
// envelope type the sender declared. The sender code (04 §2.9) comes from core
// (`RequestEntry.senderCode`, M1-9c-b): short, or extended when two unknown senders collide. It is
// printed only if it has the code's own shape, never anything else as a name.
import type { RequestEntry, RequestsQueue } from '@4thtech-io/core';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandHandler,
} from '../dispatch.js';
import {
  formatDate,
  formatTime,
  copy,
  renderCopy,
  unknownSenderLabel,
} from '../tools/strings/index.js';
import { batchRegions, untrustedRegion } from '../terminal/sanitize.js';
import { TEXT, createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';

/** An envelope ID as core stores it: 16 bytes of base64url. Anything else is not shown as a handle. */
const SHOWN_ID = /^[A-Za-z0-9_-]{22}$/;
/** A handle typed by the user. Core checks it again (length) and finds or refuses it. */
const TYPED_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A sender key: 64 lowercase hex. */
const KEY = /^[0-9a-f]{64}$/;

/** A sender code: short `2B9E·04D1` or extended `2B9E·04D1·5D0E·88B1` (04 §2.9). */
const SENDER_CODE = /^[0-9A-F]{4}·[0-9A-F]{4}(?:·[0-9A-F]{4}·[0-9A-F]{4})?$/;

const unknownWho = (entry: RequestEntry): string =>
  typeof entry.senderCode === 'string' && SENDER_CODE.test(entry.senderCode)
    ? unknownSenderLabel(entry.senderCode)
    : 'an unknown sender';

function when(entry: RequestEntry): string | undefined {
  const at = entry.createdAt;
  if (!Number.isSafeInteger(at) || at <= 0 || at > 253_402_300_799) return undefined;
  const date = new Date(at * 1000);
  return `${formatDate(date)} ${formatTime(date)} UTC`;
}

/** One request: the marked region first, then the fixed lines (06 §8). */
function describeRequest(entry: RequestEntry, index: number): string[] {
  const who = unknownWho(entry);
  const values: string[] = [`Type: ${entry.type}`];
  const time = when(entry);
  if (time !== undefined) values.push(`Sent: ${time}`);
  return [
    fill(TEXT.requestRow, { index }),
    ...untrustedRegion(who, values),
    SHOWN_ID.test(entry.envelopeId)
      ? fill(TEXT.requestId, { requestId: entry.envelopeId })
      : TEXT.requestIdUnavailable,
    ...(entry.acceptedAt === null ? [] : [TEXT.requestReadable]),
  ];
}

async function interactive(
  context: Parameters<CommandHandler>[0],
  deps: CommandDeps,
  requests: RequestEntry[],
  act: (letter: string, entry: RequestEntry) => Promise<void>,
): Promise<number> {
  if (requests.length === 0) {
    context.output.print(copy('cli.requests.none'));
    return EXIT_OK;
  }
  const { shown, omitted } = batchRegions(requests);
  context.output.print(copy('cli.requests.header', { count: requests.length }));
  const prompter = deps.prompter();
  try {
    let index = 0;
    for (const entry of shown) {
      index += 1;
      context.output.print('');
      printAll(context, describeRequest(entry, index));
      context.output.print(copy('cli.requests.choose'));
      const answer = await prompter.ask();
      if (answer === undefined) break;
      const letter = answer.trim().toLowerCase();
      if (letter === 'a' || letter === 'i' || letter === 'b') await act(letter, entry);
    }
  } finally {
    prompter.close();
  }
  if (omitted > 0) {
    context.output.print('');
    context.output.print(renderCopy(TEXT.requestMore, { count: omitted }));
  }
  return EXIT_OK;
}

export function createRequestsHandler(deps: CommandDeps = createDeps()): CommandHandler {
  return (context) => {
    const [sub, argument, ...extra] = context.parsed.positionals;
    const all = context.parsed.values['all'] === true;
    const bad = (): Promise<number> => {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    };
    if (extra.length > 0) return bad();
    if (all && sub !== 'ignore') return bad();
    if (all && argument !== undefined) return bad();
    const known = [undefined, 'accept', 'ignore', 'block', 'blocked', 'unblock'];
    if (!known.includes(sub)) return bad();
    if (sub === undefined && argument !== undefined) return bad();
    if (sub === 'blocked' && argument !== undefined) return bad();

    return withAgent(context, deps, async ({ client }) => {
      const queue = client.requests;
      const notFound = (): number => {
        context.output.printError(TEXT.requestNotFound);
        return EXIT_FAILED;
      };

      const blockOne = async (requestId: string): Promise<number> => {
        const result = await queue.block(requestId);
        if (result.status === 'blocked') {
          context.output.print(copy('local.requests.blocked'));
          return EXIT_OK;
        }
        if (result.status === 'sender_is_contact') {
          context.output.printError(TEXT.requestIsContact);
          return EXIT_FAILED;
        }
        return notFound();
      };

      const ignoreOne = async (requestId: string): Promise<number> => {
        const entry = (await queue.list()).find((r) => r.envelopeId === requestId);
        if (entry === undefined) return notFound();
        await queue.ignore(entry.fromKey);
        context.output.print(copy('local.requests.ignored'));
        return EXIT_OK;
      };

      switch (sub) {
        case undefined:
          return interactive(context, deps, await queue.list(), async (letter, entry) => {
            if (letter === 'a') {
              const accepted = await queue.accept(entry.envelopeId);
              if (accepted) context.output.print(copy('local.requests.accepted'));
              else context.output.printError(TEXT.requestNotFound);
            } else if (letter === 'i') {
              await queue.ignore(entry.fromKey);
              context.output.print(copy('local.requests.ignored'));
            } else {
              await blockOne(entry.envelopeId);
            }
          });

        case 'accept': {
          if (argument === undefined) {
            context.output.printError(fill(TEXT.requestNeedsId, { action: 'accept' }));
            return EXIT_USAGE;
          }
          if (!TYPED_ID.test(argument) || !(await queue.accept(argument))) return notFound();
          context.output.print(copy('local.requests.accepted'));
          return EXIT_OK;
        }

        case 'ignore': {
          if (all) {
            await queue.ignoreAll();
            context.output.print(copy('local.requests.ignoredAll'));
            return EXIT_OK;
          }
          if (argument === undefined) {
            context.output.printError(fill(TEXT.requestNeedsId, { action: 'ignore' }));
            return EXIT_USAGE;
          }
          return TYPED_ID.test(argument) ? ignoreOne(argument) : notFound();
        }

        case 'block': {
          if (argument === undefined) {
            context.output.printError(fill(TEXT.requestNeedsId, { action: 'block' }));
            return EXIT_USAGE;
          }
          return TYPED_ID.test(argument) ? blockOne(argument) : notFound();
        }

        case 'blocked': {
          const blocked: Awaited<ReturnType<RequestsQueue['listBlocked']>> =
            await queue.listBlocked();
          if (blocked.length === 0) {
            context.output.print(TEXT.blockedNone);
            return EXIT_OK;
          }
          const lines = [renderCopy(TEXT.blockedHeader, { count: blocked.length })];
          blocked.forEach((entry, index) => {
            lines.push(
              '',
              fill(TEXT.blockedRow, { index: index + 1 }),
              KEY.test(entry.fromKey)
                ? fill(TEXT.blockedKey, { key: entry.fromKey })
                : 'Key: unavailable',
            );
          });
          lines.push('', TEXT.blockedHow);
          printAll(context, lines);
          return EXIT_OK;
        }

        default: {
          // unblock <key>: by the sender key, never by an envelope ID the sender chose (IR-D-72-1 F03).
          if (argument === undefined) {
            context.output.printError(TEXT.unblockNeedsKey);
            return EXIT_USAGE;
          }
          const key = argument.trim().toLowerCase();
          if (!KEY.test(key) || !(await queue.unblock(key))) {
            context.output.printError(TEXT.unblockNone);
            return EXIT_FAILED;
          }
          context.output.print(copy('local.requests.unblocked'));
          return EXIT_OK;
        }
      }
    });
  };
}

export const requestsHandler: CommandHandler = createRequestsHandler();
