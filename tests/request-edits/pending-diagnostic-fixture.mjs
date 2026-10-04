// Opt-in failure observation around the unchanged E3 provider fixture.
import {captureOwnedDiagnostics} from '../history/returned-description-observer-fixture.mjs';
import {pendingDiagnosticObserver} from './pending-diagnostics.mjs';
import {installPendingOperationObserver} from './pending-operation-observer.mjs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const original=new URL('./observer-fixture.mjs',import.meta.url);
original.search=new URL(import.meta.url).search;
const {setup:baseSetup}=await import(original.href);
export async function setup(store){
 const close=await baseSetup(store),observer=installPendingOperationObserver(store,{enabled:true});
 const disposalPath=join(store.root,'e3-operation-observer-close.json');
 let observe=pendingDiagnosticObserver(store,captureOwnedDiagnostics,observer);
 const timer=setInterval(()=>{try{observe?.();}catch{/* A refused snapshot remains unavailable; it cannot replace the original failure. */}},25);
 return Object.assign(async()=>{
  clearInterval(timer);observe=undefined;
  const disposed=observer.dispose();
  try{const bytes=Buffer.from(JSON.stringify(disposed));if(bytes.length<=4096)writeFileSync(disposalPath,bytes,{mode:0o600,flag:'wx'});}catch{/* Missing diagnostic retention is unavailable; original shutdown still runs. */}
  await close();
 },{afterStoreDrain:()=>close.afterStoreDrain()});
}
