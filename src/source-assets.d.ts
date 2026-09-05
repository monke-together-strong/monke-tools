/** Vite loads ?raw imports in tests; Bun's text loader embeds the same checked source in mt. */
declare module "*?raw" {
  const source: string;
  export default source;
}
