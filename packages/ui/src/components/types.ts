// Shared prop types of the components (M1-35b; docs/design/d1/components/*.md with the
// DESIGN-ADJ-1 fixes C-1…C-10).

/** Name rule input (11 §5.2): the alias the owner typed, or the name the contact declared. */
export interface ContactNameInput {
  alias?: string;
  name?: string;
  fingerprint?: string;
}

/** How strongly a contact's identity is established, weakest to strongest. */
export type IdentityKind =
  'selfdeclared' | 'checked' | 'registered' | 'verified' | 'domain-warning';

/** The statuses a chip can show (11 §8): never invent others. */
export type Status =
  | 'sent'
  | 'received'
  | 'delivered'
  | 'opened'
  | 'accepted'
  | 'rejected'
  | 'delivery-requested'
  | 'recording'
  | 'recorded'
  | 'waiting-to-post'
  | 'needs-approval'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'needs-setup'
  | 'needs-credits'
  | 'failed'
  | 'flagged'
  | 'online'
  | 'last-seen'
  | 'paused'
  | 'offline';

/** AgentLink has no presence for contacts (06 §2.1): a contact never shows these. */
export type ContactStatus = Exclude<Status, 'online' | 'offline' | 'last-seen'>;

export type ApprovalState =
  'pending' | 'waiting' | 'approved' | 'denied' | 'expired' | 'failed' | 'decided-elsewhere';

export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'proof' | 'accent';
