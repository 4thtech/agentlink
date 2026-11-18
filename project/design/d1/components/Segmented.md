# Segmented

Pick one of 2–4 options, used for rules (Allowed / Ask me / Never).

- Mark the safe default with `hint: 'recommended'`. "Accepting terms" never offers "Always allow".

## Props

```ts
export interface SegmentedProps { label: string; options: { value: string; label: string; hint?: string }[]; value?: string; defaultValue?: string; onChange?: (v: string) => void }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Segmented } = window.AgentLink;
```

Live example: `../previews/Segmented.html` (open through the screens preview server).
