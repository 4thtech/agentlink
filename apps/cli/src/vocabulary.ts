// M1-36e: the 11 §5.1 "Never say" list for everything the CLI shows a person: terminal output, tool
// summaries, `nextStep` and hints. One list for the CLI's lints (apps/cli/src/vocabulary.test.ts);
// the shared UI list (@4thtech-io/ui `NEVER_SAY`) and this one name the same terms.
//
// Only prose is linted: a command or tool name in backticks (`npx -y @4thtech-io/agentlink policy
// show`, `agentlink_notarize`) and a `<code>` element are what the person types or reads as a name,
// not words we chose, so they are removed first. Matching is on whole words, so "keychain" never
// matches "chain" and "rehash" never matches "hash".

/** One banned term: its name (used in allowlists and messages) and what matches it. */
export interface BannedTerm {
  readonly name: string;
  readonly pattern: RegExp;
}

/** 11 §5.1, "Never say" (default UI and in-chat copy), plus the §5.3 tone markers. */
export const NEVER_SAY: readonly BannedTerm[] = Object.freeze([
  { name: 'wallet', pattern: /\bwallets?\b/i },
  { name: 'address', pattern: /\baddress(es)?\b/i },
  { name: 'private key', pattern: /\bprivate keys?\b/i },
  { name: 'seed phrase', pattern: /\bseed phrases?\b/i },
  { name: 'transaction', pattern: /\btransactions?\b|\btx\b/i },
  { name: 'gas', pattern: /\bgas\b/i },
  { name: 'mint', pattern: /\bmint(s|ed|ing)?\b/i },
  { name: 'notarize', pattern: /\bnotari[sz](e|es|ed|ing|ation)\b/i },
  { name: 'blockchain', pattern: /\bblockchains?\b|\bon-chain\b|\bsmart contracts?\b/i },
  { name: 'chain', pattern: /\bchains?\b/i },
  { name: 'network name', pattern: /\b(Gnosis|Chiado|Sepolia)\b/i },
  { name: 'token', pattern: /\b(USDC|USDT|faucets?|deposits?|native tokens?)\b/i },
  { name: 'hash', pattern: /\bhash(es)?\b|\btermsHash\b/i },
  { name: 'nostr/relay', pattern: /\bnostr\b|\brelays?\b/i },
  { name: 'encryption key', pattern: /\bdecrypt\w*|\bencryption keys?\b/i },
  { name: 'policy', pattern: /\bpolic(y|ies)\b/i },
  { name: 'harness/envelope', pattern: /\bharness(es)?\b|\benvelopes?\b|\bagent cards?\b/i },
  { name: 'MCP', pattern: /\bMCP\b/i },
  { name: 'owner key', pattern: /\bowner keys?\b/i },
  { name: 'signature', pattern: /\bsignatures?\b/i },
  { name: 'keystore', pattern: /\bkey ?stores?\b|\.alks\b/i },
  { name: 'contract', pattern: /\bcontracts?\b|\blegally binding\b/i },
  { name: 'commitment', pattern: /\bcommitments?\b/i },
  { name: 'unverified', pattern: /\bunverified\b/i },
  // "Password manager" names the user's own tool (11 §5.5), not one of our codes.
  { name: 'password', pattern: /\bpasswords?\b(?! managers?\b)/i },
  { name: 'approximation', pattern: /≈/ },
  { name: 'emoji', pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
]);

/** The prose of `text`: backticked literals and `<code>` elements removed. */
export function proseOf(text: string): string {
  return text.replace(/`[^`]*`/g, ' ').replace(/<code>[\s\S]*?<\/code>/g, ' ');
}

/**
 * The names of the banned terms in the prose of `text`, minus `allow` (the reviewed exceptions for
 * this one text). Empty when the text is clean.
 */
export function lintVocabulary(text: string, allow: readonly string[] = []): string[] {
  const prose = proseOf(text);
  return NEVER_SAY.filter(({ name, pattern }) => !allow.includes(name) && pattern.test(prose)).map(
    ({ name }) => name,
  );
}
