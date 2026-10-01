import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
export const allocationsURL=data((await transformWithOxc(await readFile('src/observability/allocations.ts','utf8'),'allocations.ts')).code);
let code=(await transformWithOxc(await readFile('src/observability/owned-preview.ts','utf8'),'owned-preview.ts')).code;
code=code.replaceAll(JSON.stringify('./allocations.js'),JSON.stringify(allocationsURL)).replaceAll("'./allocations.js'",JSON.stringify(allocationsURL));
export const ownedPreviewURL=data(code);

let promptCode=(await transformWithOxc(await readFile('src/observability/prompt-memory.ts','utf8'),'prompt-memory.ts')).code;
promptCode=promptCode.replaceAll(JSON.stringify('./allocations.js'),JSON.stringify(allocationsURL)).replaceAll("'./allocations.js'",JSON.stringify(allocationsURL));
export const promptMemoryURL=data(promptCode);
