// R2: a failed answer carries a fixed `reason` code (the server's failure-reasons.ts: a closed set,
// never an error text). One table turns each code into specific plain words (11 §5, copy proposed,
// owner confirms at merge); an unknown or missing code keeps a generic line plus the doctor hint.
export const FAILURE_REASON_CODES = [
  'storage_unreachable',
  'relay_unreachable',
  'ai_app_running',
  'ai_app_config_unwritable',
  'keychain_unavailable',
  'busy',
  'concurrent_change',
  'internal',
] as const;

export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

export const FAILURE_COPY: Readonly<Record<FailureReasonCode, string>> = {
  storage_unreachable:
    "AgentLink couldn't reach the file storage. Nothing was changed. Check your connection, then try again.",
  relay_unreachable:
    "AgentLink couldn't reach the network. Nothing was changed. Check your connection, then try again.",
  ai_app_running: 'Your AI app is open. Quit it, then try again. Nothing was changed.',
  ai_app_config_unwritable:
    "AgentLink couldn't change your AI app's settings file. Nothing was changed. Run `agentlink doctor` in your own terminal for details.",
  keychain_unavailable:
    "Your computer's keychain isn't available. Unlock it, then try again. Nothing was changed.",
  busy: 'AgentLink is busy with another step. Wait a moment, then try again.',
  concurrent_change: 'Something else changed this ID at the same moment. Try again.',
  internal:
    'Something went wrong inside AgentLink. Nothing was changed. Run `agentlink doctor` in your own terminal for details.',
};

/** The line for an answer we cannot place: generic, with the one next step. */
export const FAILURE_GENERIC =
  "That didn't finish. Run `agentlink doctor` in your own terminal for details.";

const CODES: ReadonlySet<string> = new Set(FAILURE_REASON_CODES);

/** A reason read from an answer, only when it is one of the fixed codes. */
export function knownFailureReason(value: unknown): FailureReasonCode | undefined {
  return typeof value === 'string' && CODES.has(value) ? (value as FailureReasonCode) : undefined;
}

/** Plain words for a reason; the generic line for anything else. */
export function failureCopy(reason: unknown): string {
  const known = knownFailureReason(reason);
  return known === undefined ? FAILURE_GENERIC : FAILURE_COPY[known];
}
