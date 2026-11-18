# SafetyCode

Twelve grouped digits to compare out of band at pairing.

- Provide `code` and `contactName`; `state` drives unchecked → matched or mismatch, and `changed` after a key update.
- Mismatch stops pairing calmly (warning tone, not red) and says nothing was shared. Screen readers read the digits in groups.

## Props

```ts
export interface SafetyCodeProps { code: string; contactName?: string; state?: 'unchecked' | 'matched' | 'mismatch' | 'changed'; onMatch?: () => void; onMismatch?: () => void }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { SafetyCode } = window.AgentLink;
```

Live example: `../previews/SafetyCode.html` (open through the screens preview server).
