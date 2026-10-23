// The pay page entry of the shipped config (M1-26-e; docs/design/topup-ux.md §5, 08 §1, D-113).
//
// The top-up link names this host and no other. It ships with the client release and is never read
// from inbound content, a tool argument or the network. `live` says whether the pay page is
// deployed: while it is false the client gives no top-up link, no QR code and does not open a
// browser. Turning it on is a release decision made when the page exists (M2-10 fixes the final host).
export interface PayPageConfig {
  /** A plain lowercase host name: no scheme, path, port or userinfo. */
  readonly host: string;
  /** True only once the pay page is deployed at `host`. */
  readonly live: boolean;
}

/** The testing host (D-28) until the production domain is decided (M2-10). Not live yet. */
export const PAY_PAGE: PayPageConfig = Object.freeze({
  host: 'pay.agentlink.4thtech.io',
  live: false,
});
