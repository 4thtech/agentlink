// The 11 §5.1 vocabulary lint for the invite page copy and prompt (test code only).

// 11 §5.1 "Never say" (as in packages/mcp-tools/src/strings/en.test.ts). Command literals in backticks
// are not prose.
export const BANNED: readonly [string, RegExp][] = [
  ['wallet', /\bwallets?\b/i],
  ['address', /\baddress(es)?\b/i],
  ['gas', /\bgas\b/i],
  ['seed phrase', /\bseed phrases?\b/i],
  ['private key', /\bprivate keys?\b/i],
  ['transaction', /\btransactions?\b/i],
  ['notarize', /\bnotari[sz]e[sd]?\b/i],
  ['smart contract', /\bsmart contracts?\b/i],
  ['on-chain', /\bon-chain\b/i],
  ['blockchain', /\bblockchains?\b/i],
  ['chain', /\bchains?\b/i],
  ['hash', /\bhash(es)?\b/i],
  ['nostr/relay', /\b(nostr|relays?)\b/i],
  ['envelope/harness/policy', /\b(envelope|harness|policy|policies)\b/i],
  ['MCP', /\bmcp\b/i],
  ['signature', /\bsignature\b/i],
  ['keystore', /\bkeystore\b/i],
  ['password', /\bpasswords?\b/i],
  ['exclamation', /!/],
];
