# ReceiptTimeline

Recorded → Delivered → Opened → Accepted / Rejected with exact times; pending steps hollow and dashed.

- Provide `steps`. Free receipts (`free: true`) render lighter than paid proof receipts.

## Props

```ts
export interface ReceiptTimelineProps { steps: ReceiptStep[] }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { ReceiptTimeline } = window.AgentLink;
```

Live example: `../previews/ReceiptTimeline.html` (open through the screens preview server).
