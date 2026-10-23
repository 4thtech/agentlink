// M1-35c-b: the 11 §5.1 "Never say" list as one shared source (the strings test and the pages use
// it; never copy it). Matched case-insensitively on whole words unless a pattern says otherwise.

export const NEVER_SAY: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['wallet', /\bwallets?\b/i],
  ['seed phrase', /\bseed phrases?\b/i],
  ['private key', /\bprivate keys?\b/i],
  ['transaction', /\btransactions?\b|\btx hash\b/i],
  ['gas', /\bgas\b/i],
  ['mint', /\bmint(ed|ing)?\b/i],
  ['notarize', /\bnotari[sz]\w*/i],
  ['blockchain', /\bblockchain\b|\bon-chain\b|\bsmart contracts?\b/i],
  ['chain', /\bchains?\b/i],
  ['network names', /\b(Base|Gnosis|Chiado)\b/],
  ['tokens', /\b(USDC|USDT|faucet|deposit|native token)\b/i],
  ['hash', /\bhash(es)?\b|\btermsHash\b/i],
  ['nostr/relay', /\bnostr\b|\brelays?\b/i],
  ['policy/harness', /\bpolic(y|ies)\b|\bharness\b|\benvelopes?\b|\bagent cards?\b/i],
  ['mcp', /\bMCP\b/],
  ['owner key / signature', /\bowner keys?\b|\bsignatures?\b/i],
  ['keystore', /\bkeystore\b|\.alks\b/i],
  ['password', /\bpasswords?\b/i],
  ['contract', /\bcontracts?\b|\blegally binding\b/i],
  ['commitment label', /\bcommitments?\b/i],
  ['unverified', /\bunverified\b/i],
  ['encryption key', /\bdecrypt\w*\b|\bencryption keys?\b/i],
  ['loopback address', /127\.0\.0\.1/],
  ['address', /\baddress\b/i],
];

export interface LintOptions {
  /** Advanced views may name technical terms (11 §5.1, "Advanced only"): nothing is flagged. */
  readonly advanced?: boolean;
  /** Reviewed exceptions: names from {@link NEVER_SAY} to skip for this text. */
  readonly allow?: readonly string[];
}

/** Names of the banned terms found in `text` (empty when the copy is clean). */
export function lintVocabulary(text: string, options: LintOptions = {}): string[] {
  if (options.advanced) return [];
  const allowed = options.allow ?? [];
  return NEVER_SAY.filter(([name, re]) => !allowed.includes(name) && re.test(text)).map(
    ([name]) => name,
  );
}

/** True for keys whose strings may name technical terms: `advanced.*` and `devconfig.*`. */
export function isExemptKey(key: string): boolean {
  const prefix = key.split('.')[0];
  return prefix === 'advanced' || prefix === 'devconfig';
}
