# CreditsMeter

Credit balance in dollars, proofs left, and today's spend against the daily budget.

- Provide `balance`, `proofsLeft`, `spentToday`, `budget`. `state` low or empty promotes Add credits to primary and adds "Messages and files stay free."

## Props

```ts
export interface CreditsMeterProps { balance: string; proofsLeft: number; spentToday: number; budget: number; state?: 'low' | 'empty' | 'reached'; test?: boolean }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { CreditsMeter } = window.AgentLink;
```

Live example: `../previews/CreditsMeter.html` (open through the screens preview server).
