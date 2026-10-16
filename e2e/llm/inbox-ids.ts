// Reads a received offer's envelope ID from the recorded agentlink_inbox tool result (M1-22 LLM run).
// The harness records the result as JSON text: `{messages: [{direction, envelopeId, type, contact}]}`.
// The ID is taken from those typed fields only, never from the wrapped `block` text, where a hostile
// body could imitate a message header (06 §4). A counter-offer is an `offer` message at a higher version.

const ENVELOPE_ID = /^[A-Za-z0-9_-]{22}$/;

interface InboxMessage {
  direction?: unknown;
  type?: unknown;
  envelopeId?: unknown;
  contact?: { name?: unknown } | null;
}

/** The envelope ID of the one received offer from `sender` across the given inbox results, or undefined. */
export function receivedOfferId(results: readonly string[], sender: string): string | undefined {
  const ids: string[] = [];
  for (const text of results) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const messages = (parsed as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages as (InboxMessage | null)[]) {
      if (
        m?.direction === 'in' &&
        m.type === 'offer' &&
        m.contact?.name === sender &&
        typeof m.envelopeId === 'string' &&
        ENVELOPE_ID.test(m.envelopeId)
      ) {
        ids.push(m.envelopeId);
      }
    }
  }
  const unique = [...new Set(ids)];
  return unique.length === 1 ? unique[0] : undefined;
}
