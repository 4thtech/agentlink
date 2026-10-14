# FileCard

A file with its sanitized name (mono), size, expiry, integrity and receipts.

- File names are counterparty content: sanitized (no control or bidi characters, 80 max) and never used as a heading.
- Integrity failure is a danger state: "Failed its integrity check; not saved."

## Props

```ts
export interface FileCardProps { name: string; size: string; expiry?: string; from?: string; integrity?: 'ok' | 'failed'; proof?: ProofBadgeProps['state']; proofTime?: string; status?: Status; action?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { FileCard } = window.AgentLink;
```

Live example: `../previews/FileCard.html` (open through the screens preview server).
