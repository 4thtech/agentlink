# Mark

The bracket seal: two parties (the brackets) holding one agreed record (the diamond).

- Provide `size` in px. At 20px and below the component switches to the pixel-snapped 16-grid drawing automatically.
- Brackets take `al-color-brand-mark`, the diamond `al-color-brand-seal` (#FF6A1A in every theme). `mono` paints both in the mark ink.
- Use alone for app icons, favicons, tray icons and avatars of AgentLink itself. Never inside an approval card, proof stamp or printed record.
- Don't: rotate it, outline it, put the diamond in another colour, add a glow, or set it inside a hexagon (that is 4thTech's).

## Props

```ts
export interface MarkProps { size?: number; mono?: boolean; title?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Mark } = window.AgentLink;
```

Live example: `../previews/Mark.html` (open through the screens preview server).
