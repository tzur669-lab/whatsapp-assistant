/** Wrangler bundles `.sql` files as text, so they import as a default string. */
declare module '*.sql' {
  const content: string;
  export default content;
}
