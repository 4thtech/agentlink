// UX2-d1: the fixed paths of the invite routes (08 §1; owner decision 1.1). Kept apart from
// routes.ts so api/invites.ts and approval-server.ts use them without importing the registry.
/** Create an invite: the `presence: 'invite'` kind, step `create` (no owner presence). */
export const INVITE_CREATE_PATH = '/api/ui/invites';
/** Check a pasted invite before connecting: the `presence: 'invite'` kind, step `check`. */
export const INVITE_CHECK_PATH = '/api/ui/invites/check';
/** W4-INVITES-LIST: the open invites (a GET read at the create path; never a link). */
export const INVITES_LIST_PATH = '/api/ui/invites';
/** W4-INVITES-LIST: cancel an open invite: the `presence: 'invite'` kind, step `cancel`. */
export const INVITE_CANCEL_PATH = '/api/ui/invites/cancel';
/**
 * REL051-B1 (N2): cancel this agent's accepts that wait for one contact's answer: the
 * `presence: 'invite'` kind, step `cancel-connecting`, body exactly `{"ref"}`.
 */
export const INVITE_CONNECTING_CANCEL_PATH = '/api/ui/invites/connecting/cancel';
/**
 * REL051-B2: the kept link of one open invite (Copy link, Show link): the `presence: 'invite'` kind,
 * step `link`, body exactly `{inviteId}`. A POST behind the invite gate, never a GET read.
 */
export const INVITE_LINK_PATH = '/api/ui/invites/link';
/** Accept an invite: an owner route (`presence: true`), behind the central presence gate. */
export const INVITE_ACCEPT_PATH = '/api/ui/invites/accept';

// U3-invite (08 §4 "One step from an invite link"): the waiting invite of the app host.
/** The join screen's read: state, name-rule name, label, fingerprint, expiry and the public ID. */
export const JOIN_PATH = '/api/ui/join';
/** Accept the waiting invite: an owner route (`presence: true`), input `{inviteId}`. */
export const JOIN_ACCEPT_PATH = '/api/ui/join/accept';
/** "Not now": the `presence: 'invite'` kind, step `dismiss`; signs nothing. */
export const JOIN_DISMISS_PATH = '/api/ui/join/dismiss';
/** `agentlink join` hands an invite to a running app host: the `presence: 'handoff'` kind. */
export const JOIN_HANDOFF_PATH = '/api/ui/join/handoff';
/**
 * APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): the same handoff kind, empty body. The
 * desktop app asks a running `agentlink ui` host to close (it takes over), and terminal
 * `agentlink ui` asks a running desktop app to show its window (no second host).
 */
export const HOST_YIELD_PATH = '/api/ui/host/yield';
export const HOST_SHOW_PATH = '/api/ui/host/show';
/** Every path of the handoff kind (each registered once). */
export const HANDOFF_KIND_PATHS: readonly string[] = Object.freeze([
  JOIN_HANDOFF_PATH,
  HOST_YIELD_PATH,
  HOST_SHOW_PATH,
]);
/** The app page of the join screen (served as an app page; never carries the invite). */
export const JOIN_PAGE_PATH = '/settings/join';
