// A static site: every page is prerendered as an empty shell and renders in the browser (keys and
// plaintext never touch a server). Notes pages (/notes/<name>/) come from the SPA fallback.
export const ssr = false;
export const prerender = true;
export const trailingSlash = 'always';
