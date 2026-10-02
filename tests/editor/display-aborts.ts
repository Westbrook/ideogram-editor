import type {BrowserContext, Request, Page, Frame} from '@playwright/test';

type Observation={kind:string;document:string;operation:number;url:string;method:string;start:number;at:number;frameId:number;hasSignal?:boolean;aborted?:boolean;status?:number;responseURL?:string;redirected?:boolean;reader?:number;bytes?:number;errorName?:string};
type OriginalRequest={requestId:number;frameId:number;url:string;method:string;resourceType:string;startTime:number;redirected:boolean;response?:{url:string;status:number;fromServiceWorker:boolean}};
export const DISPLAY_OBSERVATION_LIMIT=20000,DISPLAY_REQUEST_LIMIT=5000;
export const displayReadPath=(url:string)=>/^\/api\/v1\/(?:events\/stream|assets\/[^/]+(?:\/display-tile)?|(?:documents|ui)\/[^/]+\/composition|documents\/[^/]+\/(?:image|history|checkpoints|save-status)|ui\/[^/]+|queue)$/.test(new URL(url).pathname);
// Observation breadth is not cancellation authority: that catalog remains above.
export const displayObservationPath=(url:string)=>/^\/api\/v1\//.test(new URL(url).pathname);
const operationKey=(e:Observation)=>[e.frameId,e.document,e.operation].join(':');

