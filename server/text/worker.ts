import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { inspectFont } from './font.js';
import { hashBytes } from '../storage/canonical.js';
try{
 const b=readFileSync(workerData.path);if(b.length!==workerData.length||hashBytes(b)!==workerData.hash)throw Error('FONT_HASH_MISMATCH');
 const result=inspectFont(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));parentPort!.postMessage({ok:true,result});
}catch(e){parentPort!.postMessage({ok:false,code:e instanceof Error?e.message:'FONT_INVALID'});}
