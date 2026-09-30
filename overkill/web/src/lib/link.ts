import { base } from '$app/paths';

/** An in-app URL under the configured base path (GitHub Pages serves from a subpath). Pages end in "/". */
export const to = (path: string) => `${base}${path}`;

/** The page of one note. */
export const noteHref = (name: string) => to(`/notes/${encodeURIComponent(name)}/`);
