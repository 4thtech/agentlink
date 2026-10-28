// UX2-d1: the fixed paths of the invite routes (08 §1; owner decision 1.1). Kept apart from
// routes.ts so api/invites.ts and approval-server.ts use them without importing the registry.
/** Create an invite: the `presence: 'invite'` kind, step `create` (no owner presence). */
export const INVITE_CREATE_PATH = '/api/ui/invites';
/** Check a pasted invite before connecting: the `presence: 'invite'` kind, step `check`. */
export const INVITE_CHECK_PATH = '/api/ui/invites/check';
/** Accept an invite: an owner route (`presence: true`), behind the central presence gate. */
export const INVITE_ACCEPT_PATH = '/api/ui/invites/accept';
