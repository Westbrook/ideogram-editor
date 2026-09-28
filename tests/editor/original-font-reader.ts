import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
import type {BrowserContext,Request,Frame} from '@playwright/test';

export type SealedFont={path:string;bytes:number;sha256:string};
export async function sealedBrowserFonts():Promise<SealedFont[]>{
 const profile=JSON.parse(await readFile('src/text/profile.json','utf8')),names=await readdir('dist/app/assets');
 return Promise.all(profile.fonts.map(async(f:any)=>{
  const extension=extname(f.file),stem=basename(f.file,extension),matches=names.filter(n=>n.startsWith(stem+'-')&&n.endsWith(extension));
  if(matches.length!==1)throw Error('Ambiguous built font: '+stem);
  const bytes=await readFile(join('dist/app/assets',matches[0])),hash=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==f.bytes||hash!==f.sha256)throw Error('Built font differs from sealed identity');
  return {path:'/assets/'+matches[0],bytes:f.bytes,sha256:f.sha256};
 }));
}

// Test-only observation. Native fetch/read/cancel promises and their results are
// returned unchanged. Only copies of chunks the application read are hashed.
// No clone, tee, drain, retry, request rewrite or awaited observer work occurs
// in the application path. It adds observation cost, not resource qualification.
export async function originalFontReader(context:BrowserContext,out:string,fonts:SealedFont[],requestId:(r:Request)=>number){
 const events:any[]=[],receipts:any[]=[],requests:Request[]=[],responses=new Map<Request,{response:any;finished:Promise<any>}>(),imports:{request:Request;command:any}[]=[],frames=new Map<Frame,number>(),writes:Promise<unknown>[]=[];
 const frameId=(frame:Frame)=>{if(!frames.has(frame))frames.set(frame,frames.size+1);return frames.get(frame)!;};
 const clock=()=>Date.now();let order=0;
 await context.exposeBinding('p1c6FontRead',({frame},event:any)=>{
  const {base64,...rest}=event,record={...rest,frameId:frameId(frame),observedAt:clock(),order:++order};events.push(record);
  if(event.kind==='body'){
   const bytes=Buffer.from(base64,'base64'),path=join(out,'font-'+record.document+'-'+record.operation+'.bin');
   const receipt={...record,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};receipts.push(receipt);writes.push(writeFile(path,bytes));
  }
 });
 context.on('response',response=>{const request=response.request();if(fonts.some(f=>new URL(request.url()).pathname===f.path))responses.set(request,{response,finished:response.finished().then(value=>({state:'resolved',value}),error=>({state:'unavailable',error:String(error)}))});});
 context.on('request',request=>{
  if(request.resourceType()==='fetch'&&fonts.some(f=>new URL(request.url()).pathname===f.path))requests.push(request);
  if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commands'){
   const command=request.postDataJSON()?.command;if(command?.body.type==='ImportFont')imports.push({request,command});
  }
 });
 await context.addInitScript(({fonts})=>{
  if(location.protocol!=='http:'&&location.protocol!=='https:')return;
  const nativeFetch=window.fetch,document=crypto.randomUUID(),pending:Promise<unknown>[]=[],observerErrors:string[]=[];let sequence=0;
  const now=()=>performance.timeOrigin+performance.now();
  const send=(event:any)=>{const task=(window as any).p1c6FontRead({document,...event});pending.push(task);task.catch((e:any)=>observerErrors.push(String(e)));};
  Object.defineProperty(window,'__p1c6FontObserver',{value:{async flush(){let observed=-1;while(observed!==pending.length){observed=pending.length;await Promise.all(pending);}if(observerErrors.length)throw Error(observerErrors.join('; '));}}});
  window.fetch=function(...args:Parameters<typeof fetch>){
   const resource=args[0],url=new URL(resource instanceof Request?resource.url:String(resource),location.href),method=args[1]?.method??(resource instanceof Request?resource.method:'GET');
   const font=fonts.find(f=>url.origin===location.origin&&url.pathname===f.path&&url.search==='');
   if(!font||method.toUpperCase()!=='GET')return Reflect.apply(nativeFetch,this,args);
   const operation=++sequence,start=now(),base={operation,start,timeOrigin:performance.timeOrigin,url:url.href,method:'GET',font};
   send({...base,kind:'start'});
   const promise=Reflect.apply(nativeFetch,this,args);
   promise.then(response=>{
    const responseAt=now(),identity={...base,responseAt,status:response.status,responseURL:response.url,redirected:response.redirected,responseType:response.type};
    send({...identity,kind:'response'});
    const body=response.body;if(!body){send({...identity,kind:'missing-body'});return;}
    const originalGet=body.getReader,originalClone=response.clone,originalTee=body.tee;let readers=0,cloned=false,teed=false;
    response.clone=function(){cloned=true;send({...identity,kind:'clone'});return Reflect.apply(originalClone,this,[]);};
    body.tee=function(){teed=true;send({...identity,kind:'tee'});return Reflect.apply(originalTee,this,[]);};
    body.getReader=function(this:ReadableStream<Uint8Array>,...getArgs:any[]){
     const reader=Reflect.apply(originalGet,this,getArgs),originalRead=reader.read,originalCancel=reader.cancel,originalRelease=reader.releaseLock,chunks:Uint8Array[]=[],readerNumber=++readers;
     send({...identity,kind:'reader',at:now(),readerNumber});
     let count=0,eof=false,failed=false,cancelledBeforeEOF=false,truncatedObservation=false,reads=0;
     const bodyReceipt=(reason:string)=>{
      const copied=chunks.map(c=>new Uint8Array(c)),snapshot={...identity,kind:'body',end:now(),reason,normalEOF:eof,failed,cancelledBeforeEOF,readers,readerNumber,cloned,teed,reads,count,truncatedObservation};
      const task=(async()=>{const bytes=new Uint8Array(await new Blob(copied as BlobPart[]).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));send({...snapshot,base64:btoa(binary)});})();pending.push(task);task.catch(e=>observerErrors.push(String(e)));
     };
     reader.read=function(...readArgs:any[]){
      const result=Reflect.apply(originalRead,this,readArgs) as Promise<ReadableStreamReadResult<Uint8Array>>;
      result.then((r:ReadableStreamReadResult<Uint8Array>)=>{
       reads++;if(r.done){eof=true;bodyReceipt('normal-eof');return;}
       count+=r.value.byteLength;send({...identity,kind:'chunk',at:now(),count});if(count<=font.bytes+65536)chunks.push(new Uint8Array(r.value));else truncatedObservation=true;
      },(error:any)=>{failed=true;send({...identity,kind:'read-error',at:now(),name:error?.name,message:error?.message});bodyReceipt('read-error');});
      return result;
     };
     reader.cancel=function(...cancelArgs:any[]){cancelledBeforeEOF ||= !eof;send({...identity,kind:'cancel',at:now(),afterEOF:eof});if(!eof)bodyReceipt('early-cancel');return Reflect.apply(originalCancel,this,cancelArgs);};
     reader.releaseLock=function(){send({...identity,kind:'release',at:now(),afterEOF:eof});return Reflect.apply(originalRelease,this,[]);};
     return reader;
    } as typeof body.getReader;
   },(error:any)=>send({...base,kind:'fetch-error',name:error?.name,message:error?.message}));
   return promise;
  };
 },{fonts});
 return {events,receipts,async flush(){for(const page of context.pages())await page.evaluate(async()=>{await (window as any).__p1c6FontObserver?.flush();});await Promise.all(writes);},
  async seal(commandReceipt:(id:string)=>any){
   await Promise.all(writes);const proofs:any[]=[];
   for(const receipt of receipts.filter(r=>r.reason==='normal-eof')){
    const starts=events.filter(e=>e.kind==='start'&&e.frameId===receipt.frameId&&e.document===receipt.document&&e.url===receipt.url);
    const overlapping=starts.filter(e=>e.operation!==receipt.operation&&e.start<=receipt.end&&(receipts.find(r=>r.frameId===e.frameId&&r.document===e.document&&r.operation===e.operation)?.end??Infinity)>=receipt.start);
    const candidates=requests.filter(r=>frameId(r.frame())===receipt.frameId&&r.url()===receipt.url&&r.method()==='GET'&&r.timing().startTime>=receipt.start-2&&r.timing().startTime<=receipt.responseAt+2);
    const ownEvents=events.filter(e=>e.frameId===receipt.frameId&&e.document===receipt.document&&e.operation===receipt.operation);
    const proof={...receipt,readers:ownEvents.filter(e=>e.kind==='reader').length,cloned:ownEvents.some(e=>e.kind==='clone'),teed:ownEvents.some(e=>e.kind==='tee'),eligibleRequests:candidates.map(requestId),concurrentOperations:overlapping.map(x=>x.operation),association:'unproved',applicationValidated:false} as any;
    if(candidates.length===1&&!overlapping.length){
     const request=candidates[0],observed=responses.get(request),response=observed?.response;
     if(response&&response.request()===request){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finished=await Promise.race([observed!.finished,new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'unresolved',windowMs:250}),250);})]);clearTimeout(timer);
      Object.assign(proof,{requestId:requestId(request),requestURL:request.url(),requestFrame:frameId(request.frame()),requestStart:request.timing().startTime,redirectedFrom:request.redirectedFrom()?.url()??null,responseStatus:response.status(),browserResponseURL:response.url(),fromServiceWorker:response.fromServiceWorker(),cacheControl:response.headers()['cache-control']??null,protocolFailure:request.failure(),protocolFinished:finished,association:'unique-frame-time-window'});
      const next=events.filter(e=>e.kind==='start'&&e.frameId===receipt.frameId&&e.document===receipt.document&&e.start>receipt.start).sort((a,b)=>a.start-b.start)[0];
      const validating=imports.filter(i=>frameId(i.request.frame())===receipt.frameId&&new URL(i.request.url()).origin===new URL(receipt.url).origin&&i.request.timing().startTime>=receipt.end-2&&(!next||i.request.timing().startTime<next.start)&&i.command.body.source.hash==='sha256:'+receipt.sha256&&i.command.body.source.byteLength===String(receipt.bytes));
      if(validating.length===1){const i=validating[0],accepted=commandReceipt(i.command.commandId);proof.validation={commandId:i.command.commandId,clientId:i.command.clientId,sessionId:i.command.sessionId,documentId:i.command.documentId,issuedAt:i.command.issuedAt,source:i.command.body.source,receipt:accepted};proof.applicationValidated=accepted?.status==='accepted';}
     }
    }
    proofs.push(proof);
   }
   await writeFile(join(out,'original-font-reads.json'),JSON.stringify({fonts,events,receipts,proofs},null,2));return proofs;
  }
 };
}
