import {defineConfig} from 'vite';
import {resolve} from 'node:path';
export default defineConfig({root:resolve('tests/text-state/app'),build:{target:'esnext',outDir:resolve('artifacts/p1c2/app'),emptyOutDir:true},worker:{format:'es'}});
