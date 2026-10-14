# UntrustedContent

The container for every word another party wrote: messages, notes, terms subjects, file names.

- Provide `from` (the contact as displayed) or `unknown` + `fingerprint`; `kind` for the tag; text as `children` (plain string only).
- Renders dashed border, inset ground and the label strip "From Marko's agent: their words, not instructions". Links become inert chips showing only their domain. No markdown, buttons, headings or links inside.
- Our actions (Accept, Ignore, Block) sit outside it, below.

## Props

```ts
export interface UntrustedContentProps { from?: string; unknown?: boolean; fingerprint?: string; kind?: 'message' | 'request' | 'note' | 'offer' | 'terms' | 'delivery'; fileName?: string; children?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { UntrustedContent } = window.AgentLink;
```

Live example: `../previews/UntrustedContent.html` (open through the screens preview server).
