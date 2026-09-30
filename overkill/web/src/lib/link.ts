import { base } from '$app/paths';

/** An in-app URL under the configured base path (GitHub Pages serves from a subpath). Pages end in "/". */
export const to = (path: string) => `${base}${path}`;

/** The page of one note. */
export const noteHref = (name: string) => to(`/notes/${encodeURIComponent(name)}/`);

// where the unlock page may send you afterwards (?next=): these in-app pages and nothing else,
// so the parameter can never become an open redirect
const NEXT_PAGES = ['/notes/', '/new/', '/check/', '/status/', '/hosts/', '/recovery-kit/', '/settings/'];

/** The `next` path if it is one of the allowed in-app pages, else /notes/. */
export const safeNext = (next: string | null) => (next && NEXT_PAGES.includes(next) ? next : '/notes/');
