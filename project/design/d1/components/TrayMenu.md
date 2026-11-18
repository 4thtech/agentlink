# TrayMenu

Tray / menu-bar menu: status, Approvals waiting (n), Open dashboard, Pause / Resume, Update ready, Quit.

- The tray icon itself is a monochrome template (assets: Tray). Status variants differ by shape, never colour.

## Props

```ts
export interface TrayMenuProps { os?: 'macos' | 'windows' | 'linux'; status?: 'connected' | 'paused' | 'offline'; approvals?: number; updateReady?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { TrayMenu } = window.AgentLink;
```

Live example: `../previews/TrayMenu.html` (open through the screens preview server).
