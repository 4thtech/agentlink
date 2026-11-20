// `agentlink owner servers` (NET-CLI, 0.5.15; D-158; 06 §8; 04 §2.5, §2.6; 07 §4.3; 11 §5.14; I-4,
// I-5, I-7): the terminal twin of Advanced › Message network › "Use your own servers".
//
// - `list` (also bare `owner servers`) and `test <wss://…>…`: read-only, no presence, no owner
//   guard. `list` reads the open ID's own servers (roles, a bounded health check), the mix-in, the
//   announce choice and the leaving servers with their ends; `test` runs the app's server test
//   (@4thtech-io/node testOwnServers: the same precheck and the same per-process budget). `--json`
//   for both: fixed keys (they may say relay, 11 §5.14), hosts only.
// - `set <wss://…>… [--no-automatic] [--no-announce]` and `reset` †: the owner guard first (an
//   interactive terminal and no AI-harness marker; a UX guard, not a boundary, D-67), then
//   @4thtech-io/node changeServersAtTerminal: the review (this module's words for the plan's fixed
//   fields), "Continue?", owner presence at its own prompt, then exactly that card signed through
//   signServerChange, the app's path. Nothing here plans, tests for a change or signs.
//   `--no-announce` needs `--no-automatic` (`mix_in_on`), refused before anything runs.
// - Nothing typed is echoed (I-5): an address that fails the URL rule is "Server {n}". Only hosts
//   are printed, never a full address, path or credential. Nothing is logged (I-7).
// - No MCP tool reaches any of this (I-4). The words say "server", never "relay" (11 §5.1).
import { holdsDefaultServer } from '@4thtech-io/core';
import { formatDate } from '@4thtech-io/mcp-tools/strings/index.js';
import type { ServerChangeRequest, ServerChangeReview } from '@4thtech-io/node';
import { relayOrigin, type PrecheckResult } from '@4thtech-io/transport-nostr';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import type { Output } from '../../output.js';
import { commandPrefix } from '../../runtime/cli-prefix.js';
import { checkOwnerTerminal } from '../../runtime/guards.js';
import { sanitizeTerminalText } from '../../terminal/sanitize.js';
import { badArguments, chooseAgent, ownerContext } from './common.js';
import type { OwnerAgent, OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** At most this many addresses (07 §4.3: a list holds 2 to 8). */
const MAX_SERVERS = 8;
/** The longest address accepted (the relay URL rule's own cap, 04 §4). */
const MAX_URL_CHARS = 256;
/** The column the state starts in. */
const HOST_COLUMN = 28;

const date = (unix: number): string => formatDate(new Date(unix * 1000));

type Refusal =
  | 'mix_in_on'
  | 'invalid_list'
  | 'not_ready'
  | 'same_list'
  | 'too_many_previous'
  | 'rotation_pending'
  | 'agent_paused'
  | 'busy'
  | 'not_applied';

/** Fixed text (11 §5.14; I-5: nothing typed is repeated). */
export const SERVERS_TEXT = Object.freeze({
  runYourself:
    'Problem  Run this yourself in a terminal. AgentLink never asks you to add a server.',
  changed: 'OK       Servers changed. Your contacts get your new details.',
  reset: 'OK       Back to automatic servers.',
  oldUntil: (unix: number): string => `         Old servers stay readable until ${date(unix)}.`,
  failed: "Problem  That didn't go through. Your servers didn't change.",
  busy: 'Problem  A server test is already running, or too many ran this minute. Try again in a minute.',
  mixInOn: "Also use AgentLink's automatic servers: on",
  mixInOff: "Also use AgentLink's automatic servers: off",
  announceOn: "Don't also announce on the default servers: off",
  announceOff: "Don't also announce on the default servers: on",
  paused: 'Paused · Resume to change servers',
  finishing: 'An earlier change of this ID is still finishing. Try again in a minute.',
  tooManyFrom: (unix: number): string =>
    [
      'Problem  Too many old servers are still being read.',
      `         You can change again from ${date(unix)}, or go back to automatic now.`,
    ].join('\n'),
  refused: Object.freeze<Record<Refusal, string>>({
    mix_in_on:
      'Problem  "Don\'t also announce on the default servers" works only without AgentLink\'s automatic servers. Add --no-automatic, or leave it out.',
    get invalid_list(): string {
      return "Problem  Check the addresses: public servers only, starting with wss://. Use 2 to 8 servers, or 1 to 6 with AgentLink's automatic servers.";
    },
    get not_ready(): string {
      return `Problem  Two working servers are needed. Run \`${commandPrefix()} owner servers test\` to see which ones work.`;
    },
    same_list: 'Problem  These are already your servers.',
    too_many_previous:
      'Problem  Too many old servers are still being read. Go back to automatic now, or try again later.',
    rotation_pending:
      'Problem  An earlier change of this ID is still finishing. Try again in a minute.',
    agent_paused: 'Problem  Your ID is paused. Resume it first, then change servers.',
    busy: 'Problem  A server test is already running, or too many ran this minute. Try again in a minute.',
    not_applied: "Problem  That didn't go through. Your servers didn't change.",
  }),
});

/** A test outcome in plain words (11 §5.14): the state and, when it is not plainly ready, why. */
function testWords(r: PrecheckResult): { readonly state: string; readonly detail?: string } {
  const ms = typeof r.roundTripMs === 'number' ? r.roundTripMs : undefined;
  switch (r.outcome) {
    case 'ready':
      return { state: ms === undefined ? 'Ready' : `Ready · ${String(ms)} ms` };
    case 'slow':
      return {
        state: ms === undefined ? 'Ready · slow' : `Ready · slow ${(ms / 1000).toFixed(1)} s`,
        detail: 'Works, but answers slowly. Messages may arrive a little later.',
      };
    case 'sign_in':
      return {
        state: 'Needs sign-in to read',
        detail:
          "It accepts messages but asks for a sign-in before it lets anyone read them. AgentLink can't sign in there, so we can't confirm your messages arrive.",
      };
    case 'refused':
      break;
  }
  switch (r.reason) {
    case 'not_accepted':
      return {
        state: "Doesn't accept messages",
        detail:
          "It refused a test message from someone it doesn't know. Servers like this only take messages from approved people.",
      };
    case 'not_kept':
      return {
        state: "Didn't keep the test message",
        detail: "It said yes to the test message but couldn't give it back a moment later.",
      };
    case 'not_allowed':
      return {
        state: 'Not allowed',
        detail:
          'Only public internet servers (wss://) can be used. Addresses inside a home or office network are blocked for your safety.',
      };
    case 'too_small':
      return {
        state: 'Messages too large for it',
        detail: "It only takes messages smaller than AgentLink's. Try another server.",
      };
    case 'invalid':
      return { state: 'Not a server address', detail: 'Check the address. It starts with wss://.' };
    case 'unreachable':
    default:
      return {
        state: "Can't reach",
        detail: 'No answer. Check the address, or whether the server is running.',
      };
  }
}

/** One row: the host (sanitized, never a full address) padded to the state column. */
const row = (host: string, state: string): string => {
  const shown = sanitizeTerminalText(host);
  return `  ${shown.padEnd(HOST_COLUMN)} ${state}`;
};

/** The warning words of the review (11 §5.14). */
const WARNING_WORDS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  slow: ['A server answers slowly', 'Works, but messages may arrive a little later.'],
  sign_in: [
    'One server needs a sign-in to read',
    "That's fine as long as 2 other servers work, and they do. We can't confirm delivery on this one.",
  ],
  paid: ['A server may charge for use', 'Check with whoever runs it.'],
  mix_in_off: [
    'Only your servers will carry your messages',
    'If all of yours are down, nothing gets through until one is back. Most people leave this on.',
  ],
  mix_in_short: [
    "Fewer of AgentLink's automatic servers answered",
    'Fewer were mixed in. Your own servers still carry your messages.',
  ],
  announce_off: [
    'Only your servers will know this ID',
    "AgentLink's old public servers stop being used at once; your own previous servers stay readable for 30 days. Another computer can find this ID only with your owner link or a backup. Contacts still using an old copy of your contact details may not reach you until they receive the update.",
  ],
});

