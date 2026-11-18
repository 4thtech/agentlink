# EmptyState

One sentence plus a prompt to try in your AI, e.g. Try: "Send the signed contract to Marko and notarize it."

## Props

```ts
export interface EmptyStateProps { title: string; prompt?: string; icon?: string; action?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { EmptyState } = window.AgentLink;
```

Live example: `../previews/EmptyState.html` (open through the screens preview server).
