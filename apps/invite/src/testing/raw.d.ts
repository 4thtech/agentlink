// Test code only: vitest (vite) imports a file's text with `?raw`, used to read site/_headers
// without Node file access (apps/invite is a browser package).
declare module '*?raw' {
  const text: string;
  export default text;
}
