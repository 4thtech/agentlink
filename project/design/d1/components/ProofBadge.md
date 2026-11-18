# ProofBadge

Proof state for a message or file: recording, recorded (with exact time), waiting for approval, failed.

- Uses the proof seal colour, never the success colour. Recording spins only when motion is allowed.

## Props

```ts
export interface ProofBadgeProps { state?: 'recording' | 'recorded' | 'failed' | 'waiting'; time?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { ProofBadge } = window.AgentLink;
```

Live example: `../previews/ProofBadge.html` (open through the screens preview server).
