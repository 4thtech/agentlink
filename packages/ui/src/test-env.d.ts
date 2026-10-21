// Type shims for the Vite features the tests use (`?raw` imports and import.meta.glob). The
// package has no Node types, and tests read files through Vite instead of node:fs (the ui zone
// allows no Node built-ins). Declarations only: nothing here is emitted.
declare module '*?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(
    pattern: string | readonly string[],
    options: { readonly query: string; readonly import: 'default'; readonly eager: true },
  ): Record<string, string>;
}
