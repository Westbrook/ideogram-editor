import {defineConfig} from 'vite';
import {resolve} from 'node:path';
export default defineConfig({root:resolve('tests/text/app'),build:{target:'esnext',outDir:resolve('artifacts/p1c1/app'),emptyOutDir:true},worker:{format:'es'}});
