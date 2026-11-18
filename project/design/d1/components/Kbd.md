# Kbd

A keyboard key, for shortcuts in menus, tooltips and docs. Show the platform's own: ⌘ on macOS, Ctrl on Windows and Linux.

## Props

```ts
export interface KbdProps { children: React.ReactNode }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { Kbd } = window.AgentLink;
```

Live example: `../previews/Kbd.html` (open through the screens preview server).
