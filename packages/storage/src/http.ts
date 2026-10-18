// Response helpers shared by the S3 session and the drop adapter (M1-7f). Kept apart from
// session.ts so that the drop adapter, and with it the core's file sending, does not import the
// S3 signer (aws4fetch): a bundle that never uses own S3 storage then never loads it.
import { StorageError } from './errors.js';

export type FetchLike = (request: Request) => Promise<Response>;

/**
 * Reads a response body as text, refusing more than `max` bytes (a hostile or broken endpoint cannot
 * make the client buffer without bound). Returns null when the body is over the cap.
 */
export async function readCappedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    throw new StorageError('network', 'storage request failed');
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(out);
}

/** Discards a response body we do not need. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
