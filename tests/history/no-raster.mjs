import workerThreads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
const Worker=workerThreads.Worker;
workerThreads.Worker=class extends Worker {
 constructor(url,options){if(String(url).endsWith('/raster/worker.js'))throw new Error('Historical navigation must not dispatch raster work');super(url,options);}
};
syncBuiltinESMExports();
