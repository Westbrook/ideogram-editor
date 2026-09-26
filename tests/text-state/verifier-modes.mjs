import {parentPort,workerData} from 'node:worker_threads';
if(workerData.mode==='crash')throw Error('Owned deliberate worker crash');
if(workerData.mode==='hang')setInterval(()=>{},1000);
parentPort.postMessage({type:'ready'});
parentPort.once('message',()=>{if(workerData.mode==='valid'){parentPort.postMessage({type:'result',verified:true});parentPort.close();}else if(workerData.mode==='false-result'){parentPort.postMessage({type:'result',verified:false});parentPort.close();}});
