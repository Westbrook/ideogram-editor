import assert from 'node:assert/strict';
// Shared public caller flow. Failure cleanup forwards the same captured Route
// once, while preserving an explicitly unsuccessful normal release contract.
export function restoredRouteFlow({page,pattern,observer,onHold}){
 let releaseGate;const gate=new Promise(resolve=>releaseGate=resolve),entries=[];let installed=false,removed=false,cleanupError,released=false,confirmationStarted=false;
 async function remove(cleanup=false){if(!installed||removed)return;removed=true;const failures=[];
  try{if(cleanup)observer?.cleanupRemoving();else observer?.removing();}catch(error){failures.push(error);}
  try{await page.unroute(pattern);if(cleanup)observer?.cleanupRemoved();else observer?.removed();}catch(error){failures.push(error);observer?.removalFailed(error);}
  if(failures.length)throw new AggregateError(failures,'Original route removal and receipt failures');
 }

 return {
  async install(){try{await page.route(pattern,route=>{
   const originalContinue=route.continue,entry={route,receipt:undefined,receiptError:undefined,work:undefined};entries.push(entry);
   try{entry.receipt=observer?.hold(route);}catch(error){entry.receiptError=error;}
   try{onHold(route.request());}catch(error){entry.receiptError=entry.receiptError?new AggregateError([entry.receiptError,error],'Hold observation failures'):error;}
   entry.work=(async()=>{await gate;if(entry.receiptError){try{await Reflect.apply(originalContinue,route,[]);}catch(error){throw new AggregateError([entry.receiptError,error],'Receipt and original forwarding failures');}throw entry.receiptError;}if(entry.receipt){if(cleanupError)return entry.receipt.cleanupContinue(cleanupError);return entry.receipt.continue();}return Reflect.apply(originalContinue,route,[]);})();
   // Observe rejection immediately; retain and rethrow it through the awaited
   // normal/cleanup path instead of an unhandled detached promise.
   entry.work.catch(()=>{});return entry.work;
  });installed=true;observer?.registered();}catch(error){observer?.registrationFailed(error);throw error;}},
  async release(){for(const entry of entries)entry.receipt?.release();releaseGate();await Promise.all(entries.map(e=>e.work));await remove();released=true;},
  async confirmRestored(confirm){assert(installed&&removed&&released&&!cleanupError,'Successful shared release before restoration confirmation');assert(!confirmationStarted,'One shared restoration confirmation');confirmationStarted=true;await confirm();return observer?.confirmedRestoration();},
  async cleanup(primary){const failures=primary?[primary]:[];if(primary)cleanupError=primary;releaseGate();const settled=await Promise.allSettled(entries.map(e=>e.work));for(const result of settled)if(result.status==='rejected'&&!failures.includes(result.reason))failures.push(result.reason);
   try{await remove(!!primary);}catch(error){failures.push(error);}
   return failures.length===0?undefined:failures.length===1?failures[0]:new AggregateError(failures,'Workflow, original forwarding and route removal failures');
  },
 };
}
