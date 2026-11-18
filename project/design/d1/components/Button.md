# Button

Verb-first, sentence-case actions.

- `primary` (orange) at most once per view, for the thing the view is for. Approve buttons always name the method: "Approve with Touch ID".
- `secondary` is the default. `ghost` for tertiary actions in toolbars. `danger` only for destructive or irreversible actions (Block, Reject recorded terms).
- `lg` (44px) for approvals and on mobile. Never autofocus an approve button; there is no default button on approval surfaces.

## Props

```ts
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; icon?: string; iconRight?: string; kbd?: string; block?: boolean }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Button } = window.AgentLink;
```

Live example: `../previews/Button.html` (open through the screens preview server).
