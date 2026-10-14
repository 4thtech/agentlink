# Toast

Transient outcome + one view/undo action. Lives in a polite live region; never covers the focused control; never approves anything.

## Props

```ts
export interface ToastProps { tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'proof'; icon?: string; action?: string; children?: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Toast } = window.AgentLink;
```

Live example: `../previews/Toast.html` (open through the screens preview server).
