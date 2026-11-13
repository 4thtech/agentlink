// Electron's built-in `electron` module as the shell sees it (the subset in electron-api.ts). There
// is no `electron` npm package in this repository (plan 2026-11-12 Decision 1, M4).
declare module 'electron' {
  const electron: import('./electron-api.js').ElectronModule;
  export default electron;
}
