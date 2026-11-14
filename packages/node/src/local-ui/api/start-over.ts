// OWNER-START-OVER (D-152; 04 §2.5.4 "Start over on this computer"; 08 §1): the start-over routes
// of the app. Each is the start-over kind (route-types.ts LocalUiStartOverRoute) at its fixed path,
// with no handler: the approval server's start-over gate runs the engine (start-over.ts). This file
// only declares them; no page file and no MCP tool module imports the engine (I-4).
//
// The frozen API, all under the session, CSRF, Host and fetch-metadata gate; POSTs also need Origin
// and `Content-Type: application/octet-stream`; no query anywhere; `X-AgentLink-Input` is base64url
// JSON; errors are `{error}` with fixed codes:
//
//   GET  state                    → {presence: "native"|"passkey", unfinished}
//   POST begin  input {phrase}    → {status: "presence", presence, nonce, expiresInMs[, publicKey:
//               {rpId, rpName, userId, userName, challenge}]} | 400 phrase | 429 wait | 409 open_app
//   POST finish input {nonce}, `X-AgentLink-Presence: native` (empty body) or `passkey` (body: the
//               first-run registration encoding of a user-verified creation)
//               → {status: "done", backup} | {status: "partial", backup, failed: "move"|"keychain"}
//               | 400 expired | 400 presence_required | 403 presence_rejected | 409 busy
import {
  START_OVER_PATHS,
  type LocalUiStartOverRoute,
  type LocalUiStartOverStep,
} from '../route-types.js';

export { START_OVER_PATHS };

const route = (step: LocalUiStartOverStep): LocalUiStartOverRoute =>
  Object.freeze<LocalUiStartOverRoute>({
    method: step === 'state' ? 'GET' : 'POST',
    path: START_OVER_PATHS[step],
    presence: 'start-over',
    step,
  });

/** Every start-over route (state, begin, finish). */
export const startOverRoutes: readonly LocalUiStartOverRoute[] = Object.freeze(
  (Object.keys(START_OVER_PATHS) as LocalUiStartOverStep[]).map(route),
);
