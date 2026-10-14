// The ApprovalChannel interface (03 §3, §4.5; 06 §2.5). It carries an approval request to the owner
// and brings back what the owner signed. Packagings differ only here: the local approval server
// (Node, M1-8), the desktop app's native window (M2) and the console over an encrypted envelope.
//
// I-4: a channel is delivery, not authority. Nothing a channel returns approves anything by itself.
// A decision counts only as an owner-signed `approval.decide` (or `approval.cancel`) that the core
// verifies against the stored request, its action digest, the owner key and the nonce table, in one
// store transaction (04 §2.5.1; M1-7d, M1-7e). The `status` a channel reports, and the approval row's
// `status` column, are caches. A channel cannot create, decide or widen an approval, and no MCP tool
// reaches one.
//
// I-5: `summary` is fixed text the core builds under the contact-name rule (06 §2.1): it names the
// contact and the action, never inbound text.

/** What the core asks a channel to show the owner. Built by the core from stored data only. */
export interface ApprovalRequest {
  /** `apr_` + base64url, the approval row's key (06 §2.5). */
  readonly approvalId: string;
  /** sha256(JCS(action)) as 64 lowercase hex (M1-7e), or the commitment scope digest (04 §3.4.2). */
  readonly actionDigest: string;
  /** Fixed text built by the core; never inbound content (I-5, 06 §2.1). */
  readonly summary: string;
  /** When the request lapses, in unix seconds (G-7: created_at + 86 400, or the scope's expiry). */
  readonly expiresAt: number;
}

/** What a channel hands back after `request`: where the owner can decide, if the channel has a page. */
export interface ApprovalTicket {
  readonly approvalId: string;
  /** The local approval page (`http://127.0.0.1:<port>/approve/<id>`) or a console link; optional. */
  readonly url?: string;
}

/**
 * What a channel knows about a request. `signed` is the exact JSON text of the owner's
 * SignedOwnerAction as the channel received it: unverified data until the core checks it.
 */
export type ApprovalChannelStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'signed'; readonly signed: string }
  | { readonly state: 'unknown' };

export interface ApprovalChannel {
  /** Delivers a request to the owner. Never decides it. */
  request(request: ApprovalRequest): Promise<ApprovalTicket>;
  /** Reports what the channel holds for a request. The core verifies any `signed` object itself. */
  status(approvalId: string): Promise<ApprovalChannelStatus>;
}
