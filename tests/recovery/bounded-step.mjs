export async function boundedStep(state,phase,ms,work){
 let timer;const row={phase,start:Date.now(),limitMs:ms};(state.timingCleanup??=[]).push(row);
 try{await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(phase+' deadline')),ms);})]);row.passed=true;return true;}
 catch(error){row.error=String(error);state.failures.push({phase,error});return false;}
 finally{clearTimeout(timer);row.end=Date.now();}
}
