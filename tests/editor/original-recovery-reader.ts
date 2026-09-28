import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {BrowserContext,Frame,Request} from '@playwright/test';
// These are the same compiled canonical/schema validators used by the consumer.
import {canonical,parseControlJSON} from '../../dist/local/src/protocol/json.js';
import {entity,event as validateEvent} from '../../dist/local/src/protocol/validate.js';
// @ts-ignore Test-only original SSE framing and publication assessment.
import {OriginalSSEFrames} from './completion/sse-frames.mjs';
// @ts-ignore Kept distinct from ordinary HTTP recovery completion.
import {sseDescriptor,ssePublication} from './completion/sse-publication.mjs';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const eligible=(url:string)=>/^\/api\/v1\/(events(?:\/stream)?|snapshots\/[^/]+|namespace-events\/[^/]+|protocol-content\/[^/]+|commands\/[^/]+\/result)$/.test(new URL(url).pathname);

// Passive observation of ORIGINAL promises and the application's own committed
// IndexedDB writes. No response clones, replacement readers or observer writes.
export async function originalRecoveryReader(context:BrowserContext,out:string,requestID:(r:Request)=>number,cachePrefix='ie-projection-'){
 const events:any[]=[],requests:any[]=[],responses=new Map<Request,any>(),frames=new Map<Frame,number>(),bodies=new Map<string,Buffer[]>(),errors:string[]=[],streams=new Map<string,any>();
 const frameID=(f:Frame)=>{if(!frames.has(f))frames.set(f,frames.size+1);return frames.get(f)!;};
 const key=(e:any)=>[e.frameId,e.document,e.operation].join(':');
 await context.exposeBinding('p1c6RecoveryRead',({frame},event:any)=>{
  const {chunk,...value}=event,e={...value,frameId:frameID(frame),observedAt:Date.now(),order:events.length+1};events.push(e);
  if(e.url&&new URL(e.url).pathname==='/api/v1/events/stream'){
   const k=key(e);if(e.kind==='reader'&&!streams.has(k))streams.set(k,new OriginalSSEFrames());const stream=streams.get(k);
   if(chunk!==undefined){if(!stream){errors.push('SSE chunk without original reader');return;}stream.push(e,Buffer.from(chunk,'base64'));}
   if(e.kind==='observation-limit'&&stream)stream.failures.push('Original SSE observation limit reached');
   if(e.kind==='eof'){if(!stream)errors.push('SSE EOF without original reader');else stream.finish(e);}
  }else if(chunk!==undefined){const k=key(e),parts=bodies.get(k)??[];parts.push(Buffer.from(chunk,'base64'));bodies.set(k,parts);}
 });
 context.on('request',request=>{if(eligible(request.url()))requests.push({request,frameId:frameID(request.frame()),observedAt:Date.now()});});
 context.on('response',response=>{const request=response.request();if(eligible(request.url()))responses.set(request,{response,finished:response.finished().then(value=>({state:'resolved',value}),error=>({state:'unavailable',error:String(error)}))});});
 await context.addInitScript(({cachePrefix})=>{
  if(!/^https?:$/.test(location.protocol))return;
  const document=crypto.randomUUID(),pending:Promise<unknown>[]=[],errors:string[]=[];let operation=0,transactionId=0;const now=()=>performance.timeOrigin+performance.now();
  const send=(event:any)=>{const p=(window as any).p1c6RecoveryRead({document,...event});pending.push(p);p.catch((e:any)=>errors.push(String(e)));};
  (window as any).__p1c6RecoveryObserver={async flush(){let n=-1;while(n!==pending.length){n=pending.length;await Promise.all(pending);}if(errors.length)throw Error(errors.join('; '));}};
  const nativePut=IDBObjectStore.prototype.put,transactions=new WeakMap<IDBTransaction,any[]>();
  IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){
   const request=Reflect.apply(nativePut,this,Array.from(arguments));
   if(this.transaction.db.name.startsWith(cachePrefix)&&((this.name==='meta'&&key==='published')||(this.name==='rows'&&Array.isArray(key)&&['document','namespace','event'].includes(String(key[1]))))){
    const transaction=this.transaction,records=transactions.get(transaction)??[];records.push({store:this.name,key:structuredClone(key),value:structuredClone(value),at:now()});
    if(!transactions.has(transaction)){transactions.set(transaction,records);const db=transaction.db.name,id=++transactionId;transaction.addEventListener('complete',()=>send({kind:'publication-writes',db,transaction:id,at:now(),records}));transaction.addEventListener('abort',()=>send({kind:'publication-aborted',db,transaction:id,at:now(),records}));}
   }
   return request;
  };
  const nativeFetch=window.fetch;
  window.fetch=function(...args:Parameters<typeof fetch>){
   const input=args[0],url=new URL(input instanceof Request?input.url:String(input),location.href),method=args[1]?.method??(input instanceof Request?input.method:'GET');
   if(url.origin!==location.origin||method!=='GET'||!/^\/api\/v1\/(events(?:\/stream)?|snapshots\/[^/]+|namespace-events\/[^/]+|protocol-content\/[^/]+|commands\/[^/]+\/result)$/.test(url.pathname))return Reflect.apply(nativeFetch,this,args);
   const owners=Object.keys(sessionStorage).filter(k=>k.startsWith('ie-ui-session:')).map(k=>({clientId:k.slice('ie-ui-session:'.length),sessionId:sessionStorage.getItem(k)}));
   const base={operation:++operation,start:now(),url:url.href,method,timeOrigin:performance.timeOrigin,owners},signal=args[1]?.signal??(input instanceof Request?input.signal:null);send({...base,kind:'start',hasSignal:!!signal});
   if(signal){const aborted=()=>send({...base,kind:'signal-abort',at:now(),aborted:signal.aborted,reasonName:signal.reason?.name});if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});}
   const promise=Reflect.apply(nativeFetch,this,args);
   promise.then(response=>{
    const identity={...base,responseAt:now(),status:response.status,responseURL:response.url,redirected:response.redirected,headers:{type:response.headers.get('content-type'),length:response.headers.get('content-length'),etag:response.headers.get('etag')}};send({...identity,kind:'response'});
    const json=response.json;response.json=function(){const p=Reflect.apply(json,this,[]);p.then(value=>send({...identity,kind:'json',end:now(),value:structuredClone(value)}),e=>send({...identity,kind:'json-error',at:now(),error:String(e)}));return p;};
    const body=response.body;if(!body)return;
    const get=body.getReader,tee=body.tee,clone=response.clone;let readers=0;body.tee=function(){send({...identity,kind:'tee'});return Reflect.apply(tee,this,[]);};response.clone=function(){send({...identity,kind:'clone'});return Reflect.apply(clone,this,[]);};
    body.getReader=function(this:ReadableStream<Uint8Array>,...args:any[]){const reader=Reflect.apply(get,this,args),read=reader.read,cancel=reader.cancel;let count=0,reads=0,eof=false,overflow=false;const readerNumber=++readers;send({...identity,kind:'reader',readerNumber});
     reader.read=function(...args:any[]){const p=Reflect.apply(read,this,args) as Promise<ReadableStreamReadResult<Uint8Array>>;p.then((r:ReadableStreamReadResult<Uint8Array>)=>{reads++;if(r.done){eof=true;send({...identity,kind:'eof',end:now(),count,reads,readers,readerNumber,overflow});}else{count+=r.value.byteLength;if(count>64*1024*1024){overflow=true;send({...identity,kind:'observation-limit',count});return;}let binary='';for(let at=0;at<r.value.length;at+=16384)binary+=String.fromCharCode(...r.value.subarray(at,at+16384));send({...identity,kind:'chunk',at:now(),count,reads,readerNumber,chunk:btoa(binary)});}},e=>send({...identity,kind:'read-error',at:now(),error:String(e)}));return p;};
     reader.cancel=function(...args:any[]){send({...identity,kind:'cancel',at:now(),afterEOF:eof});return Reflect.apply(cancel,this,args);};return reader;
    } as typeof body.getReader;
   },e=>send({...base,kind:'fetch-error',hasSignal:!!signal,at:now(),name:e?.name,error:String(e)}));return promise;
  };
 },{cachePrefix});
 async function association(e:any){
  const requestTime=(x:any)=>x.request.timing().startTime>0?x.request.timing().startTime:e.kind==='fetch-error'&&new URL(e.url).pathname==='/api/v1/events/stream'&&!responses.has(x.request)?x.observedAt:0;
  const candidates=requests.filter(x=>x.frameId===e.frameId&&x.request.url()===e.url&&x.request.method()==='GET'&&requestTime(x)>=e.start-2&&requestTime(x)<=(e.responseAt??e.at)+2);
  const own=events.filter(x=>key(x)===key(e)),overlap=events.filter(x=>x.kind==='start'&&x.frameId===e.frameId&&x.document===e.document&&x.url===e.url&&x.operation!==e.operation&&x.start<=(e.end??e.at)&&((events.find(y=>key(y)===key(x)&&['eof','fetch-error',...(e.kind==='sse-frame'?['read-error','cancel']:[])].includes(y.kind))?.end)??(e.kind==='sse-frame'?events.find(y=>key(y)===key(x)&&['read-error','cancel'].includes(y.kind))?.at:undefined)??Infinity)>=e.start);
  const p:any={...e,eligibleRequests:candidates.map(x=>requestID(x.request)),concurrentOperations:overlap.map(x=>x.operation),association:'unproved',cloned:own.some(x=>x.kind==='clone'),teed:own.some(x=>x.kind==='tee'),earlyCancel:own.some(x=>x.kind==='cancel'&&!x.afterEOF),readError:own.some(x=>x.kind==='read-error'),readerCount:own.filter(x=>x.kind==='reader').length};
  if(candidates.length!==1||overlap.length)return p;const q=candidates[0].request,entry=responses.get(q),r=entry?.response;p.requestId=requestID(q);p.requestFrame=candidates[0].frameId;p.requestStart=requestTime(candidates[0]);p.requestStartMethod=q.timing().startTime>0?'browser timing':'same Request event receipt time; browser startTime unavailable before headers';p.redirectedFrom=q.redirectedFrom()?.url()??null;p.protocolFailure=q.failure();p.association='unique-frame-time-window';
  if(r&&r.request()===q){let timer:any;p.protocolFinished=await Promise.race([entry.finished,new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'unresolved',windowMs:250}),250);})]);clearTimeout(timer);Object.assign(p,{responseStatus:r.status(),browserResponseURL:r.url(),cacheControl:r.headers()['cache-control']??null,fromServiceWorker:r.fromServiceWorker()});}return p;
 }
 return {events,async flush(){for(const p of context.pages())await p.evaluate(async()=>{await (window as any).__p1c6RecoveryObserver?.flush();});},async seal(commandResult?:(id:string)=>any){
  const controls:any[]=[],proofs:any[]=[],sse:any[]=[];
  for(const e of events.filter(e=>(e.kind==='json'||e.kind==='eof'&&!new URL(e.url).pathname.startsWith('/api/v1/protocol-content/'))&&new URL(e.url).pathname!=='/api/v1/events/stream')){try{const bytes=e.kind==='eof'?Buffer.concat(bodies.get(key(e))??[]):null,value=e.kind==='json'?e.value:parseControlJSON(bytes!);controls.push({...e,value});}catch(error){errors.push('Control observation '+key(e)+': '+String(error));}}
  const descriptors:any[]=[];
  function visit(value:any,control:any,recovery:any=undefined){if(!value||typeof value!=='object')return;const scope=value.recovery??recovery;if(value.content?.blob?.mediaType==='application/x-ndjson')descriptors.push({control,owner:value,recovery:scope,content:value.content});for(const [k,v] of Object.entries(value))if(k!=='content'&&k!=='recovery')if(Array.isArray(v))v.forEach(x=>visit(x,control,scope));else if(v&&typeof v==='object')visit(v,control,scope);}
  for(const control of controls)visit(control.value,control);
  const sseFrames=[...streams.values()].flatMap(s=>s.frames.map((f:any)=>({...f,parserFailures:[...s.failures]})));
  for(const control of sseFrames)if(control.value.kind==='transaction-ref')visit(control.value.reference,control);
  for(const e of events.filter(e=>e.kind==='eof'&&new URL(e.url).pathname.startsWith('/api/v1/protocol-content/'))){
   const p=await association(e),bytes=Buffer.concat(bodies.get(key(e))??[]),path=join(out,'recovery-'+e.frameId+'-'+e.document+'-'+e.operation+'.bin');await writeFile(path,bytes);Object.assign(p,{path,bytes:bytes.length,sha256:sha(bytes),normalEOF:true,validated:false,publication:null});
   const matching=descriptors.filter(d=>d.control.frameId===e.frameId&&d.control.document===e.document&&d.control.end<=e.start+2&&new URL(d.content.url,e.url).href===e.url&&d.recovery?.recoveryId===new URL(e.url).searchParams.get('recoveryId'));
   p.descriptorCandidates=matching.length;
   if(matching.length===1){const d=matching[0],controlProof=await association(d.control),isSSE=d.control.kind==='sse-frame';p.descriptor={requestOperation:d.control.operation,at:d.control.end,frameId:d.control.frameId,document:d.control.document,controlProof,owners:d.control.owners,owner:d.owner,recovery:d.recovery,content:d.content,...isSSE?{source:'original-sse-frame',frameOrdinal:d.control.frameOrdinal,byteStart:d.control.byteStart,byteEnd:d.control.byteEnd,deliveredByRead:d.control.deliveredByRead,deliveredCount:d.control.deliveredCount,offeredId:d.control.offeredId,parserFailures:d.control.parserFailures}: {}};
    try{
     if(isSSE){sseDescriptor(d,controlProof);if(p.association!=='unique-frame-time-window'||p.readerCount!==1||p.readerNumber!==1||p.overflow||p.cloned||p.teed||p.earlyCancel||p.readError)throw Error('Original SSE content reader is unproved');}else if(controlProof.association!=='unique-frame-time-window'||controlProof.responseStatus!==200||controlProof.redirectedFrom!==null||controlProof.redirected||controlProof.fromServiceWorker||controlProof.cloned||controlProof.teed||controlProof.earlyCancel||controlProof.readError)throw Error('Descriptor request is unproved');
     if(bytes.length!==e.count||String(bytes.length)!==d.content.blob.byteLength||'sha256:'+sha(bytes)!==d.content.blob.hash||!bytes.length||bytes.at(-1)!==10)throw Error('Body identity or terminal newline mismatch');
     const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n');lines.pop();if(String(lines.length)!==d.content.recordCount)throw Error('Record count mismatch');
     const values=lines.map(line=>{if(Buffer.byteLength(line)>16384)throw Error('Oversize record');const value=parseControlJSON(Buffer.from(line));if(canonical(value)!==line)throw Error('Noncanonical record');return value;});p.records=values.length;
     const documents:any[]=[],namespaces:any[]=[];let targetCursor:string;const commandId=/\/api\/v1\/commands\/([^/]+)\/result$/.exec(new URL(d.control.url).pathname)?.[1];p.validationKind=commandId?'command-result':'recovery-publication';p.commandId=commandId??null;
     if(d.content.encoding==='lp1-events-jsonl'){if(values.length!==Number(d.owner.eventCount)||values[0]?.workspaceSeq!==d.owner.fromSeq||values.at(-1)?.workspaceSeq!==d.owner.toSeq)throw Error('Transaction count or sequence mismatch');let sequence=BigInt(d.owner.fromSeq);const firstCommand=values[0]?.commandId;for(const v of values){if(v.transactionId!==d.owner.transactionId||v.commandId!==firstCommand||BigInt(v.workspaceSeq)!==sequence++)throw Error('Transaction identity mismatch');}if(commandId){const accepted=commandResult?.(commandId);p.acceptedCommand=accepted?{...accepted,eventsBodySHA256:sha(Buffer.from(accepted.events.map(canonical).join('\n')+'\n'))}:null;if(!accepted||accepted.receipt.status!=='accepted'||accepted.receipt.commandId!==commandId||canonical(accepted.events)!==canonical(values)||!e.owners.some((o:any)=>o.clientId===accepted.clientId&&o.sessionId===accepted.sessionId))throw Error('Accepted command context or exact events unavailable');}for(const v of values){validateEvent(v);if(v.payload?.document)documents.push(v.payload.document);if(v.type==='BundleImported')namespaces.push({id:v.payload.namespaceId,eventId:v.eventId,namespaceHash:v.payload.namespaceHash});}targetCursor=values.at(-1).workspaceSeq;}
     else{const header=values.shift();if(header.kind!=='header'||header.projectionSchema!==d.recovery.projectionSchema)throw Error('Header context mismatch');targetCursor=header.snapshotSeq??header.workspaceSeq;
      if(d.content.encoding==='lp1-namespace-jsonl'){if(header.namespaceId!==d.owner.namespaceId||header.namespaceHash!==d.owner.namespaceHash||header.eventId!==d.owner.eventId||header.workspaceSeq!==d.owner.workspaceSeq)throw Error('Namespace context mismatch');namespaces.push({id:header.namespaceId,eventId:header.eventId,namespaceHash:header.namespaceHash});}
      else if(d.content.encoding!=='lp1-snapshot-jsonl'||header.snapshotId!==d.owner.snapshotId||header.snapshotSeq!==d.owner.snapshotSeq)throw Error('Snapshot context mismatch');
      let parts:any[]=[],count=0,previous='';for(const row of values){if(row.kind!=='projection-part'||row.partIndex!==parts.length||!Number.isInteger(row.partCount)||row.partCount<1)throw Error('Part framing mismatch');const first=parts[0]??row;if(row.entityType!==first.entityType||row.entityId!==first.entityId||row.entityVersion!==first.entityVersion||row.partCount!==first.partCount)throw Error('Part identity mismatch');parts.push(row);if(parts.length===row.partCount){const key=row.entityType+':'+row.entityId;if(key<=previous)throw Error('Row ordering');previous=key;const source=Buffer.concat(parts.map(r=>{const b=Buffer.from(r.utf8Base64,'base64');if(b.toString('base64')!==r.utf8Base64)throw Error('Base64 mismatch');return b;}));const v=parseControlJSON(source);if(canonical(v)!==source.toString('utf8')||v.id!==row.entityId||entity(row.entityType,v)!==row.entityVersion)throw Error('Entity mismatch');if(row.entityType==='document')documents.push(v);parts=[];count++;}}
      if(parts.length||String(count)!==header.entityCount)throw Error('Incomplete entities');
     }
     const committed=events.filter(x=>x.kind==='publication-writes'&&x.frameId===e.frameId&&x.document===e.document),publications=committed.flatMap(x=>x.records.filter((r:any)=>r.store==='meta'&&r.key==='published').map((r:any)=>({...r,db:x.db,completedAt:x.at})));
     if(isSSE){for(const control of controls.filter(c=>c.frameId===e.frameId&&c.document===e.document&&new URL(c.url).pathname==='/api/v1/events'&&new URL(c.url).searchParams.get('recoveryId')===d.recovery.recoveryId))control.originalProof=await association(control);Object.assign(p,ssePublication({e,d,values,controls,committed,aborted:events.filter(x=>x.kind==='publication-aborted'),events,cachePrefix}),{documents:documents.map(v=>({id:v.id,revision:v.revision})),namespaces});proofs.push(p);continue;}
     const ownerMatches=(r:any)=>e.owners?.some((o:any)=>r.db===cachePrefix+o.clientId&&d.control.owners?.some((x:any)=>x.clientId===o.clientId&&x.sessionId===o.sessionId));
     const nextRoot=events.filter(x=>x.kind==='start'&&x.frameId===e.frameId&&x.document===e.document&&x.start>e.end&&new URL(x.url).pathname==='/api/v1/events'&&!new URL(x.url).searchParams.has('recoveryId')).reduce((n,x)=>Math.min(n,x.start),Infinity);
     const finals=controls.filter(c=>c.frameId===e.frameId&&c.document===e.document&&c.end>=e.end&&new URL(c.url).pathname==='/api/v1/events'&&new URL(c.url).searchParams.get('recoveryId')===d.recovery.recoveryId&&c.value.kind==='batches'&&c.value.recovery?.writerEpoch===d.recovery.writerEpoch&&c.value.recovery?.highWater===d.recovery.highWater&&c.value.more===false&&c.value.batches?.length===0&&BigInt(c.value.nextCursor)>=BigInt(targetCursor));
     const finalCheck=finals[0];p.finalCheck=finalCheck?{url:finalCheck.url,at:finalCheck.end,value:finalCheck.value,proof:await association(finalCheck)}:null;p.nextRecoveryStart=Number.isFinite(nextRoot)?nextRoot:null;
     const publication=publications.find((r:any)=>ownerMatches(r)&&r.completedAt<nextRoot&&(commandId||p.finalCheck?.proof.association==='unique-frame-time-window'&&p.finalCheck.proof.responseStatus===200&&p.finalCheck.at<=r.completedAt)&&r.completedAt>=e.end&&r.value.epoch===d.recovery.writerEpoch&&BigInt(r.value.cursor)>=BigInt(targetCursor)&&BigInt(r.value.cursor)<=BigInt(d.recovery.highWater)&&documents.every(v=>committed.some(x=>x.db===r.db&&x.at<=r.completedAt&&x.records.some((w:any)=>w.store==='rows'&&w.key[0]===r.value.generation&&w.key[1]==='document'&&w.key[2]===v.id&&canonical(w.value)===canonical(v))))&&namespaces.every(v=>committed.some(x=>x.db===r.db&&x.at<=r.completedAt&&x.records.some((w:any)=>w.store==='rows'&&w.key[0]===r.value.generation&&w.key[1]==='namespace'&&w.key[2]===v.id&&w.value.eventId===v.eventId&&w.value.namespaceHash===v.namespaceHash))));
     p.documents=documents.map(v=>({id:v.id,revision:v.revision}));p.namespaces=namespaces;p.targetCursor=targetCursor;p.publication=publication??null;const owner=e.owners?.find((o:any)=>publication?.db===cachePrefix+o.clientId);p.clientId=owner?.clientId;p.sessionId=owner?.sessionId;p.validated=!!publication&&!!owner&&d.control.owners?.some((o:any)=>o.clientId===owner.clientId&&o.sessionId===owner.sessionId);
    }catch(error){p.validationError=String(error);}
   }proofs.push(p);
  }
  for(const e of events.filter(e=>e.kind==='fetch-error'&&new URL(e.url).pathname==='/api/v1/events/stream')){const p=await association({...e,end:e.at}),abort=events.find(x=>key(x)===key(e)&&x.kind==='signal-abort');p.signalAbort=abort??null;sse.push(p);}
  await writeFile(join(out,'original-recovery-reads.json'),JSON.stringify({events,sseFrames,descriptors,proofs,sse,errors},null,2));return {proofs,sse,errors};
 }};
}
