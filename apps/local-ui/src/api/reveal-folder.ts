// FILES-REVEAL (08 §1 "Show in Finder for the folders"; S2 on the server side; I-4): the page's one
// helper for Show in Finder (Show in Explorer on Windows) of the Send folder and the Inbox. Each is
// a POST with an empty octet-stream body: no path, no input, no presence. The server reads the
// folder from the verified rules and answers a fixed word; nothing here ever shows a path.
const CSRF_HEADER = 'X-AgentLink-CSRF';

export const SEND_FOLDER_REVEAL = '/api/ui/files/send-folder/reveal';
export const INBOX_REVEAL_PATH = '/api/ui/storage/inbox/reveal';

/** `shown`, `not_found` (missing, a link or not allowed), or `failed` (anything else). */
export type RevealResult = 'shown' | 'not_found' | 'failed';

export interface RevealApi {
  revealSendFolder(): Promise<RevealResult>;
  revealInbox(): Promise<RevealResult>;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

export function createRevealApi(
  options: { readonly fetch?: typeof fetch; readonly token?: string } = {},
): RevealApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const reveal = async (path: string): Promise<RevealResult> => {
    try {
      const res = await doFetch(path, {
        method: 'POST',
        headers: new Headers({
          [CSRF_HEADER]: options.token ?? pageToken(),
          'content-type': 'application/octet-stream',
        }),
        body: new Uint8Array(0),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (res.status === 200) return 'shown';
      return res.status === 404 ? 'not_found' : 'failed';
    } catch {
      return 'failed';
    }
  };
  return {
    revealSendFolder: () => reveal(SEND_FOLDER_REVEAL),
    revealInbox: () => reveal(INBOX_REVEAL_PATH),
  };
}
