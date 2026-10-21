// Vite `?raw` imports (M1-10c config assertions): the file's text as a string.
declare module '*?raw' {
  const text: string;
  export default text;
}
