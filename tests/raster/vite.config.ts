import {defineConfig} from 'vite';
import {resolve} from 'node:path';
export default defineConfig({root:resolve('tests/raster/app'),build:{target:'esnext',outDir:resolve('artifacts/p1b4/browser-app'),emptyOutDir:true}});
