// ATT-APP-ATTACH (08 §1 "Attach a file"; 04 §4; D-70; I-4, I-5, I-7; proposed, owner confirms at
// merge): the attach kind's one write over the core client. Only the server's attach gate holds it
// (approval-server.ts); no MCP tool reaches it and the package entry does not export it.
//
// 1. The contact: an existing contact whose pairing is complete and that is active (`not_found`,
//    `not_ready` otherwise). Nothing is written before.
// 2. The policy in force (core's G-6 loader): under fail-closed no folder is allowed (06 §3); no
//    allowed folder is `no_folder` (the page shows Home's Send folder banner).
// 3. Each file into the Send folder (send-folder-file.ts: pinned folder, O_EXCL, no link followed,
//    `name (2).md` on a clash, the full 04 §4 check after the write).
// 4. Core's ordinary send (`sendMessage`, as `agentlink_send` with `path`): the policy, the realpath
//    check against the allowed folders again, inline (≤ 12 KB ciphertext) or the drop, the type from
//    the name (`mimeForName`: text/markdown for .md). The bytes sent are the ones the owner picked,
//    held in memory: the Send folder copy is the record, never re-read.
// 5. Not sent: every file this call wrote is removed again.
//
// No owner presence and nothing signed: the owner's own page, behind the session, CSRF and Origin
// gate, does what the owner's AI may already do under the same policy (D-70). Nothing here logs.
import { CoreError, type AgentLinkClient, type OutgoingFile } from '@4thtech-io/core';
import { mimeForName } from '@4thtech-io/types';
import { writeSendFolderFile, type SendFolderWrite } from '../send-folder-file.js';
import type {
  LocalUiAttachDesk,
  LocalUiAttachOutcome,
  LocalUiAttachRefusal,
} from './route-types.js';

const refused = (reason: LocalUiAttachRefusal): LocalUiAttachOutcome =>
  Object.freeze({ status: 'refused', reason });

type Written = Extract<SendFolderWrite, { ok: true }>;

async function removeAll(written: readonly Written[]): Promise<void> {
  for (const w of written) await w.remove();
}

/** The attach desk over `client` (a fresh frozen object of one bound method). */
export function attachDesk(
  client: AgentLinkClient,
  options: { readonly home?: string } = {},
): LocalUiAttachDesk {
  return Object.freeze<LocalUiAttachDesk>({
    async send(request) {
      // 1. The contact.
      let contact;
      try {
        contact = (await client.contacts.list()).find((c) => c.id === request.to);
      } catch {
        return refused('failed');
      }
      if (contact === undefined || contact.status === 'removed') return refused('not_found');
      if (contact.status !== 'active' || contact.pairing !== 'complete')
        return refused('not_ready');

      // 2. The allowed folders of the policy in force.
      let folders: readonly string[];
      try {
        const effective = await client.ownerActions.loadPolicy();
        folders = effective.mode === 'fail_closed' ? [] : effective.policy.files.allowedFolders;
      } catch {
        return refused('failed');
      }
      if (!Array.isArray(folders) || folders.length === 0) return refused('no_folder');

      // 3. Each file into the Send folder.
      const written: Written[] = [];
      for (const file of request.files) {
        const w = await writeSendFolderFile({
          allowedFolders: folders,
          name: file.name,
          bytes: file.bytes,
          ...(options.home === undefined ? {} : { home: options.home }),
        });
        if (!w.ok) {
          await removeAll(written);
          return refused(w.reason);
        }
        written.push(w);
      }
      const files: OutgoingFile[] = written.map((w, i) => {
        const bytes = (request.files[i] as { bytes: Uint8Array }).bytes;
        return {
          realpath: w.realpath,
          name: w.name,
          // Named, never left to a default: text/markdown, text/plain or application/json.
          mime: mimeForName(w.name),
          size: bytes.length,
          open: () => Promise.resolve(bytes.slice()),
        };
      });

      // 4. Core's ordinary send.
      let result;
      try {
        // IR-ATTACH-1 F-4: the page's request ID makes a retry a replay, never a second message
        // (the retry writes the same name again once this call's copy was removed).
        result = await client.sendMessage({
          to: request.to,
          text: request.text,
          type: 'text',
          files,
          ...(request.requestId === undefined
            ? {}
            : { clientRequestId: `attach:${request.requestId}` }),
        });
      } catch (error) {
        await removeAll(written);
        if (error instanceof CoreError && error.code === 'agent_paused') return refused('paused');
        return refused('failed');
      }
      if (result.status === 'ok') {
        return Object.freeze({ status: result.delivery ?? 'sent' });
      }
      // 5. Not sent: nothing of this call stays behind.
      await removeAll(written);
      switch (result.status) {
        case 'needs_setup':
          return refused(
            result.reason === 'no_folder' || result.reason === 'outside_folder'
              ? 'no_folder'
              : result.reason === 'size' || result.reason === 'quota'
                ? 'too_large'
                : 'storage',
          );
        case 'in_progress':
          return refused('busy');
        case 'rejected':
          if (result.code === 'POLICY_DENIED') return refused('policy');
          if (result.code === 'FILE_TOO_LARGE' || result.code === 'PAYLOAD_TOO_LARGE') {
            return refused('too_large');
          }
          return refused('failed');
        default:
          return refused('failed');
      }
    },
  });
}
