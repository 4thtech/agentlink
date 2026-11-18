# IdentityLabel

How strongly a contact's identity is established, weakest to strongest: Self-declared, Safety code checked, Registered, Verified domain.

- Provide `kind`; `domain` for verified (show `punycode` for international names); `date` for "Domain no longer verified".
- A label is ours; a name is theirs. A name never stands where a label stands and no label is derived from a name. Truncated names keep their label visible.

## Props

```ts
export interface IdentityLabelProps { kind: IdentityKind; domain?: string; punycode?: string; date?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { IdentityLabel } = window.AgentLink;
```

Live example: `../previews/IdentityLabel.html` (open through the screens preview server).
