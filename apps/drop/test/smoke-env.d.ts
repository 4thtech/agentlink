// Vite `?raw` imports (M1-27b config assertions): the file's text as a string.
declare module '*?raw' {
  const text: string;
  export default text;
}
