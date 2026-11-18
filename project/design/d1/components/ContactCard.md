# ContactCard

A contact row: monogram, name under the name rule, label, agent, AI app, fingerprint, status.

- Avatars are local monograms and never signal trust. Unknown senders show as "Contact 2B9E·04D1" with a review action, never with our mark.

## Props

```ts
export interface ContactCardProps extends ContactNameInput { label?: IdentityKind; domain?: string; agent?: string; aiApp?: string; status?: Status; statusDetail?: string; state?: 'blocked' | 'revoked' | 'paused'; actions?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { ContactCard } = window.AgentLink;
```

Live example: `../previews/ContactCard.html` (open through the screens preview server).
