import {defineConfig} from 'vite';
import {resolve} from 'node:path';
export default defineConfig({build:{ssr:resolve('server/text/render-worker.mjs'),target:'node26',outDir:resolve('dist/local/server/text'),emptyOutDir:false,rollupOptions:{external:['canvaskit-wasm'],output:{entryFileNames:'render-worker.mjs'}}}});
