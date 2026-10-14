// RED stub (M1-1a): signatures only; the implementation follows in the next commit.
export const TAGS = {
  envelope: 'agentlink/envelope/v1',
  ownerAction: 'agentlink/owner-action/v1',
} as const;
export function sha256(_data: Uint8Array): Uint8Array {
  throw new Error('not implemented');
}
export function keccak256(_data: Uint8Array): Uint8Array {
  throw new Error('not implemented');
}
export function taggedHash(_tag: string, _message: Uint8Array): Uint8Array {
  throw new Error('not implemented');
}
