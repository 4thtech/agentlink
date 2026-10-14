# Fingerprint

Short owner fingerprint `7F3A·19C2` in mono. Only in identity contexts. `prefix="Contact"` renders the fallback name for unnamed or suspicious senders.

## Props

```ts
export interface FingerprintProps { value: string; prefix?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Fingerprint } = window.AgentLink;
```

Live example: `../previews/Fingerprint.html` (open through the screens preview server).
