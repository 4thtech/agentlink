// UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app"; 08 §1): the restore routes of the app. Each is
// the restore kind (route-types.ts LocalUiRestoreRoute) at its fixed path, with no handler: the
// approval server's restore gate runs the restore engine (recovery-kit-restore.ts). This file only
// declares them; no page file and no MCP tool module imports the engine (I-4; the import fence).
//
// The frozen API for the restore wizard (WP-R3), all under the session, CSRF, Host and fetch-metadata
// gate; POSTs also need Origin and `Content-Type: application/octet-stream`; no query anywhere;
// `X-AgentLink-Input` is base64url JSON; errors are `{error}` with the fixed codes of 04 §2.3.3:
//
//   GET  found                      → {kits: [{handle, name, folder, modifiedAt, size}]}
//   POST upload   body: kit bytes   → {handle, size}
//   POST header   input {handle}    → {header: ok|not_a_kit|newer_version|other_owner, ownerPresent}
//   POST presence input {handle}, body: master code, or the passkey assertion with
//                 `X-AgentLink-Presence: passkey` (owner present only) → {status: "ok"}
//   POST open     input {handle}, body: recovery code → {kit, summary}
//   POST check    input {handle}, body: recovery code → {summary}
//   POST cancel   input {kit}       → {status: "cancelled"}
//   POST apply/begin  input {kit, selection, names} → owner present: {status: "done", ids,
//                 touchId: "unchanged"}; no owner: {status: "gesture", nonce, expiresInMs,
//                 publicKey: {rpId, rpName, userId, userName, challenge, prfSalt}}
//   POST apply/finish input {nonce}, body: the first-run registration encoding (create, or create
//                 plus the get() assertion) → {status: "done", ids, masterCode, touchId} or
//                 {status: "prf_needed", nonce, expiresInMs, publicKey: {rpId, challenge,
//                 credentialId, prfSalt}}
//   POST /api/ui/master-code/show  (REL051-CF3) → {status: "shown", kind, code, …the step's public
//                 fields} for the page session that got it (10 minutes), else {status: "lost", kind,
//                 touchId} | {status: "finish_restore"} | {status: "none"}; never another session's code
//   POST /api/ui/master-code/saved (REL051-CF3) → {status: "saved"}: "I saved it"
import {
  RESTORE_PATHS,
  type LocalUiRestoreRoute,
  type LocalUiRestoreStep,
} from '../route-types.js';

export { RESTORE_PATHS };

const route = (step: LocalUiRestoreStep): LocalUiRestoreRoute =>
  Object.freeze<LocalUiRestoreRoute>({
    method: step === 'found' ? 'GET' : 'POST',
    path: RESTORE_PATHS[step],
    presence: 'restore',
    step,
  });

/** Every restore route (found, upload, header, presence, open, check, cancel, apply/begin, apply/finish, and REL051-CF3's master-code show and saved). */
export const restoreRoutes: readonly LocalUiRestoreRoute[] = Object.freeze(
  (Object.keys(RESTORE_PATHS) as LocalUiRestoreStep[]).map(route),
);
