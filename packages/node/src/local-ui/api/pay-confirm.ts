// M1-PAY-CONFIRM-a: the paid-action confirmation routes (04 §2.5.3; 08 §1; D-132; I-4).
//
// - `POST /api/ui/pay-confirm/begin` (input `{ flow: "proof", approvalId }` or
//   `{ flow: "limits", review, acknowledged }`, empty body): the server builds the exact owner flow
//   from stored data, holds it and answers the statement, the challenge and the WebAuthn request
//   options (user verification required). No amount, name or limit is ever taken from the input.
// - `POST /api/ui/pay-confirm/finish` (input `{ ceremony }`; body: the WebAuthn `get` response with
//   `X-AgentLink-Presence: passkey`, or the backup code): signs exactly the held objects.
//
// Neither has a page handler: the approval server's payConfirmGate runs both (approval-server.ts,
// pay-confirm.ts). The page session cookie, CSRF, Origin and fetch-metadata checks of every owner
// route apply first; no MCP tool or CLI flag reaches them (rule 4).
import type { LocalUiPayConfirmRoute, LocalUiRoute } from '../route-types.js';

export const payConfirmRoutes: readonly LocalUiRoute[] = Object.freeze([
  Object.freeze<LocalUiPayConfirmRoute>({
    method: 'POST',
    path: '/api/ui/pay-confirm/begin',
    presence: 'pay-confirm',
    step: 'begin',
  }),
  Object.freeze<LocalUiPayConfirmRoute>({
    method: 'POST',
    path: '/api/ui/pay-confirm/finish',
    presence: 'pay-confirm',
    step: 'finish',
  }),
]);
