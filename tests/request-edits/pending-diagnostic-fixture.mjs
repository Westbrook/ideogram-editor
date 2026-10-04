// Opt-in failure observation around the unchanged E3 provider fixture.
import {captureOwnedDiagnostics} from '../history/returned-description-observer-fixture.mjs';
import {pendingDiagnosticObserver} from './pending-diagnostics.mjs';
const original=new URL('./observer-fixture.mjs',import.meta.url);
original.search=new URL(import.meta.url).search;
const {setup:baseSetup}=await import(original.href);
export async function setup(store){
 const close=await baseSetup(store),observe=pendingDiagnosticObserver(store,captureOwnedDiagnostics);
 const timer=setInterval(()=>{try{observe();}catch{/* A refused snapshot remains unavailable; it cannot replace the original failure. */}},25);
 return Object.assign(async()=>{clearInterval(timer);await close();},{afterStoreDrain:()=>close.afterStoreDrain()});
}
