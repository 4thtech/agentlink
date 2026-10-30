// W4-WIZARD (W4 UX v2 layer 1; artboards A1 to A3; 11 §5): the words of Get started. Plain words only
// (11 §5.1): no wallet, gas, seed phrase, transaction, chain, address or hash. Names that come from
// the server (an app name, the agent's name) are passed in and rendered as text.

/** The four steps, in order (`/start/<step>`). */
export const STEP_IDS = ['app', 'connect', 'connected', 'invite'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const WIZARD = {
  /** The progress line: "Step 1 of 4 · Pick your AI app". */
  stepLabel: (n: number, name: string): string => `Step ${String(n)} of 4 · ${name}`,
  stepNames: {
    app: 'Pick your AI app',
    connect: 'Connect',
    connected: 'Connected',
    invite: 'Invite someone',
  } satisfies Record<StepId, string>,
  skip: 'Skip to Home',
  progressLabel: 'Get started progress',
} as const;

/**
 * W4-WIRE-2 (owner Decision 52 (2)): Add agent's first screen, before the pick. The name rules are
 * the agent-name rules of first run (1 to 32 characters; the server checks the name before any
 * Touch ID).
 */
export const NAME_STEP = {
  stepName: 'Name your agent',
  eyebrow: 'New agent',
  title: 'Name your agent',
  body: 'You and the people you connect with see this name. You can rename it later in Agents.',
  field: 'Agent name',
  next: 'Continue',
  checking: 'Checking the name…',
  then: 'Next, pick the AI app it works in.',
  /** IR-W4-WIRE-2X-1: the old Add sheet's hint, kept (a hint only; the name may still be used). */
  taken: 'You already have an agent with this name.',
} as const;

/** A1, step 1: pick your AI app. */
export const PICK_STEP = {
  eyebrow: 'Welcome',
  /** Add agent and Connect another AI app reuse the step with their own eyebrow. */
  eyebrowAdd: 'New agent',
  eyebrowConnect: 'Connect another AI app',
  title: 'Which AI app do you use?',
  body: 'Pick one. We set it up for you, nothing to copy or paste.',
  found: 'Found on this Mac',
  foundElsewhere: 'Found on this computer',
  notFound: 'Not found yet',
  connected: 'Connected',
  next: (app: string): string => `Continue with ${app}`,
  later: 'You can connect more AI apps later.',
  loading: 'Looking for AI apps…',
  lookFailed: "Couldn't look for AI apps. You can still pick one.",
} as const;

/** A1, step 2: connect with Touch ID. */
export const CONNECT_STEP = {
  back: 'Back',
  eyebrow: (app: string): string => `Connect ${app}`,
  title: "Confirm it's you",
  body: (app: string): string =>
    `We create your agent and add AgentLink to ${app}. Touch ID proves it's you. Your AI can't approve things for you.`,
  bodyConnect: (app: string, agent: string): string =>
    `We add AgentLink to ${app} for ${agent}. Touch ID proves it's you. Your AI can't approve things for you.`,
  worksIn: (app: string): string => `Will work in ${app}`,
  rename: 'Change name',
  renameLabel: (name: string): string => `Change the agent's name (${name})`,
  connect: (sensor: string): string => `Connect with ${sensor}`,
  restartNote: (app: string): string =>
    `Nothing to copy or paste. If ${app} is open, we ask you to restart it.`,
  noApp: 'Pick your AI app first.',
} as const;

/** A2, step 3: connected. */
export const CONNECTED_STEP = {
  title: (app: string): string => `Connected to ${app}`,
  body: 'Your AI can now talk to people you invite.',
  /** E1 (D-140): the agent is kept; the app's entry could not be written. */
  notConnectedTitle: (agent: string): string => `${agent} is ready`,
  notConnectedBody: (app: string): string =>
    `${app} isn't connected yet. Nothing else changed. Connect it now, or later from Agents.`,
  connect: (app: string): string => `Connect ${app}`,
  restart: (app: string): string =>
    `If ${app} is open, quit it and open it again so it picks up AgentLink.`,
  invite: 'Invite someone',
  home: 'Go to Home',
  /** W4-WIRE-2: Add agent's Connected: open the new agent (only when asked). */
  open: (agent: string): string => `Open ${agent}`,
  then: 'Then',
  example: (app: string): string => `just ask ${app}, like "send Denis the brief".`,
} as const;

/** A3, step 4: invite someone (optional). */
export const INVITE_STEP = {
  title: 'Invite someone',
  body: 'Send them a link. When they accept, your AIs can talk. You can also do this later from Home.',
  create: 'Create an invite link',
  skip: 'Skip for now',
  done: 'Done, go to Home',
} as const;

/** The Home card (A4): "Get started · 2 of 3 done". */
export const CARD = {
  title: (done: number, total: number): string =>
    `Get started · ${String(done)} of ${String(total)} done`,
  hide: 'Hide Get started',
  connect: 'Connect your AI app',
  invite: 'Invite someone',
  check: (name: string | null): string =>
    name === null ? 'Check a safety code' : `Check ${name}'s safety code`,
} as const;
