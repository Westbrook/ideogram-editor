import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const names=['submit','upload','poll','cancel','fetch','socket','dns','datagram'];
const guardURL=new URL('../../tests/store/no-network.mjs',import.meta.url),guardPath=fileURLToPath(guardURL);
const identity=async url=>{const bytes=await readFile(url);return{bytes:bytes.length,hash:'sha256:'+createHash('sha256').update(bytes).digest('hex')};};
function importedGuard(){return process.execArgv.some((arg,index)=>{const value=arg==='--import'?process.execArgv[index+1]:arg.startsWith('--import=')?arg.slice(9):null;if(!value)return false;try{return(value.startsWith('file:')?fileURLToPath(value):resolve(value))===guardPath;}catch{return false;}});}
export function sharedDiagnosticCounters(){const guard=globalThis.__storeNetworkCounters;assert(guard&&guard.shared instanceof SharedArrayBuffer&&typeof guard.read==='function','Diagnostic requires the explicit no-network preload');return guard.shared;}
async function capture(){
 const guard=globalThis.__storeNetworkCounters;let counters=null;
 try{if(guard&&guard.shared instanceof SharedArrayBuffer&&typeof guard.read==='function')counters=guard.read();}catch{}
 const shape=counters&&Object.keys(counters).sort().join(',')===[...names].sort().join(',')&&Object.values(counters).every(n=>Number.isSafeInteger(n)&&n>=0);
 return{status:shape&&Object.values(counters).every(n=>n===0)&&importedGuard()?'passed':'failed',guardSource:await identity(guardURL),helperSource:await identity(new URL(import.meta.url)),execArgv:process.execArgv,explicitGuardImport:importedGuard(),counters,
  scope:'Shared counters cover this driver and the storage worker via its existing test hook. Raster workers inherit the denying preload but have separate counters, which are not aggregated here. This JavaScript API guard is not an OS network sandbox.'};
}
export async function beginDiagnosticNetwork(){sharedDiagnosticCounters();const snapshot=await capture();assert.equal(snapshot.status,'passed','Missing guard or prior network attempt');return snapshot;}
export async function finishDiagnosticNetwork(before){try{const after=await capture();after.identityUnchanged=Boolean(before)&&JSON.stringify({guardSource:after.guardSource,helperSource:after.helperSource,execArgv:after.execArgv})===JSON.stringify({guardSource:before.guardSource,helperSource:before.helperSource,execArgv:before.execArgv});if(!after.identityUnchanged)after.status='failed';return after;}catch(error){return{status:'failed',error:String(error),scope:'Guard finalization failed; no zero-effect claim.'};}}