// Every accepted proof refers to one original browser Request in its actual
// frame. Timed proofs use observed native windows; the separate inferred full-
// bucket proof preserves unavailable timing. Equal URLs and FIFO are not proof.
export function displayReadProofs(events:readonly Observation[],requests:readonly OriginalRequest[],errors:readonly string[]=[]){
 if(errors.length||events.length>=DISPLAY_OBSERVATION_LIMIT||requests.length>=DISPLAY_REQUEST_LIMIT)return [];
 const groups=new Map<string,Observation[]>();for(const e of events){const k=operationKey(e),rows=groups.get(k)??[];rows.push(e);groups.set(k,rows);}
 const operations=[...groups.values()].map(rows=>{
  const starts=rows.filter(e=>e.kind==='start'),start=starts[0],terminal=rows.filter(e=>['complete','cancel','rejected','read-rejected'].includes(e.kind)).sort((a,b)=>a.at-b.at)[0];
  return {rows,start,valid:starts.length===1,end:terminal?.at??Infinity};
 });
 const candidates=operations.map(op=>{
  const s=op.start,response=op.rows.filter(e=>e.kind==='response'),rejection=op.rows.find(e=>e.kind==='rejected');
  const responseAt=response[0]?.at??rejection?.at;
  const requestsFor=op.valid&&s&&Number.isFinite(responseAt)?requests.filter(q=>q.frameId===s.frameId&&q.url===s.url&&q.method===s.method&&q.resourceType==='fetch'&&Number.isFinite(q.startTime)&&q.startTime>0&&q.startTime>=s.start-2&&q.startTime<=responseAt!+2):[];
  return {...op,response,requestsFor};
 });
 type Candidate=typeof candidates[number];
 const overlap=(op:Candidate)=>candidates.filter(other=>other!==op&&!!other.start&&!!op.start&&other.start.frameId===op.start.frameId&&other.start.document===op.start.document&&other.start.url===op.start.url&&other.start.method===op.start.method&&other.start.start<=op.end&&other.end>=op.start.start);
 // Row/terminal/native-response checks are shared by both association paths.
 const proofFor=(op:Candidate,q:OriginalRequest)=>{
  const s=op.start;if(!op.valid||!s||op.response.length>1)return null;
  if(!Number.isInteger(s.frameId)||s.frameId<=0||!/^[-a-f0-9]{36}$/.test(s.document)||!Number.isSafeInteger(s.operation)||s.operation<1||!Number.isFinite(s.start)||s.start<=0||s.at!==s.start||!['GET','POST','PUT'].includes(s.method)||!displayObservationPath(s.url))return null;
  if(op.rows.some(e=>e.document!==s.document||e.operation!==s.operation||e.frameId!==s.frameId||e.url!==s.url||e.method!==s.method||e.start!==s.start||!Number.isFinite(e.at)||e.at<s.start||['clone','tee','observer-error'].includes(e.kind)))return null;
  if(q.redirected)return null;
  const r=op.response[0];if(r&&(!q.response||q.response.url!==s.url||q.response.status!==r.status||q.response.fromServiceWorker||r.responseURL!==s.url||r.redirected!==false))return null;
  if(!r&&q.response)return null;
  const readers=op.rows.filter(e=>e.kind==='reader');if(readers.length>1||readers.some(e=>e.reader!==1))return null;
  const completed=op.rows.filter(e=>e.kind==='complete'),canceled=op.rows.filter(e=>e.kind==='cancel'),aborts=op.rows.filter(e=>e.kind==='abort'&&e.aborted===true);
  const readRejected=op.rows.filter(e=>e.kind==='read-rejected'),cancelRejected=op.rows.filter(e=>e.kind==='cancel-rejected'),readFailed=readRejected.length>0;
  const signalAborted=s.hasSignal===true&&aborts.length===1;
  // Native abort can error a reader before cancel returns that stored error.
  // Preserve only the independently observed readonly signal, never cancel/EOF.
  const abortedReader=s.method==='GET'&&r?.status===200&&displayReadPath(s.url)&&!op.rows.some(e=>e.kind==='rejected')&&signalAborted&&readers.length===1&&completed.length===0&&canceled.length===0&&readRejected.length===1&&cancelRejected.length===1&&[readRejected[0],cancelRejected[0]].every(e=>e.reader===1&&e.errorName==='AbortError'&&e.at>=aborts[0].at&&op.rows.indexOf(aborts[0])<op.rows.indexOf(e));
  if(cancelRejected.length&&!abortedReader)return null;
  if(completed.length>1||completed.some(e=>e.reader!==1||!Number.isSafeInteger(e.bytes)||e.bytes!<0)||op.rows.some(e=>e.kind==='read-rejected'&&e.errorName!=='AbortError'))return null;
  const bodyComplete=!!r&&readers.length===1&&completed.length===1&&!readFailed;
  const bodyCanceled=!!r&&canceled.some(e=>e.reader===0||e.reader===1&&readers.length===1);
  if(!signalAborted&&!bodyCanceled&&!bodyComplete)return null;
  return {requestId:q.requestId,url:s.url,method:s.method,signalAborted,bodyCanceled,bodyComplete,...bodyComplete?{bytes:completed[0].bytes}:{},...r?{status:r.status}:{},exactOccurrence:true as const,association:'unique-frame-time-window' as const,frameId:s.frameId,requestFrame:q.frameId,document:s.document,operation:s.operation,start:s.start,end:Number.isFinite(op.end)?op.end:null,requestStart:q.startTime,eligibleRequests:[q.requestId],concurrentOperations:[]};
 };
 // Buckets include every raw row group and native entry before validation.
 // A corrupt/startless group cannot be filtered away to manufacture uniqueness.
 const bucketKey=(frameId:number,url:string,method:string)=>JSON.stringify([frameId,url,method]);
 const buckets=new Map<string,{operations:Set<Candidate>;requests:OriginalRequest[]}>();
 const bucket=(key:string)=>{let value=buckets.get(key);if(!value){value={operations:new Set(),requests:[]};buckets.set(key,value);}return value;};
 for(const op of candidates)for(const e of op.rows)bucket(bucketKey(e.frameId,e.url,e.method)).operations.add(op);
 for(const q of requests)bucket(bucketKey(q.frameId,q.url,q.method)).requests.push(q);
 const fallback=new Set<string>();
 for(const op of candidates){
  if(!op.valid||!op.start){for(const e of op.rows)fallback.add(bucketKey(e.frameId,e.url,e.method));continue;}
  if(op.requestsFor.length!==1||overlap(op).length||candidates.some(other=>other!==op&&other.requestsFor.includes(op.requestsFor[0])))fallback.add(bucketKey(op.start.frameId,op.start.url,op.start.method));
 }
 // Native zero means unavailable timing, never a guessed timestamp. Force
 // the whole raw bucket through the separate inferred certificate path.
 for(const [key,raw]of buckets)if(raw.requests.some(q=>q.startTime===0))fallback.add(key);
 const resolveUntimedBucket=(ops:Candidate[],native:OriginalRequest[],key:string)=>{
  if(native.some(q=>q.method!=='GET'||q.resourceType!=='fetch'||!Number.isFinite(q.startTime)||q.startTime<0||q.redirected!==false||
   (q.startTime===0?q.response!==undefined&&q.response!==null:q.response!==undefined&&q.response!==null&&(!q.response||q.response.url!==q.url||q.response.fromServiceWorker!==false||!Number.isInteger(q.response.status)||q.response.status<100||q.response.status>599))))return [];
  const anchor=(op:Candidate)=>op.response[0]?.at??op.rows.find(e=>e.kind==='rejected')?.at;
  if(ops.some(op=>!op.valid||!op.start||op.rows.some(e=>bucketKey(e.frameId,e.url,e.method)!==key||!['start','response','reader','complete','cancel','abort','rejected','read-rejected','cancel-rejected','clone','tee','observer-error'].includes(e.kind))||!Number.isFinite(anchor(op))||anchor(op)!<op.start.start||!Number.isFinite(op.end)||op.end<anchor(op)!||op.response.length>1||op.rows.filter(e=>e.kind==='rejected').length>1||op.response.length&&op.rows.some(e=>e.kind==='rejected')))return [];
  const identity=(op:Candidate)=>({document:op.start!.document,operation:op.start!.operation});
  const concurrent=(op:Candidate)=>ops.filter(other=>other!==op&&other.start!.start<=op.end&&other.end>=op.start!.start).map(identity);
  const abortEvidence=(op:Candidate)=>{
   const [s,a,r]=op.rows;
   if(op.rows.length!==3||s.kind!=='start'||a.kind!=='abort'||r.kind!=='rejected'||s.method!=='GET'||s.hasSignal!==true||a.aborted!==true||r.errorName!=='AbortError'||s.start>a.at||a.at>r.at||op.rows.some(e=>e.reader!==undefined||e.bytes!==undefined||e.status!==undefined||e.responseURL!==undefined||e.redirected!==undefined))return null;
   return {hasSignal:true,aborted:true,kinds:['start','abort','rejected'],abortAt:a.at,rejectionAt:r.at,errorName:'AbortError'};
  };
  // Zero offers an edge to EVERY operation before any response or terminal
  // check. Those checks may refuse a forced assignment, never prune choices.
  const edges=new Map(ops.map(op=>[op,native.filter(q=>q.startTime===0||q.startTime>=op.start!.start-2&&q.startTime<=anchor(op)!+2)]));
  if([...edges.values()].some(list=>!list.length))return [];
  const remaining=new Set(ops),available=new Set(native),pairs:{document:string;operation:number;requestId:number}[]=[],assigned=new Map<Candidate,OriginalRequest>();
  while(remaining.size){
   const forced=[...remaining].find(op=>edges.get(op)!.filter(q=>available.has(q)).length===1);
   if(!forced)return [];
   const q=edges.get(forced)!.find(q=>available.has(q))!;
   assigned.set(forced,q);pairs.push({...identity(forced),requestId:q.requestId});remaining.delete(forced);available.delete(q);
   if([...remaining].some(op=>!edges.get(op)!.some(q=>available.has(q))))return [];
  }
  if(available.size)return [];
  const complete=ops.map(op=>{const q=assigned.get(op)!;return q.startTime===0&&!abortEvidence(op)?null:proofFor(op,q);});
  if(complete.some(p=>!p))return [];
  const s=ops[0].start!,bijection={version:2,frameId:s.frameId,url:s.url,method:s.method,
   operations:ops.map(op=>({...identity(op),start:op.start!.start,anchor:anchor(op)!,anchorKind:op.response.length?'response':'rejected',...op.response.length?{anchorStatus:op.response[0].status!,anchorURL:op.response[0].responseURL!,anchorRedirected:op.response[0].redirected!}:{anchorStatus:null,anchorURL:null,anchorRedirected:null},end:op.end,untimedAbort:abortEvidence(op),eligibleRequests:edges.get(op)!.map(q=>q.requestId),concurrentOperations:concurrent(op)})),
   requests:native.map(q=>({requestId:q.requestId,frameId:q.frameId,url:q.url,method:q.method,resourceType:q.resourceType,startTime:q.startTime,redirected:q.redirected,response:q.response?{url:q.response.url,status:q.response.status,fromServiceWorker:q.response.fromServiceWorker}:null})),pairs};
  return complete.map((p,i)=>{const q=assigned.get(ops[i])!;return {...p!,association:'unique-frame-inferred-bijection' as const,inferredAssociation:true,requestStartRaw:q.startTime,requestStart:q.startTime===0?null:q.startTime,requestTiming:q.startTime===0?'unavailable':'observed',eligibleRequests:edges.get(ops[i])!.map(q=>q.requestId),concurrentOperations:concurrent(ops[i]),bijection};});
 };
 const resolved=new Set<string>();
 const resolveBucket=(key:string)=>{
  const raw=buckets.get(key)!;
  if(!raw.operations.size||raw.operations.size>32||raw.requests.length>32||raw.operations.size!==raw.requests.length)return [];
  // A missing raw identity cannot safely be assigned to (or excluded from) a
  // full bucket. Refuse fallback rather than infer a frame/document/method.
  const validURL=(value:unknown)=>{try{return typeof value==='string'&&['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
  if(events.some(e=>!Number.isInteger(e.frameId)||e.frameId<=0||!/^[-a-f0-9]{36}$/.test(e.document)||!Number.isSafeInteger(e.operation)||e.operation<1||!validURL(e.url)||!['GET','POST','PUT'].includes(e.method)))return [];
  if(requests.some(q=>!Number.isInteger(q.frameId)||q.frameId<=0||!validURL(q.url)||!['GET','POST','PUT'].includes(q.method)||!Number.isSafeInteger(q.requestId)||q.requestId<1)||new Set(requests.map(q=>q.requestId)).size!==requests.length)return [];
  const ops=[...raw.operations],native=raw.requests;
  if(native.some(q=>q.startTime===0))return resolveUntimedBucket(ops,native,key);
  if(new Set(ops.flatMap(op=>op.rows.map(e=>e.document))).size!==1||new Set(native.map(q=>q.requestId)).size!==native.length)return [];
  if(native.some(q=>!Number.isSafeInteger(q.requestId)||q.requestId<1||q.resourceType!=='fetch'||!Number.isFinite(q.startTime)||q.startTime<=0||q.redirected!==false||q.response&&(q.response.fromServiceWorker!==false||!Number.isInteger(q.response.status)||q.response.status<100||q.response.status>599)||requests.filter(other=>other.requestId===q.requestId).length!==1))return [];
  const anchor=(op:Candidate)=>op.response[0]?.at??op.rows.find(e=>e.kind==='rejected')?.at;
  if(ops.some(op=>!op.valid||!op.start||op.rows.some(e=>bucketKey(e.frameId,e.url,e.method)!==key||!['start','response','reader','complete','cancel','abort','rejected','read-rejected','cancel-rejected','clone','tee','observer-error'].includes(e.kind))||!Number.isFinite(anchor(op))||anchor(op)!<op.start.start||!Number.isFinite(op.end)||op.end<anchor(op)!||op.response.length>1||op.rows.filter(e=>e.kind==='rejected').length>1||op.response.length&&op.rows.some(e=>e.kind==='rejected')||!op.requestsFor.length))return [];
  // Only forced degree-one operations are paired. Each step is logically
  // necessary; stalling refuses both ambiguous and unproved graphs. No FIFO,
  // nearest-time choice, factorial search or dropped unmatched vertex.
  const remaining=new Set(ops),available=new Set(native),pairs:{operation:number;requestId:number}[]=[],assigned=new Map<Candidate,OriginalRequest>();
  while(remaining.size){
   const forced=[...remaining].find(op=>op.requestsFor.filter(q=>available.has(q)).length===1);
   if(!forced)return [];
   const q=forced.requestsFor.find(q=>available.has(q))!;
   assigned.set(forced,q);pairs.push({operation:forced.start!.operation,requestId:q.requestId});remaining.delete(forced);available.delete(q);
   if([...remaining].some(op=>!op.requestsFor.some(q=>available.has(q))))return [];
  }
  if(available.size)return [];
  const complete=ops.map(op=>proofFor(op,assigned.get(op)!));if(complete.some(p=>!p))return [];
  const s=ops[0].start!,bijection={version:1,frameId:s.frameId,document:s.document,url:s.url,method:s.method,
   operations:ops.map(op=>({operation:op.start!.operation,document:op.start!.document,start:op.start!.start,anchor:anchor(op)!,anchorKind:op.response.length?'response':'rejected',...op.response.length?{anchorStatus:op.response[0].status!,anchorURL:op.response[0].responseURL!,anchorRedirected:op.response[0].redirected!}:{anchorStatus:null,anchorURL:null,anchorRedirected:null},end:op.end,eligibleRequests:op.requestsFor.map(q=>q.requestId),concurrentOperations:overlap(op).map(other=>other.start!.operation)})),
   requests:native.map(q=>({requestId:q.requestId,frameId:q.frameId,url:q.url,method:q.method,resourceType:q.resourceType,startTime:q.startTime,redirected:q.redirected,response:q.response?{url:q.response.url,status:q.response.status,fromServiceWorker:q.response.fromServiceWorker}:null})),pairs};
  return complete.map((p,i)=>({...p!,association:'unique-frame-time-bijection' as const,eligibleRequests:ops[i].requestsFor.map(q=>q.requestId),concurrentOperations:overlap(ops[i]).map(other=>other.start!.operation),bijection}));
 };
 const proofs=[];
 for(const op of candidates){
  if(!op.valid||!op.start)continue;
  const key=bucketKey(op.start.frameId,op.start.url,op.start.method);
  if(fallback.has(key)){
   if(!resolved.has(key)){const result=resolveBucket(key);resolved.add(key);proofs.push(...result);}
   continue;
  }
  // Original unique-window association and its evidence remain unchanged.
  if(op.requestsFor.length!==1||overlap(op).length||candidates.some(other=>other!==op&&other.requestsFor.includes(op.requestsFor[0])))continue;
  const proof=proofFor(op,op.requestsFor[0]);if(proof)proofs.push(proof);
 }
 return proofs;
}

// Observe only values from the application's original fetch/reader calls.
// Return the original promises, readers and results; never read, clone or tee.
export function installDisplayReadObserver(){
 'use strict';
 if(!/^https?:$/.test(location.protocol))return;
 const nativeFetch=window.fetch,document=crypto.randomUUID(),pendingTiles=new Set<number>(),pending=new Set<Promise<unknown>>(),errors:string[]=[];let ordinal=0,rows=0,reportedFailure=false;
 const now=()=>performance.timeOrigin+performance.now(),fail=(e:unknown)=>{
  if(errors.length<16)errors.push(String(e).slice(0,2048));
  // One out-of-band scalar failure survives navigation; a truncated prefix or
  // partially installed wrapper must never remain an eligible proof.
  if(!reportedFailure){reportedFailure=true;try{const p=(window as any).__validationDisplayAbort({document,kind:'collector-error'}) as Promise<unknown>;pending.add(p);void p.then(()=>pending.delete(p),()=>{pending.delete(p);});}catch{}}
 };
 const send=(event:Record<string,unknown>)=>{if(++rows>20000){fail('DISPLAY_OBSERVATION_LIMIT');return;}try{const p=(window as any).__validationDisplayAbort({document,...event}) as Promise<unknown>;pending.add(p);void p.then(()=>pending.delete(p),e=>{pending.delete(p);fail(e);});}catch(e){fail(e);}};
 const watch=<T>(p:Promise<T>,yes:(v:T)=>void,no?:(e:any)=>void)=>{void p.then(v=>{try{yes(v);}catch(e){fail(e);}},e=>{try{no?.(e);}catch(x){fail(x);}});};
 Object.defineProperty(window,'__validationPendingDisplayTiles',{get:()=>pendingTiles.size});
 Object.defineProperty(window,'__validationDisplayObserver',{value:{async flush(){while(pending.size)await Promise.allSettled([...pending]);if(errors.length)throw Error(errors.join('; '));}}});
 window.fetch=function(this:Window,...args:Parameters<typeof fetch>){
  const input=args[0],url=new URL(input instanceof Request?input.url:String(input),location.href),inputMethod=args[1]?.method??(input instanceof Request?input.method:'GET'),method=typeof inputMethod==='string'?inputMethod.toUpperCase():inputMethod;
  if(url.origin!==location.origin||!['GET','POST','PUT'].includes(method)||!/^\/api\/v1\//.test(url.pathname))return Reflect.apply(nativeFetch,this,args);
  const operation=++ordinal,start=now(),base={operation,url:url.href,method,start},signal=args[1]?.signal??(input instanceof Request?input.signal:null);
  if(url.pathname.endsWith('/display-tile'))pendingTiles.add(operation);
  const emit=(kind:string,fields:Record<string,unknown>={})=>{if(['abort','cancel','complete','rejected','read-rejected'].includes(kind))pendingTiles.delete(operation);send({...base,kind,at:now(),...fields});};
  send({...base,kind:'start',at:start,hasSignal:!!signal});
  if(signal){const aborted=()=>emit('abort',{aborted:signal.aborted});if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});}
  let promise:Promise<Response>;try{promise=Reflect.apply(nativeFetch,this,args);}catch(error){emit('rejected',{errorName:(error as Error)?.name});throw error;}
  watch(promise,response=>{
   emit('response',{status:response.status,responseURL:response.url,redirected:response.redirected});
   const clone=response.clone;response.clone=function(this:Response,...args:[]){emit('clone');return Reflect.apply(clone,this,args);};
   const body=response.body;if(!body)return;
   const getReader=body.getReader,cancel=body.cancel,tee=body.tee;let readers=0;
   body.tee=function(this:ReadableStream<Uint8Array>,...args:[]){emit('tee');return Reflect.apply(tee,this,args);};
   body.cancel=function(this:ReadableStream<Uint8Array>,...args:Parameters<typeof cancel>){const p=Reflect.apply(cancel,this,args);watch(p,()=>emit('cancel',{reader:0}),e=>emit('cancel-rejected',{reader:0,errorName:e?.name}));return p;};
   body.getReader=function(this:ReadableStream<Uint8Array>,...args:any[]){
    const reader=Reflect.apply(getReader,this,args),read=reader.read,cancelReader=reader.cancel,number=++readers;let bytes=0;
    try{emit('reader',{reader:number});
    reader.read=function(this:ReadableStreamDefaultReader<Uint8Array>,...args:any[]){const p=Reflect.apply(read,this,args) as Promise<ReadableStreamReadResult<Uint8Array>>;watch(p,part=>{if(part.done)emit('complete',{reader:number,bytes});else{bytes+=part.value.byteLength;if(!Number.isSafeInteger(bytes))emit('observer-error');}},e=>emit('read-rejected',{reader:number,errorName:e?.name}));return p;};
    reader.cancel=function(this:ReadableStreamDefaultReader<Uint8Array>,...args:any[]){const p=Reflect.apply(cancelReader,this,args);watch(p,()=>emit('cancel',{reader:number}),e=>emit('cancel-rejected',{reader:number,errorName:e?.name}));return p;};
    }catch(error){fail(error);}
    return reader;
   } as typeof body.getReader;
  },error=>emit('rejected',{errorName:error?.name}));
  return promise;
 };
}

export async function observeDisplayAborts(context:BrowserContext,requestId:(r:Request)=>number){
 const events:Observation[]=[],requests:{request:Request;frameId:number}[]=[],frames=new Map<Frame,number>(),responses=new Map<Request,OriginalRequest['response']>(),errors:string[]=[];
 const fail=(e:unknown)=>{if(errors.length<16)errors.push(String(e));},frameId=(frame:Frame)=>{if(!frames.has(frame))frames.set(frame,frames.size+1);return frames.get(frame)!;};
 context.on('request',request=>{if(['GET','POST','PUT'].includes(request.method())&&request.resourceType()==='fetch'&&displayObservationPath(request.url()))try{if(requests.length>=DISPLAY_REQUEST_LIMIT)throw Error('DISPLAY_REQUEST_LIMIT');requestId(request);requests.push({request,frameId:frameId(request.frame())});}catch(e){fail(e);}});
 context.on('response',response=>{const request=response.request();if(requests.some(r=>r.request===request))responses.set(request,{url:response.url(),status:response.status(),fromServiceWorker:response.fromServiceWorker()});});
 await context.exposeBinding('__validationDisplayAbort',({frame},event:Omit<Observation,'frameId'>)=>{if(event.kind==='collector-error'){fail('Browser original-read observer failed');return;}if(events.length>=DISPLAY_OBSERVATION_LIMIT){fail('DISPLAY_OBSERVATION_LIMIT');return;}events.push({...event,frameId:frameId(frame)});});
 await context.addInitScript(installDisplayReadObserver);
 const originals=()=>requests.map(({request,frameId})=>({requestId:requestId(request),frameId,url:request.url(),method:request.method(),resourceType:request.resourceType(),startTime:request.timing().startTime,redirected:!!request.redirectedFrom()||!!request.redirectedTo(),response:responses.get(request)}));
 const proofs=()=>displayReadProofs(events,originals(),errors);
 const flush=async(page:Page)=>{try{await page.evaluate(async()=>{await (window as any).__validationDisplayObserver?.flush();});}catch(e){fail(e);throw e;}};
 return Object.assign(proofs,{flush,settle:async(page:Page)=>{
  // Preserve the existing deliberate reload/display-ready boundary. This is
  // not a body read or a new network-settlement wait.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.waitForFunction(()=>{
   const canvas=document.querySelector<HTMLCanvasElement>('canvas[aria-label="Document raster preview"]');
   const closed=document.querySelector('footer')?.textContent?.includes('No document checkpoint');
   return (window as any).__validationPendingDisplayTiles===0&&(closed||Boolean(canvas?.dataset.asset));
  },null,{timeout:5000});
  await flush(page);
 },observations:()=>({events,requests:originals(),errors})});
}
