// The address-checked RPC fetch brand (IR-M1-4a-2 R-3; 04 §4; 07 §6.1).
//
// createReadClient builds a client only over the platform's address-checked fetch: in Node,
// `@4thtech-io/node` nodeRpcFetch, which resolves the host on every request, refuses loopback,
// private, link-local and unique-local answers and connects to the checked address itself. That
// fetch carries this brand as a read-only own property; a plain `fetch` (or any wrapper of it) does
// not, so the product path cannot build a read client that skips the resolve-time check.
//
// The key is a registered symbol so the Node package can set it without depending on this one;
// `packages/node/src/rpc-fetch.test.ts` checks that both sides spell it the same. ESLint refuses
// `Symbol.for` in production code outside the two files that set and check it. This is a guard
// against a wiring mistake, not a security boundary: code running in the process could copy the
// brand, which is why the global fetch is refused even when it carries it.
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');

/** True for a function that carries the address-checked brand and is not the global fetch. */
export function isAddressCheckedFetch(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  if (fn === (globalThis as { fetch?: unknown }).fetch) return false;
  const brand = Object.getOwnPropertyDescriptor(fn, ADDRESS_CHECKED);
  return brand !== undefined && 'value' in brand && brand.value === true;
}