/** The review lines for the plan @4thtech-io/node tested (hosts and fixed codes only). */
export function reviewLines(review: ServerChangeReview): readonly string[] {
  const lines: string[] = [];
  const latest = review.leaving.reduce<number | undefined>(
    (max, e) => (max === undefined || e.until > max ? e.until : max),
    undefined,
  );
  if (review.kind === 'reset') {
    lines.push(
      "Use AgentLink's automatic servers?",
      'Go back to the default. Takes one approval.',
      '         AgentLink picks the servers for you again.',
      '         Your own list is forgotten here.',
    );
    if (latest !== undefined) {
      lines.push(`         Your custom servers stay readable for 30 days, until ${date(latest)}.`);
    }
  } else {
    lines.push(
      'Review',
      'Nothing changes until you approve.',
      `Use these ${String(review.servers.length)} message servers`,
    );
    for (const s of review.servers) {
      const role =
        s.role === 'automatic'
          ? 'Automatic mix-in'
          : s.outcome === 'slow'
            ? 'Yours · Ready, slow'
            : s.outcome === 'sign_in'
              ? 'Yours · Needs sign-in to read'
              : 'Yours · Ready';
      lines.push(row(s.host, role));
    }
    if (latest !== undefined) {
      const hosts = review.leaving.map((e) => sanitizeTerminalText(e.host)).join(', ');
      lines.push(
        'Your old servers stay readable for 30 days',
        `         Until ${date(latest)}, nothing sent to your old servers is missed: ${hosts}.`,
      );
    }
  }
  lines.push(
    'Your contacts get your new details once',
    review.contacts === 0
      ? '         You have no contacts to tell yet.'
      : `         AgentLink sends the update to all ${String(review.contacts)} for you.`,
  );
  if (review.kind === 'servers') {
    lines.push(
      'What servers can see',
      "         That you're online, and scrambled messages. Never what's inside them.",
    );
  }
  for (const code of review.warnings) {
    const words = WARNING_WORDS[code];
    if (words === undefined) continue;
    lines.push(`Notice   ${words[0]}`, `         ${words[1]}`);
  }
  return lines;
}

