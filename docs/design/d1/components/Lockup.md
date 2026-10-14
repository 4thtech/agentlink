# Lockup

Mark plus wordmark, horizontal or stacked, optionally with the "by 4thTech" endorsement.

- `endorsed` only on: console sign-in, onboarding, About, desktop first run, installer and update screens, marketing site, and the footers of console, verify, invite and pay.
- Never endorsed in: app chrome, approval cards, tray, app icons, favicons, chat text, proof stamps, printed records.
- Clear space: the diamond's width on every side. Minimum horizontal lockup width 96px.

## Props

```ts
export interface LockupProps { size?: number; layout?: 'horizontal' | 'stacked'; endorsed?: boolean; mono?: boolean; productName?: string; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Lockup } = window.AgentLink;
```

Live example: `../previews/Lockup.html` (open through the screens preview server).
