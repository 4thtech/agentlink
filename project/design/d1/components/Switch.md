# Switch

Binary setting that applies immediately. Shows ON/OFF in words beside the knob.

- Provide `label` and, when the effect isn't obvious, `description`.
- Owner rules saved through a switch still need owner presence (passkey or biometrics) on save.

## Props

```ts
export interface SwitchProps { label: string; description?: string; checked?: boolean; defaultChecked?: boolean; disabled?: boolean; onChange?: (on: boolean) => void }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Switch } = window.AgentLink;
```

Live example: `../previews/Switch.html` (open through the screens preview server).
