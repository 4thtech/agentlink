// The approval action of `agentlink_accept_invite` (04 §3.4.1; M1-9o, IR-M1-9l-1 F02). UX2-d1 moved
// the builder and the summary to core (`invite-accept-action.ts`), so the tool, the CLI
// `accept --approval` and the local app's accept route build one action and one approval serves
// every surface. This module keeps its exports for the tool and the CLI.
export {
  acceptInviteAction,
  acceptInviteApprovalSummary,
  type AcceptInviteAction,
} from '@4thtech-io/core';
