// The core components (M1-35b, D-116): the 31 specs of docs/design/d1/components rebuilt in React
// with the DESIGN-ADJ-1 fixes. Classes only (`@4thtech-io/ui/components.css` on top of
// `tokens.css`), no inline styles (08 §4 CSP); text from other parties is text only (I-5).
//
// B-2 (M1-35b-b) is built: the review-together view and the ApprovalCard batch variant. Not here,
// waiting for the owner's redesign briefs (docs/design/adjustments.md): the receipt request card
// (B-1) and the export proof dialog (B-8). They are not invented.
export * from './approval.js';
export * from './brand.js';
export * from './feedback.js';
export * from './forms.js';
export * from './identity.js';
export * from './proof.js';
export * from './review.js';
export * from './shell.js';
export * from './trust.js';
export type {
  ApprovalState,
  ContactNameInput,
  ContactStatus,
  IdentityKind,
  Status,
  Tone,
} from './types.js';
