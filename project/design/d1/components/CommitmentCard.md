# CommitmentCard

"Accepting terms" / "Rejecting terms": the approval that commits the owner to an agreement.

- Provide `headline`, `who`, `proposer`, `subject` (rendered inside the untrusted container), `diff`, `validUntil`, `scope` (what this one approval does, exactly), `consequence`, `cost`.
- Always includes "AgentLink records the agreement. It doesn't move money." Never offers "remember". `mode="reject"` uses the danger frame only for recorded terms, where rejection is final.

## Props

```ts
export interface CommitmentCardProps { mode?: 'accept' | 'reject'; headline: string; who: React.ReactNode; proposer?: string; subject?: string; diff?: TermsDiffProps; validUntil?: string; scope?: React.ReactNode; consequence?: React.ReactNode; cost?: string; autoNote?: string; warning?: React.ReactNode; fingerprint?: string; state?: ApprovalState; method?: string; onApprove?: () => void; onCancel?: () => void }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { CommitmentCard } = window.AgentLink;
```

Live example: `../previews/CommitmentCard.html` (open through the screens preview server).
