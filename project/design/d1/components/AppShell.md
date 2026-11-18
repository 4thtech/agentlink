# AppShell

Desktop dashboard and console frame: sidebar, content, IDE-style status bar.

- Provide `nav`, `agent`, `connection`, `statusItems`, `version`. `os` draws the window chrome for mockups only (macOS traffic lights left, Windows and Linux controls right); real apps use native chrome.
- Below 600px the sidebar hides and bottom tabs take over (Home, Approvals, Threads, Proofs, More).

## Props

```ts
export interface AppShellProps { os?: 'macos' | 'windows' | 'linux'; title?: string; agent?: string; nav?: NavItem[]; connection?: 'connected' | 'offline' | 'paused'; statusItems?: string[]; version?: string; height?: number | string; children?: React.ReactNode; className?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { AppShell } = window.AgentLink;
```

Live example: `../previews/AppShell.html` (open through the screens preview server).
