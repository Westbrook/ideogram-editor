import type {BrowserContext, Request, Page} from '@playwright/test';

// Observe the real fetch and its supplied signal without replacing responses,
// adding request headers, delaying fetch, or issuing an extra body read. Observe only the application’s own reader results.
export async function observeDisplayAborts(context:BrowserContext,requestId:(r:Request)=>number){
 const starts:{token:string;url:string;aborted:boolean}[]=[],aborted=new Set<string>(),canceled=new Set<string>(),completed=new Map<string,{bytes:number;status:number}>(),requests:Request[]=[];
 const isTile=(url:string)=>/^\/api\/v1\/(?:events\/stream|assets\/[^/]+(?:\/display-tile)?|(?:documents|ui)\/[^/]+\/composition)$/.test(new URL(url).pathname);
 context.on('request',r=>{if(r.method()==='GET'&&r.resourceType()==='fetch'&&isTile(r.url())){requestId(r);requests.push(r);}});
 await context.exposeBinding('__validationDisplayAbort',(_source,event:{kind:string;token:string;url:string;bytes?:number;status?:number})=>{
  if(event.kind==='start')starts.push({...event,aborted:false});
  else if(event.kind==='abort')aborted.add(event.token);
  else if(event.kind==='cancel')canceled.add(event.token);
  else if(event.kind==='complete')completed.set(event.token,{bytes:event.bytes!,status:event.status!});
 });
 await context.addInitScript(()=>{
  if(location.origin==='null')return;
  const fetch=window.fetch,documentId=crypto.randomUUID(),pendingTiles=new Set<string>();let ordinal=0;
  Object.defineProperty(window,'__validationPendingDisplayTiles',{get:()=>pendingTiles.size});
  window.fetch=function(input:RequestInfo|URL,init?:RequestInit){
   const url=new URL(input instanceof Request?input.url:String(input),location.href).href;
   if(!/^\/api\/v1\/(?:events\/stream|assets\/[^/]+(?:\/display-tile)?|(?:documents|ui)\/[^/]+\/composition)$/.test(new URL(url).pathname)||(init?.method??(input instanceof Request?input.method:'GET'))!=='GET')return fetch.call(this,input,init);
   const token=documentId+':'+(++ordinal),signal=init?.signal??(input instanceof Request?input.signal:null);
   if(new URL(url).pathname.endsWith('/display-tile'))pendingTiles.add(token);
   const emit=(kind:string,bytes?:number,status?:number)=>{if(['abort','cancel','complete','rejected'].includes(kind))pendingTiles.delete(token);void (window as any).__validationDisplayAbort({kind,token,url,bytes,status});};
   emit('start');if(signal?.aborted)emit('abort');else signal?.addEventListener('abort',()=>emit('abort'),{once:true});
   return fetch.call(this,input,init).then(response=>{
    const body=response.body;if(body){const getReader=body.getReader.bind(body),cancel=body.cancel.bind(body);
     body.cancel=(reason?:any)=>cancel(reason).then(value=>{emit('cancel');return value;});
     body.getReader=((...args:any[])=>{const reader=(getReader as any)(...args),read=reader.read.bind(reader),cancelReader=reader.cancel.bind(reader);let bytes=0;
      reader.cancel=(reason?:any)=>cancelReader(reason).then((value:any)=>{emit('cancel');return value;});
      reader.read=(...readArgs:any[])=>read(...readArgs).then((part:any)=>{if(part.done)emit('complete',bytes,response.status);else bytes+=part.value.byteLength;return part;});
      return reader;
     }) as typeof body.getReader;
    }
    return response;
   },error=>{emit('rejected');throw error;});
  };
 });
 const proofsForRequests=()=>{
  const proofs:{requestId:number;url:string;signalAborted:boolean;bodyComplete:boolean;bodyCanceled:boolean;bytes?:number;status?:number;exactOccurrence:true}[]=[];
  for(const url of new Set(requests.map(r=>r.url()))){
   const observed=starts.filter(s=>s.url===url),wire=requests.filter(r=>r.url()===url);
   // All starts must be represented and tokens unique. Per-URL fetch and wire
   // occurrence order identifies repeated reads, including across navigation.
   if(observed.length!==wire.length||new Set(observed.map(s=>s.token)).size!==observed.length)continue;
   observed.forEach((s,i)=>{if(aborted.has(s.token)||completed.has(s.token)||canceled.has(s.token))proofs.push({requestId:requestId(wire[i]),url,signalAborted:aborted.has(s.token),bodyComplete:completed.has(s.token),bodyCanceled:canceled.has(s.token),...completed.get(s.token),exactOccurrence:true});});
  }
  return proofs;
 };
 return Object.assign(proofsForRequests,{settle:async(page:Page)=>{
  // A deliberate recovery reload need not interrupt unrelated display reads.
  // A gap between reads can still have queued tile decoding. Require the
  // existing DOM marker for a fully drawn raster, or the public closed state.
  // Never wait for the long-lived SSE or call private application methods.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.waitForFunction(()=>{
   const canvas=document.querySelector<HTMLCanvasElement>('canvas[aria-label="Document raster preview"]');
   const closed=document.querySelector('footer')?.textContent?.includes('No document checkpoint');
   return (window as any).__validationPendingDisplayTiles===0&&(closed||Boolean(canvas?.dataset.asset));
  },null,{timeout:5000});
  await page.evaluate(()=>(window as any).__validationDisplayAbort({kind:'barrier',token:'',url:location.href}));
 },observations:()=>({starts,aborted:[...aborted],canceled:[...canceled],completed:[...completed],requests:requests.map(r=>({requestId:requestId(r),url:r.url()}))})});
}
