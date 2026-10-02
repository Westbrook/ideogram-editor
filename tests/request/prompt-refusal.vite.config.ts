import {defineConfig} from 'vite';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Supply the complete assembled source tree, not a partial correction directory.
// Every actual controller, child, and ledger import resolves within this tree.
const sourceRoot=resolve(process.env.REQUEST_PROMPT_SOURCE_ROOT??'.');
const here=dirname(fileURLToPath(import.meta.url));
export default defineConfig({
 root:resolve(here,'prompt-refusal-fixture'),
 resolve:{alias:{'@request-prompt-source':resolve(sourceRoot,'src')},dedupe:['lit','signal-polyfill','signal-utils']},
 server:{host:'127.0.0.1',port:4187,strictPort:true,fs:{strict:true,allow:[sourceRoot,resolve('.'),here]}},
 cacheDir:resolve(process.env.REQUEST_PROMPT_BROWSER_OUTPUT??'artifacts/request-prompt-refusal-browser','vite-cache'),
 build:{target:'esnext',outDir:resolve(process.env.REQUEST_PROMPT_BROWSER_OUTPUT??'artifacts/request-prompt-refusal-browser','fixture'),emptyOutDir:true},
});
