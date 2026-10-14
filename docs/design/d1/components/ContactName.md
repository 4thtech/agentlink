# ContactName

Applies the name rule on every surface outside the untrusted container.

- Provide `alias` (the owner typed or confirmed it) or `name` (theirs) plus `fingerprint` and `label`.
- Alias → as is. Otherwise the restricted name (letters, digits, spaces, . ' - only, 32 max) in quotes, in body weight, followed by its label. Reserved words, mixed scripts or nothing usable → "Contact 7F3A·19C2".
- `window.AgentLink.formatContactName` exposes the same rule for notifications, OS prompts and chat text.

## Props

```ts
export interface ContactNameProps extends ContactNameInput { label?: IdentityKind; domain?: string; showLabel?: boolean; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { ContactName } = window.AgentLink;
```

Live example: `../previews/ContactName.html` (open through the screens preview server).
