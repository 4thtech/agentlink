// `agentlink credits [--topup]` (M1-9h; 06 §2.1 `credits`, `agentAddress`, `topUpUrl`, §8; 07 §6.3;
// 11 §5; D-40, D-46). Read-only: it writes nothing, sends nothing and signs nothing.
//
// - Default: the agent ID (11 §5.1: "Agent ID", never "address"), the credits in dollars summed over
//   the proof networks that answered (never a token or network name), the price of adding proof,
//   and the test-credits note while every shipped network is a test network. The same reads as
//   `agentlink_status` (src/runtime/proofs.ts `account`, a short budget); nothing is asked of the
//   user, and no network is ever chosen by them (D-40).
// - `--topup`: the 07 §6.3 selection for adding proof (`selectPayingChain` over the automatically
//   selectable chains, cheapest first, M1-26). Enough credits: says so. Not enough: the amount to
//   add in dollars. Then the top-up link (06 §2.1 `topUpUrl`, D-113: `https://{payHost}/#v=1&a=
//   <agent address>&usd=<suggested amount>`, host from the shipped config), the agent ID as a
//   terminal QR code, and the browser opened on the link when stdout is a terminal. No other URL
//   is ever printed, and no key. The link is shown to the user only; it is never logged.
// - M1-36f: plain words only (11 §5): no "network" or "public record" in the output; a read that
//   did not answer says what to do next (try again in a few minutes).
import * as chain from '@4thtech-io/chain';
import { nodeRpcFetch } from '@4thtech-io/node';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandHandler,
} from '../dispatch.js';
import type { AccountView } from '../tools/context.js';
import { buildTopUpLink, suggestTopUpUsd } from '@4thtech-io/core';
import { harnessMarkerSet, isInteractive } from '../runtime/guards.js';
import { commandPrefix } from '../runtime/cli-prefix.js';
import { renderQr } from '../terminal/qr.js';
import { openInBrowser } from '../runtime/open-browser.js';
import { dollars } from '../tools/proofs-common.js';
import { topUpDisclosure } from '../tools/strings/privacy.js';
import { createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';

/** How long `--topup` waits for the proof networks (07 §6.3 default per-chain budget). */
export const TOPUP_BUDGET_MS = 4_000;

/** The 07 §6.3 selection for adding proof, for one agent; undefined when it could not run. */
export type TopUpCheck = (agentId: string) => Promise<chain.ChainSelection | undefined>;

export interface CreditsDeps extends CommandDeps {
  readonly topUpCheck: TopUpCheck;
  /** True while every shipped proof network is a test network (the testnet beta). */
  readonly testnetOnly: () => boolean;
  /** The shipped pay page config (the chain package's `PAY_PAGE`); links only when `live`. */
  readonly payPage: chain.PayPageConfig;
  /** Opens the link in the user's browser; true when it was handed over. Never throws. */
  readonly openBrowser: (url: string) => Promise<boolean>;
}

export const CREDITS_TEXT = Object.freeze({
  agentId: 'Agent ID: {agentId}',
  credits: 'Credits: {usd}',
  creditsUnknown: "Credits: can't be checked right now. Try again in a few minutes.",
  price: 'Adding proof costs {fee}. Messages and files are free.',
  testCredits: "These are free test credits for the beta. They aren't real money.",
  enough: 'You have enough credits to add proof ({fee} each).',
  needs: 'Add at least {usd} in credits to add proof ({fee} each).',
  unavailable: "Can't check right now how much to add. Try again in a few minutes.",
  topUpHow: 'To add credits, open this link:',
  topUpNoLink: "Can't make the link to add credits right now.",
  topUpNotLive: 'Adding credits is not available yet in this version of AgentLink.',
  openedBrowser: 'Opened it in your browser.',
  qrIntro: 'Or scan this to copy your agent ID to your phone:',
  get topUpHelp(): string {
    return `To see how much to add, run \`${commandPrefix()} credits --topup\`.`;
  },
  noProofs:
    "Proofs aren't available in this version of AgentLink, so there are no credits to show.",
});

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const USD = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/;
const SCALE = 6;

/** Sums checked USD amounts exactly (6 decimals, rounded down); undefined if any is malformed. */
export function sumUsd(amounts: readonly string[]): string | undefined {
  let total = 0n;
  for (const amount of amounts) {
    if (!USD.test(amount)) return undefined;
    const [whole = '0', frac = ''] = amount.split('.');
    total +=
      BigInt(whole) * 10n ** BigInt(SCALE) + BigInt((frac + '0'.repeat(SCALE)).slice(0, SCALE));
  }
  const text = total.toString().padStart(SCALE + 1, '0');
  return `${text.slice(0, -SCALE)}.${text.slice(-SCALE)}`;
}

/** The default `--topup` check: 07 §6.3 over the automatically selectable chains. */
export function nodeTopUpCheck(
  options: {
    readonly fetchFn?: chain.RpcFetchFn;
    readonly configs?: readonly chain.ChainConfig[];
  } = {},
): TopUpCheck {
  return async (agentId) => {
    if (!AGENT_ID.test(agentId)) return undefined;
    const configs = options.configs ?? chain.autoSelectableChains();
    if (configs.length === 0) return undefined;
    const fetchFn = options.fetchFn ?? nodeRpcFetch();
    const readers = configs.map((config) => ({
      config,
      client: chain.createReadClient(config, { fetchFn }),
    }));
    return chain.selectPayingChain(readers, agentId as chain.Hex, {
      feeType: 'NOTARIZE',
      budgetMs: TOPUP_BUDGET_MS,
    });
  };
}

export function createCreditsHandler(deps: CreditsDeps): CommandHandler {
  return (context) => {
    if (context.parsed.positionals.length > 0) {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(EXIT_USAGE);
    }
    const topup = context.parsed.values['topup'] === true;
    return withAgent(context, deps, async ({ agentId, proofs }) => {
      if (!AGENT_ID.test(agentId)) {
        context.output.printError(DISPATCH_TEXT.failed);
        return EXIT_FAILED;
      }
      if (proofs === undefined) {
        context.output.print(CREDITS_TEXT.noProofs);
        return EXIT_FAILED;
      }
      const lines: string[] = [fill(CREDITS_TEXT.agentId, { agentId })];
      let account: AccountView | undefined;
      try {
        account = await proofs.account(agentId);
      } catch {
        // The error could carry an RPC URL (I-7): never printed.
        account = undefined;
      }
      let fee: string | undefined;
      if (account === undefined) {
        lines.push(CREDITS_TEXT.creditsUnknown);
      } else {
        const total = sumUsd(account.credits.map((c) => c.usd));
        lines.push(
          total === undefined
            ? CREDITS_TEXT.creditsUnknown
            : fill(CREDITS_TEXT.credits, { usd: dollars(total) ?? '$0.00' }),
        );
        fee = dollars(account.prices.find((p) => p.action === 'notarize')?.usd);
        if (fee !== undefined) lines.push(fill(CREDITS_TEXT.price, { fee }));
      }
      if (deps.testnetOnly()) lines.push(CREDITS_TEXT.testCredits);

      let exit = account === undefined ? EXIT_FAILED : EXIT_OK;
      if (topup) {
        lines.push('');
        const selection = await deps.topUpCheck(agentId).catch(() => undefined);
        let suggested: string | undefined;
        let needsMore = false;
        if (selection === undefined || selection.status === 'unavailable') {
          lines.push(CREDITS_TEXT.unavailable);
          exit = EXIT_FAILED;
        } else if (selection.status === 'ok') {
          const each = dollars(selection.quote.usd) ?? fee;
          lines.push(
            each === undefined
              ? CREDITS_TEXT.enough.replace(' ({fee} each)', '')
              : fill(CREDITS_TEXT.enough, { fee: each }),
          );
        } else {
          const add = dollars(selection.topUp.usd);
          const each = dollars(selection.topUp.feeUsd) ?? fee;
          if (add !== undefined) suggested = suggestTopUpUsd(selection.topUp.usd);
          needsMore = add !== undefined;
          lines.push(
            add === undefined
              ? CREDITS_TEXT.unavailable
              : each === undefined
                ? fill(CREDITS_TEXT.needs.replace(' ({fee} each)', ''), { usd: add })
                : fill(CREDITS_TEXT.needs, { usd: add, fee: each }),
          );
        }
        if (!deps.payPage.live) {
          // The pay page does not exist yet: no link, no QR code, no browser.
          lines.push(CREDITS_TEXT.topUpNotLive);
        } else {
          const link = buildTopUpLink({
            agentAddress: agentId,
            payHost: deps.payPage.host,
            ...(suggested === undefined ? {} : { usd: suggested }),
          });
          if (link === undefined) {
            lines.push(CREDITS_TEXT.topUpNoLink);
          } else {
            lines.push(CREDITS_TEXT.topUpHow, link);
            // Only when credits are needed, and only for a person at a terminal: an AI app that
            // runs this command with a pty must not open the user's browser.
            const person =
              isInteractive(context.terminal) && !harnessMarkerSet(context.terminal.env);
            if (needsMore && person) {
              const opened = await deps.openBrowser(link).catch(() => false);
              if (opened) lines.push(CREDITS_TEXT.openedBrowser);
            }
          }
          lines.push('', CREDITS_TEXT.qrIntro, ...renderQr(agentId));
          // 11 §5.6: each top-up method says the paying account is publicly linked (D-109).
          lines.push(topUpDisclosure());
        }
      } else {
        lines.push(CREDITS_TEXT.topUpHelp);
      }
      printAll(context, lines);
      return exit;
    });
  };
}

export function nodeCreditsDeps(over: Partial<CreditsDeps> = {}): CreditsDeps {
  return Object.freeze({
    ...createDeps(),
    topUpCheck: nodeTopUpCheck(),
    testnetOnly: () => chain.chainRegistry().every((c) => c.testnet),
    openBrowser: openInBrowser,
    payPage: chain.PAY_PAGE,
    ...over,
  });
}

export const creditsHandler: CommandHandler = (context) =>
  createCreditsHandler(nodeCreditsDeps())(context);