/** The typed addresses, or undefined (1 to 8, `wss://`, bounded, no spaces or control characters). */
function addressesOf(values: readonly string[]): readonly string[] | undefined {
  if (values.length === 0 || values.length > MAX_SERVERS) return undefined;
  for (const v of values) {
    if (v.length > MAX_URL_CHARS || !/^wss:\/\/[^\s\p{Cc}]+$/iu.test(v)) return undefined;
  }
  return values;
}

const flag = (context: CommandContext, name: string): boolean =>
  context.parsed.values[name] === true;

/** `list`: no presence. */
async function listOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output } = context;
  if (flag(context, 'no-automatic') || flag(context, 'no-announce')) return badArguments(output);
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    return await printList(agent, output, flag(context, 'json'));
  } catch {
    output.printError(OWNER_TEXT.noIdentity);
    return EXIT_FAILED;
  } finally {
    await agent.close();
  }
}

type Health = 'ready' | 'timeout' | 'unreachable' | 'blocked' | 'invalid' | 'unknown';

const HEALTH_WORDS: Readonly<Record<Health, string>> = Object.freeze({
  ready: 'Ready',
  timeout: "Can't reach",
  unreachable: "Can't reach",
  blocked: 'Not allowed',
  invalid: 'Not a server address',
  unknown: 'Not checked',
});

