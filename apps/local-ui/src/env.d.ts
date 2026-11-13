// Side-effect style imports of the design system: Vite turns them into hashed CSS files.
declare module '@4thtech-io/ui/*.css';

// N5: a bundled file's URL (Vite emits it as a hashed asset; assetsInlineLimit 0, never data:).
declare module '*.svg?url' {
  const src: string;
  export default src;
}
