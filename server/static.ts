import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkPath } from './private-root.js';

// A synchronous, hash-authorized prelude strips the fragment before the browser
// discovers any shell script/style resources. The shell consumes and deletes
// __IE_PAIRING__ before its first fetch; never store it in browser persistence.
export const BOOTSTRAP_PRELUDE = `(()=>{const h=location.hash;history.replaceState(history.state,'',location.pathname+location.search);Object.defineProperty(window,'__IE_PAIRING__',{value:/^#pairing=[A-Za-z0-9_-]{43}$/.test(h)?h.slice(9):undefined,configurable:true});})();`;
export const BOOTSTRAP_CSP = `'sha256-${createHash('sha256').update(BOOTSTRAP_PRELUDE).digest('base64')}'`;
export type StaticFile = { bytes: Buffer; type: string };
const types: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  woff2: 'font/woff2', ico: 'image/x-icon',
};

export async function loadStatic(directory?: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  let html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ideogram Editor</title></head><body><h1>Local server ready</h1><p>The browser editor shell has not been built yet.</p></body></html>';
  if (directory) {
    await checkPath(directory);
    const root = resolve(directory);
    async function visit(path: string, prefix: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        const route = `${prefix}/${entry.name}`;
        const stat = await lstat(full);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsafe browser build path.');
        if (stat.isDirectory()) { await visit(full, route); continue; }
        if (route === '/index.html') { html = await readFile(full, 'utf8'); continue; }
        const type = types[entry.name.split('.').at(-1)!];
        // Only the trusted browser build is public. No source maps, config,
        // hidden files, storage files, arbitrary HTML or uploaded SVG.
        if (type && !route.split('/').some(part => part.startsWith('.'))) files.set(route, { bytes: await readFile(full), type });
      }
    }
    await visit(root, '');
    if (!/<head(?:\s[^>]*)?>/i.test(html) || !(await lstat(join(root, 'index.html'))).isFile()) throw new Error('Browser build needs an index.html head.');
  }
  html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<script>${BOOTSTRAP_PRELUDE}</script>`);
  files.set('/', { bytes: Buffer.from(html), type: 'text/html; charset=utf-8' });
  return files;
}
