// ATT-APP-ATTACH (08 §1 "Attach a file"; I-4, I-5): the page side of attaching files in a
// conversation. The only place that knows the route.
//
// `send` posts once to `POST /api/ui/attach` with the CSRF header and an octet-stream body holding
// `{to, text, files: [{name, data}]}` (standard base64). No operation input, no presence header: the
// browser signs nothing. The server checks everything again (type, size, UTF-8, the Send folder).
// Answers become fixed outcomes; nothing from the answer is shown as text.

export const ATTACH_PATH = '/api/ui/attach';
/** The types the picker offers (the server's allowlist). */
export const ATTACH_ACCEPT = '.md,.markdown,.txt,.json';
export const ATTACH_EXTENSIONS: readonly string[] = Object.freeze([
  'md',
  'markdown',
  'txt',
  'json',
]);
export const ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ATTACH_MAX_FILES = 5;
export const ATTACH_MAX_TEXT_CHARS = 4000;
const CSRF_HEADER = 'X-AgentLink-CSRF';

export type AttachError =
  | 'type'
  | 'too_large'
  | 'not_text'
  | 'no_folder'
  | 'not_ready'
  | 'policy'
  | 'storage'
  | 'busy'
  | 'paused'
  | 'wait'
  | 'failed';

export type AttachResult =
  | { readonly ok: true; readonly status: 'sent' | 'queued' | 'not_delivered' }
  | { readonly ok: false; readonly error: AttachError };

export interface AttachApi {
  send(contactId: string, text: string, files: readonly File[]): Promise<AttachResult>;
}

/** Why the page refuses a file before sending (the server checks again). */
export function attachFileProblem(file: {
  readonly name: string;
  readonly size: number;
}): 'type' | 'too_large' | undefined {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (!ATTACH_EXTENSIONS.includes(ext)) return 'type';
  if (file.size > ATTACH_MAX_FILE_BYTES) return 'too_large';
  return undefined;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

async function bytesOf(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('read'));
    reader.readAsArrayBuffer(file);
  });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const ERRORS: ReadonlySet<string> = new Set<AttachError>([
  'type',
  'too_large',
  'not_text',
  'no_folder',
  'not_ready',
  'policy',
  'storage',
  'busy',
  'paused',
  'wait',
]);
const STATUSES: ReadonlySet<string> = new Set(['sent', 'queued', 'not_delivered']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function createAttachApi(
  options: { readonly fetch?: typeof fetch; readonly token?: string } = {},
): AttachApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  return {
    async send(contactId, text, files) {
      let body: Uint8Array<ArrayBuffer>;
      try {
        const encoded = [];
        for (const file of files) {
          encoded.push({ name: file.name, data: base64(await bytesOf(file)) });
        }
        body = new TextEncoder().encode(JSON.stringify({ to: contactId, text, files: encoded }));
      } catch {
        return { ok: false, error: 'failed' };
      }
      let res: Response;
      try {
        res = await doFetch(ATTACH_PATH, {
          method: 'POST',
          headers: new Headers({
            [CSRF_HEADER]: token(),
            'content-type': 'application/octet-stream',
          }),
          body,
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        return { ok: false, error: 'failed' };
      }
      let answer: unknown;
      try {
        answer = await res.json();
      } catch {
        answer = undefined;
      }
      if (res.status === 200) {
        const status = isObject(answer) ? answer['status'] : undefined;
        return typeof status === 'string' && STATUSES.has(status)
          ? { ok: true, status: status as 'sent' | 'queued' | 'not_delivered' }
          : { ok: true, status: 'sent' };
      }
      if (res.status === 413) return { ok: false, error: 'too_large' };
      const error = isObject(answer) ? answer['error'] : undefined;
      return typeof error === 'string' && ERRORS.has(error)
        ? { ok: false, error: error as AttachError }
        : { ok: false, error: 'failed' };
    },
  };
}