const HEALTHS: readonly Health[] = ['ready', 'timeout', 'unreachable', 'blocked', 'invalid'];

async function printList(agent: OwnerAgent, output: Output, json: boolean): Promise<number> {
  const { client } = agent;
  const view = await client.network.servers();
  const leaving = await client.identity.leavingServers();
  // One bounded check of the own servers (outbox relayProbe); never throws; none while paused.
  const probe = view.paused ? undefined : await client.network.probe().catch(() => undefined);
  const byRelay = new Map((probe ?? []).map((p) => [p.relay, p.result]));
  const servers = view.own.map((url) => {
    const result = byRelay.get(url);
    const health: Health =
      result !== undefined && (HEALTHS as readonly string[]).includes(result.state)
        ? (result.state as Health)
        : 'unknown';
    const ms =
      health === 'ready' && typeof result?.roundTripMs === 'number' ? result.roundTripMs : null;
    return {
      host: relayOrigin(url).slice('wss://'.length),
      role: holdsDefaultServer([url]) ? ('automatic' as const) : ('own' as const),
      health,
      roundTripMs: ms,
    };
  });
  const gone = leaving.map((e) => ({
    host: relayOrigin(e.url).slice('wss://'.length),
    until: e.until,
  }));
  if (json) {
    output.print(
      JSON.stringify({
        mode: view.mode,
        servers,
        mixIn: view.mixIn,
        announceDefault: view.announceDefault,
        leaving: gone,
        paused: view.paused,
        change: view.change,
      }),
    );
    return EXIT_OK;
  }
  output.print(
    view.mode === 'automatic'
      ? `Your servers are automatic (${String(servers.length)})`
      : `Your servers (${String(servers.length)})`,
  );
  for (const s of servers) {
    const role = s.role === 'automatic' ? 'Automatic mix-in' : 'Yours';
    const state =
      s.roundTripMs === null
        ? HEALTH_WORDS[s.health]
        : `${HEALTH_WORDS[s.health]} · ${String(s.roundTripMs)} ms`;
    output.print(row(s.host, `${role} · ${state}`));
  }
  if (gone.length > 0) {
    const latest = Math.max(...gone.map((e) => e.until));
    output.print(`Old servers (${String(gone.length)}) · read only until ${date(latest)}`);
    for (const e of gone) output.print(row(e.host, `Previous, read until ${date(e.until)}`));
  }
  output.print(view.mixIn ? SERVERS_TEXT.mixInOn : SERVERS_TEXT.mixInOff);
  output.print(view.announceDefault ? SERVERS_TEXT.announceOn : SERVERS_TEXT.announceOff);
  if (view.change === 'paused') output.print(SERVERS_TEXT.paused);
  else if (view.change === 'rotation_pending') output.print(SERVERS_TEXT.finishing);
  return EXIT_OK;
}

/** `test <wss://…>…`: no presence. Exit 0 when every server can be used, 1 otherwise. */
async function testOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output } = context;
  if (flag(context, 'no-automatic') || flag(context, 'no-announce')) return badArguments(output);
  // The test needs no ID: `--id` is accepted and not used.
  const addresses = addressesOf(context.parsed.positionals.slice(2));
  if (addresses === undefined) return badArguments(output);
  if (deps.testServers === undefined) {
    output.printError(SERVERS_TEXT.failed);
    return EXIT_FAILED;
  }
  const results = await deps.testServers(addresses);
  if (results === 'invalid') return badArguments(output);
  if (results === 'busy') {
    output.printError(SERVERS_TEXT.busy);
    return EXIT_FAILED;
  }
  if (flag(context, 'json')) {
    output.print(
      JSON.stringify({
        results: results.map((r) => ({
          host: typeof r.host === 'string' ? r.host : null,
          outcome: r.outcome,
          reason: r.reason,
          roundTripMs: typeof r.roundTripMs === 'number' ? r.roundTripMs : null,
          signInRequired: typeof r.signInRequired === 'boolean' ? r.signInRequired : null,
          paymentRequired: typeof r.paymentRequired === 'boolean' ? r.paymentRequired : null,
        })),
      }),
    );
  } else {
    results.forEach((r, i) => {
      const words = testWords(r);
      output.print(row(r.host ?? `Server ${String(i + 1)}`, words.state));
      if (words.detail !== undefined) output.print(`         ${words.detail}`);
      if (r.paymentRequired === true) {
        output.print('         This server may charge for use. Check with whoever runs it.');
      }
    });
  }
  return results.every((r) => r.outcome !== 'refused') ? EXIT_OK : EXIT_FAILED;
}

