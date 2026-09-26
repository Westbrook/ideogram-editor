import { parentPort, workerData } from 'node:worker_threads';
import { runRaster } from './engine.js';
if(!parentPort)throw new Error('Raster requires a worker');
const port=parentPort;let admitted=false;
const check=()=>{if(process.memoryUsage().rss>512*1024*1024)throw new Error('RASTER_RESOURCES');};
const timer=setInterval(()=>{try{check();}catch{port.postMessage({type:'failure',code:'RASTER_RESOURCES'});process.exit(1);}},10);timer.unref();
try{
  const result=await runRaster(workerData,plan=>new Promise<void>((resolve,reject)=>{port.once('message',message=>{if(message.type==='admit'){admitted=true;resolve();}else reject(new Error('RASTER_RESOURCES'));});port.postMessage({type:'plan',plan});}),check);
  if(!admitted)throw new Error('RASTER_RESOURCES');port.postMessage({type:'result',result});
}catch(error){const message=error instanceof Error?error.message:'';port.postMessage({type:'failure',code:/^RASTER_[A-Z_]+$/.test(message)?message:'RASTER_DECODE'});}
finally{clearInterval(timer);port.close();}
