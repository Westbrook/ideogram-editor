import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({root:resolve('tests/recovery/app'),build:{target:'esnext',outDir:resolve(process.env.IE_RECOVERY_OUTPUT??'artifacts/p1b2','browser-app'),emptyOutDir:true}});