/** `set` and `reset` †: the owner guard, then the node flow (review, presence, signature). */
async function changeOne(
  deps: OwnerCommandDeps,
  context: CommandContext,
  kind: 'servers' | 'reset',
): Promise<number> {
  const { output } = context;
  // The owner guard (04 §2.5 "Residual risk"; D-67): a UX guard; presence is the boundary.
  if (!checkOwnerTerminal(context.terminal).ok) {
    output.printError(SERVERS_TEXT.runYourself);
    return EXIT_FAILED;
  }
  if (flag(context, 'json')) return badArguments(output);
  let request: ServerChangeRequest;
  if (kind === 'reset') {
    if (context.parsed.positionals.length !== 2) return badArguments(output);
    if (flag(context, 'no-automatic') || flag(context, 'no-announce')) {
      return badArguments(output);
    }
    request = { kind: 'reset' };
  } else {
    const addresses = addressesOf(context.parsed.positionals.slice(2));
    if (addresses === undefined) return badArguments(output);
    const automatic = !flag(context, 'no-automatic');
    const announce = !flag(context, 'no-announce');
    if (automatic && !announce) {
      output.printError(SERVERS_TEXT.refused.mix_in_on);
      return EXIT_FAILED;
    }
    request = { kind: 'servers', servers: addresses, automatic, announce };
  }
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    const owner = await ownerContext(agent);
    if (owner === undefined) {
      output.printError(OWNER_TEXT.noIdentity);
      return EXIT_FAILED;
    }
    if (deps.changeServers === undefined) {
      output.printError(SERVERS_TEXT.failed);
      return EXIT_FAILED;
    }
    const outcome = await deps.changeServers({
      agent,
      owner: owner.owner,
      request,
      describe: reviewLines,
    });
    if (outcome.status === 'changed') {
      output.print(kind === 'reset' ? SERVERS_TEXT.reset : SERVERS_TEXT.changed);
      if (outcome.leavingUntil !== null) output.print(SERVERS_TEXT.oldUntil(outcome.leavingUntil));
      return EXIT_OK;
    }
    if (outcome.reason === 'too_many_previous' && outcome.fitsAt !== undefined) {
      output.printError(SERVERS_TEXT.tooManyFrom(outcome.fitsAt));
      return EXIT_FAILED;
    }
    output.printError(
      (SERVERS_TEXT.refused as Readonly<Record<string, string>>)[outcome.reason] ??
        SERVERS_TEXT.failed,
    );
    return EXIT_FAILED;
  } finally {
    await agent.close();
  }
}

/** `agentlink owner servers [list | test … | set … | reset]`. */
export function serversOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const sub = context.parsed.positionals[1];
  const { positionals } = context.parsed;
  if (sub === undefined || sub === 'list') {
    if (positionals.length > 2) return Promise.resolve(badArguments(context.output));
    return listOne(deps, context);
  }
  if (sub === 'test') return testOne(deps, context);
  if (sub === 'set') return changeOne(deps, context, 'servers');
  if (sub === 'reset') return changeOne(deps, context, 'reset');
  return Promise.resolve(badArguments(context.output));
}
