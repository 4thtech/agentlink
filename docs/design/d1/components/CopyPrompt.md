# CopyPrompt

The "Paste this to your agent" block and terminal commands. The largest element of onboarding.

- `prompt` for natural-language text to paste into an AI; `command` for a shell line (rendered after a `$`). `size="hero"` makes Copy primary.
- Commands on their own line, no smart quotes, monospace, wraps without horizontal scroll.

## Props

```ts
export interface CopyPromptProps { prompt?: string; command?: string; title?: string; note?: string; size?: 'default' | 'hero' }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { CopyPrompt } = window.AgentLink;
```

Live example: `../previews/CopyPrompt.html` (open through the screens preview server).
