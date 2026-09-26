import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({root:resolve('tests/recovery/app'),build:{target:'esnext',outDir:resolve('artifacts/p1b2/browser-app'),emptyOutDir:true}});
