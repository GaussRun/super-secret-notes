// Writes static/diagram.svg: the "how a note travels" diagram as one standalone file for the
// READMEs (GitHub shows SVGs without loading anything else, so the logos are embedded as data
// URIs). Light colors, dark ones under prefers-color-scheme: dark. Run: node scripts/diagram.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { diagramSvg, diagramStyle } from '../src/lib/diagram.ts';
import { defaultBackends } from '../../cli/src/defaults.js';

// the counts come from the CLI's own default list (no host cache, CryptPad included)
delete process.env.OVERKILL_DEFAULT_BACKENDS;
const defaults = defaultBackends({ cryptpad: true });
const counts = Object.fromEntries(['privatebin', 'cryptpad', 'nostr'].map((t) => [t, defaults.filter((b) => b.type === t).length]));
if (counts.privatebin + counts.cryptpad + counts.nostr !== defaults.length) throw new Error('a default host type the diagram does not show');

const mime = (f) => (f.endsWith('.png') ? 'image/png' : 'image/svg+xml');
const logo = (f) => `data:${mime(f)};base64,${readFileSync(new URL(`../static/logos/${f}`, import.meta.url)).toString('base64')}`;
const light = diagramStyle({ text: '#1b2430', muted: '#5b6b7a', line: '#7b8a98', box: '#f4f7fa', boxStroke: '#c9d3dd', accent: '#0a8f4f', row: '#ffffff', tile: '#ffffff' });
const dark = diagramStyle({ text: '#d9e4ee', muted: '#8aa0b4', line: '#8aa0b4', box: '#121922', boxStroke: '#243241', accent: '#39ff88', row: '#17212c', tile: '#ffffff' });
const style = `svg{background:#ffffff}${light}@media (prefers-color-scheme: dark){svg{background:#0b0f14}${dark}}`;
writeFileSync(new URL('../static/diagram.svg', import.meta.url), diagramSvg('wide', counts, { logoHref: logo, style, id: 'dg' }) + '\n');
