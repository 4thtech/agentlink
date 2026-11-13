// The notice system's timing in one place (docs/design/notices.md; PLAN-NOTIFY §3.1).
// TOAST_MS and TOAST_ACTION_MS live with the toast stack (notice.tsx).

/** How long a copy button says "Copied" before it goes back. */
export const COPIED_MS = 1_600;
/** The network must be down this long before an offline banner shows; "Back online" shows once. */
export const HEALTH_GRACE_MS = 5_000;
