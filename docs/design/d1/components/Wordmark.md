# Wordmark

The AgentLink name drawn from Geist Mono SemiBold outlines.

- Provide `height` (cap-to-descender box). Minimum 12px on screen, 4mm in print.
- Use the SVG wherever the name is a logo; in running text write the live string `{productName}` instead.
- Fills with `al-color-brand-wordmark`.

## Props

```ts
export interface WordmarkProps { height?: number; productName?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Wordmark } = window.AgentLink;
```

Live example: `../previews/Wordmark.html` (open through the screens preview server).
