# ApprovalCard

The one-screen owner decision: consequences and cost first, then Approve with the named method.

- Provide `type`, `agent`, `headline`, and the rows that apply: `who`, `what`, `cost`, `why` (the rule), `consequence`; `details` for Advanced IDs.
- No default button, no autofocus on Approve; focus starts on the headline. The real OS or browser prompt appears only after Approve is clicked; never draw one.
- `state` covers pending, waiting (for the passkey), approved, denied, expired, failed and decided elsewhere. The footer "Your AI can't approve this for you." is always present.
- "Remember for this contact" only for new-contact and proof-limit approvals, and it shows the rule change.

## Props

```ts
export interface ApprovalCardProps { type: 'new-contact' | 'proof' | 'file-over-limit' | 'document-key'; agent: string; time?: string; expires?: string; headline: string; who?: React.ReactNode; what?: React.ReactNode; cost?: React.ReactNode; why?: React.ReactNode; consequence?: React.ReactNode; details?: React.ReactNode; state?: ApprovalState; method?: string; onApprove?: () => void; onDeny?: () => void; children?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { ApprovalCard } = window.AgentLink;
```

Live example: `../previews/ApprovalCard.html` (open through the screens preview server).
