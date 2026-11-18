# Icon

Every UI icon: Lucide (ISC) on a 24px grid plus AgentLink's custom set drawn on the same grid, 2px stroke, round caps.

- Provide `name` (see the grid; `window.AgentLink.iconNames`). Sizes 14, 16 (default), 20.
- Icons take `currentColor`. Give `label` only when the icon stands alone; otherwise it is hidden from screen readers.
- Status always pairs icon and word. The link icon is never used: hyperlinks are underlined text.

## Props

```ts
export interface IconProps { name: string; size?: number; strokeWidth?: number; label?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Icon } = window.AgentLink;
```

Live example: `../previews/Icon.html` (open through the screens preview server).
