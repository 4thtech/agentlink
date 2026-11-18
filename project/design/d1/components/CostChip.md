# CostChip

An exact dollar amount in mono, or "Free". Put the split ("AgentLink $0.10 · App fee $0.00") in `split` (tooltip) or details; never "≈".

## Props

```ts
export interface CostChipProps { amount?: string; free?: boolean; source?: string; split?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { CostChip } = window.AgentLink;
```

Live example: `../previews/CostChip.html` (open through the screens preview server).
