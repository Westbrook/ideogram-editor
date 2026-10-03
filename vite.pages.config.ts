import { defineConfig, type Plugin } from 'vite';
import { appendFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const root = process.cwd();
const commit = process.env.PAGES_SOURCE_COMMIT;
const builtAt = process.env.PAGES_BUILD_DATE;
const metadata = process.env.PAGES_BUILD_METADATA;
const output = process.env.PAGES_BUILD_OUTPUT;
if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !builtAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(builtAt) || new Date(builtAt).toISOString() !== builtAt ||
    !metadata || !isAbsolute(metadata) || realpathSync(metadata) !== metadata || !lstatSync(metadata).isDirectory() ||
    !output || !isAbsolute(output) || realpathSync(output) !== output || !lstatSync(output).isDirectory()) {
  throw Error('Use the explicit, validated tooling/pages/build.mjs entry point');
}

// This entry imports a browser-only slice, not the local editor session or API.
// Both main and worker graphs pass the same dependency/license boundary. The
// inventory stays in private build evidence; it never enters the public artifact.
const packages = new Set(['@en-reve/elements', '@en-reve/primitives', '@en-reve/styles', '@en-reve/tokens',
  '@lit/reactive-element', '@lit/context', 'lit', 'lit-html', 'lit-element', 'signal-polyfill', 'signal-utils', 'canvaskit-wasm']);
function publicGraph(): Plugin {
  const seen = new Set<string>();
  return {
    name: 'ideogram-pages-public-graph', enforce: 'pre',
    transform(_code, id) {
      if (id.startsWith('\0')) return;
      // Rolldown 1.2.11's Vite resolver emits an empty CJS module for production builds.
      const browserExternal = id === '__vite-browser-external';
      if (browserExternal && _code.trim() !== 'module.exports = {}') throw Error('Unexpected Vite browser external stub');
      const path = browserExternal ? id : relative(root, id.split('?')[0]).replaceAll('\\', '/');
      if (path.startsWith('../') || isAbsolute(path)) throw Error('Pages module is outside the owned repository');
      const packageMatch = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
      const admitted = browserExternal || (packageMatch ? packages.has(packageMatch[1]) :
        /^(pages\/(?!tests\/)|src\/(?:text|observability|theme)\/|vendor\/text\/fonts\/)/.test(path) ||
        ['src/protocol/text-budget.ts', 'src/ui/adapters.ts', 'src/ui/native-text-preview.ts'].includes(path));
      if (!admitted) throw Error(`Module is outside the public Pages slice: ${path}`);
      if (!seen.has(path)) {
        if (seen.size >= 2048 || path.length > 1024) throw Error('Pages module inventory bound exceeded');
        seen.add(path);
        appendFileSync(resolve(metadata!, 'modules.jsonl'), JSON.stringify({ path }) + '\n', { mode: 0o600 });
      }
    },
  };
}

export default defineConfig({
  root: resolve(root, 'pages'), base: '/ideogram-editor/', publicDir: false,
  envDir: false, envPrefix: '__IDEOGRAM_PAGES_UNUSED_PUBLIC_PREFIX__',
  plugins: [publicGraph()], css: { postcss: { plugins: [] } },
  define: { __PAGES_SOURCE_COMMIT__: JSON.stringify(commit), __PAGES_BUILD_DATE__: JSON.stringify(builtAt) },
  worker: { format: 'es', plugins: () => [publicGraph()] },
  build: { outDir: output, emptyOutDir: false, target: 'es2022',
    sourcemap: false, assetsInlineLimit: 0, manifest: false },
});
