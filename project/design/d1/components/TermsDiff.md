# TermsDiff

Version-to-version change in agreed terms: old value struck through, new value tinted with a +, − or ~ sign.

- Provide `rows` of `{field, old, new, proposerWords}`. Mark subject and deliverable rows `proposerWords`: they are the proposer's text. Prices and dates are formatted by us.

## Props

```ts
export interface TermsDiffProps { rows: TermsDiffRow[]; oldLabel?: string; newLabel?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { TermsDiff } = window.AgentLink;
```

Live example: `../previews/TermsDiff.html` (open through the screens preview server).
