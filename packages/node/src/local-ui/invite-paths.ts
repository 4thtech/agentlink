// UX2-d1: the fixed paths of the invite routes (08 §1; owner decision 1.1). Kept apart from
// routes.ts so api/invites.ts and approval-server.ts use them without importing the registry.
/** Create an invite: the `presence: 'invite'` kind, step `create` (no owner presence). */
export const INVITE_CREATE_PATH = '/api/ui/invites';
/** Check a pasted invite before connecting: the `presence: 'invite'` kind, step `check`. */
export const INVITE_CHECK_PATH = '/api/ui/invites/check';
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
/** The app page of the join screen (served as an app page; never carries the invite). */
export const JOIN_PAGE_PATH = '/settings/join';
