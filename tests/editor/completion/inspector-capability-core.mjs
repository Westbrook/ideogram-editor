import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const PAYLOAD=Buffer.from(Array.from({length:65536},(_,i)=>(i*31+17)%256));
export const CASES=Object.freeze([{id:'complete',sent:65536,advertised:65536},{id:'short',sent:16384,advertised:65536},{id:'abort',sent:4096,advertised:65536}].map(Object.freeze));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const INPUTS=['inspector-capability-core.mjs','inspector-capability-router.mjs','inspector-capability-fixture.mjs','inspector-capability-controls.mjs','inspector-capability-series.mjs','completion-contrast-flow.mjs','completion-contrast-flow-controls.mjs','completion-contrast-core.mjs','completion-contrast-fixture.mjs','completion-contrast-series.mjs','exclusive-controller-flow.mjs'];
export const LIMITS=Object.freeze({binaryPerCase:65536,binaryTotal:196608,rawBytesPerWorker:1048576,messagesPerWorker:256,commandMs:6000,operationMs:20000,terminalMs:6000,holdMs:8000});
export function matchOwnedWorker(info,c,parent){assert(c,'No target outside declared case');assert.equal(info.type,'worker');assert.equal(info.url,c.workerURL);assert.equal(info.parentId,parent.targetId,'Actual owning parent target');assert.equal(info.browserContextId,parent.contextId);return c;}
export function binary(value){assert.equal(typeof value,'string');assert(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'Canonical base64');const bytes=Buffer.from(value,'base64');assert.equal(bytes.toString('base64'),value);return bytes;}
export class InspectorAssembly {
  constructor(identity,c){this.identity=Object.freeze({...identity});this.case=c;this.row={identity:this.identity,caseId:c.id,data:[],errors:[]};this.seen=new Set();}
  check(identity){assert.deepEqual(identity,this.identity,'Exact target/session/context/request identity');}
  arm(identity,order){this.check(identity);assert.equal(this.row.armOrder,undefined);this.row.armOrder=order;}
  response(identity,result,order){this.check(identity);assert(this.row.armOrder<order);assert.equal(this.row.reply,undefined);const bytes=binary(result.bufferedData);assert(bytes.length<=LIMITS.binaryPerCase);this.row.reply={order,bufferedData:result.bufferedData,bytes:bytes.length};this.checkBound();}
  data(identity,params,order){this.check(identity);assert(this.row.armOrder<order,'No data before original arm');assert.equal(params.requestId,this.identity.requestId);assert.equal(this.row.terminal,undefined,'No data after terminal');assert(Number.isInteger(params.dataLength)&&params.dataLength>=0);const key=JSON.stringify(params);assert(!this.seen.has(key),'Duplicate data event');this.seen.add(key);
    const bytes=params.data===undefined?null:binary(params.data);if(bytes)assert.equal(bytes.length,params.dataLength);this.row.data.push({order,params,bytes:bytes?.length??null});this.checkBound();}
  checkBound(){const size=(this.row.reply?.bytes??0)+this.row.data.reduce((n,e)=>n+(e.bytes??0),0);assert(size<=LIMITS.binaryPerCase,'Inspector binary retention bound');}
  terminal(identity,name,params,order){this.check(identity);assert.equal(params.requestId,this.identity.requestId);assert.equal(this.row.terminal,undefined);assert(['Network.loadingFinished','Network.loadingFailed'].includes(name));this.row.terminal={name,params,order};}
  destroy(order){this.row.destroyedAt=order;if(!this.row.reply||!this.row.terminal)this.row.prematureDestruction=true;}
  finish(){assert(this.row.reply,'Original command response required');assert(this.row.terminal,'Original network terminal required');assert(!this.row.prematureDestruction,'Target destroyed before required capture');
    const positive=this.row.data.filter(e=>e.params.dataLength>0);let streamed=false,unstreamed=0;
    for(const e of positive){if(e.params.data===undefined){assert(!streamed,'Unaccounted missing data after streaming began');assert(e.order<this.row.reply.order,'Missing data after stream command response');unstreamed+=e.params.dataLength;}else streamed=true;}
    assert.equal(this.row.reply.bytes,unstreamed,'Buffer covers exactly the pre-stream observed bytes');
    const output=Buffer.concat([binary(this.row.reply.bufferedData),...this.row.data.filter(e=>e.params.data!==undefined).map(e=>binary(e.params.data))]);
    assert.equal(output.length,this.row.data.reduce((n,e)=>n+e.params.dataLength,0),'No gap or double count');
    assert(output.equals(PAYLOAD.subarray(0,output.length)),'Exact declared binary prefix');
    if(this.case.id==='complete'){assert.equal(output.length,65536);}
    else{assert.equal(this.row.terminal.name,'Network.loadingFailed');assert(output.length>0&&output.length<=this.case.sent);if(this.case.id==='short'){assert.equal(output.length,16384);assert.equal(this.row.terminal.params.errorText,'net::ERR_CONTENT_LENGTH_MISMATCH');}else assert.equal(this.row.terminal.params.errorText,'net::ERR_ABORTED');}
    this.row.assembly={bytes:output.length,sha256:sha(output),scope:'Inspector received bytes only; not application-consumer proof',complete:this.case.id==='complete'};return output;
  }
}

export function workerSource(c,url){return `const config=${JSON.stringify({...c,url})};\n(${ordinaryWorker.toString()})(config);\n`;}
export async function ordinaryWorker(c){
  const result={caseId:c.id,url:c.url,bytes:0,reads:0,eof:false,abortCalls:0,events:[],clock:'worker performance.now, uncalibrated'};const note=(name,data={})=>result.events.push({name,at:performance.now(),...data});
  const controller=c.id==='abort'?new AbortController():null;let reader;
  try{note('fetch');const response=await fetch(c.url,controller?{signal:controller.signal}:{});result.status=response.status;note('response',{status:response.status});reader=response.body.getReader();
    while(true){result.reads++;note('read',{read:result.reads});const part=await reader.read();note('read-result',{done:part.done,bytes:part.value?.byteLength??0});if(part.done){result.eof=true;break;}result.bytes+=part.value.byteLength;if(controller&&result.abortCalls===0){result.abortCalls++;note('abort-before');controller.abort();note('abort-after');}}
  }catch(error){result.error={name:error.name,message:error.message};note('error',result.error);}finally{if(reader){reader.releaseLock();note('release');}}
  note('result');postMessage(result);
}
export function assessOrdinary(c,value){assert.equal(value.caseId,c.id);assert.equal(value.url,c.url);assert.equal(value.status,200);if(c.id==='complete'){assert.equal(value.bytes,65536);assert(value.eof);assert.equal(value.error,undefined);}else{assert(!value.eof);assert(value.bytes>0&&value.bytes<=c.sent);assert.equal(value.error?.name,c.id==='abort'?'AbortError':'TypeError');}assert.equal(value.abortCalls,c.id==='abort'?1:0);return true;}
