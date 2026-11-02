/** Stylesheets the preview imports for their side effect (Vite injects them). */
declare module '*.css';

/** Vite's `?inline` import: the stylesheet's text, not injected into the page. */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
