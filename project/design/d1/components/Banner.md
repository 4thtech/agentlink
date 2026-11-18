# Banner

Page-level message with icon, one or two sentences and at most one action.

- Tones: offline/neutral, info, success, warning (weaker setups, near quota), danger (integrity or signature failures only). Errors say what happened, whether anything was sent or charged, and what to do.

## Props

```ts
export interface BannerProps { tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'offline' | 'proof'; title?: string; icon?: string; action?: React.ReactNode; compact?: boolean; children?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Banner } = window.AgentLink;
```

Live example: `../previews/Banner.html` (open through the screens preview server).
