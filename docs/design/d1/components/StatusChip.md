# StatusChip

Icon + uppercase mono word for a message, proof or agent status.

- Provide `status`. Tones: success (delivered, accepted, approved, online), info (sent, recording), proof (recorded), accent (needs approval), warning (needs setup or credits), danger (failed: integrity or irreversible only), neutral (everything else).
- Never colour alone; never invent statuses outside the list.

## Props

```ts
export interface StatusChipProps { status: Status; detail?: string; children?: React.ReactNode; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { StatusChip } = window.AgentLink;
```

Live example: `../previews/StatusChip.html` (open through the screens preview server).
