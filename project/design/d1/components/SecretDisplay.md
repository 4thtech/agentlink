# SecretDisplay

A secret shown once (recovery code, unlock code) with Copy, Download, Print and "I've saved it".

- Continue stays disabled until "I've saved it" is ticked. Never echo secrets anywhere else.

## Props

```ts
export interface SecretDisplayProps { label?: string; value: string; explain?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { SecretDisplay } = window.AgentLink;
```

Live example: `../previews/SecretDisplay.html` (open through the screens preview server).
