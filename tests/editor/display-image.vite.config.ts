import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({
  root:fileURLToPath(new URL('./display-image-app/',import.meta.url)),
  resolve:{dedupe:['lit','lit-html','lit-element']},
  server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL('../../',import.meta.url))]}},
});
