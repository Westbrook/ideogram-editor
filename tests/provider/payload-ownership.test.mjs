// Focused source-only candidate tests. Not executed during the production freeze.
// After promotion both roots default to production; staged evaluation is explicit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const root=process.env.ALLOCATION_CLOSURE_ROOT??'.',promptRoot=process.env.ALLOCATION_PROMPT_ROOT??'.',observationRoot=process.env.OBSERVABILITY_STAGED_ROOT??'.',uiRoot=process.env.RESPONSE_CALLER_STAGED_ROOT??root;
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path){if(path.startsWith('src/observability/'))try{return await readFile(observationRoot+'/'+path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}return readFile(path,'utf8');}
async function module(path,imports={}){let code=(await transformWithOxc(await source(path),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
let diagnosticURL,compositionObserverURL;try{diagnosticURL=await module('src/observability/diagnostic-memory.ts');compositionObserverURL=await module('src/observability/composition-observations.ts',{'./diagnostic-memory.js':diagnosticURL});}catch(error){if(error.code!=='ENOENT')throw error;}
const allocationURL=await module('src/observability/allocations.ts',diagnosticURL?{'./diagnostic-memory.js':diagnosticURL,'./composition-observations.js':compositionObserverURL}:{}),promptURL=await module(promptRoot+'/src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const modelURL=await module(root+'/src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL});
const jsonURL=await module('src/protocol/json.ts'),adapterURL=await module('src/ui/adapters.ts');
const payloadURL=await module(root+'/src/ui/provider-payload.ts',{'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptURL,'../observability/allocations.js':allocationURL,'../protocol/json.js':jsonURL});
const estimateURL=data('export function renderRequestEstimate(){return "estimate";}');
const uiURL=await module(uiRoot+'/src/ui/provider.ts',{'lit':lit,'./adapters.js':adapterURL,'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptURL,'./provider-payload.js':payloadURL,'./request-v45.js':estimateURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL),{readOwnedJSON,cloneOwnedModel}=await import(modelURL),{PromptReaderCleanupError}=await import(promptURL);
const {decodeFrozenPromptPage,frozenSettings}=await import(payloadURL),{ProviderControls}=await import(uiURL);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const page=(text='Frozen paid prompt',offset='0',total=String(Buffer.byteLength(text)))=>({bytes:Buffer.from(text).toString('base64'),byteLength:total,offset,nextOffset:BigInt(offset)+BigInt(Buffer.byteLength(text))===BigInt(total)?null:String(BigInt(offset)+BigInt(Buffer.byteLength(text)))});
const response=value=>{const body=JSON.stringify(value);return new Response(body,{headers:{'content-length':String(Buffer.byteLength(body))}});};
function fixture(){
 const provider={protocolVersion:1,mode:'fal',ready:true,state:'ready',configurationId:'configured-run',configurationHash:'sha256:'+'a'.repeat(64),epoch:'writer-epoch',credentialConfigured:true,operation:'generate',endpoint:'ideogram/v4',profile:{id:'documented-fal',version:1,disclosureDigest:'sha256:'+'c'.repeat(64),disclosure:['Privacy fallback.']},limits:{maximumRequests:2,maximumImages:2,usedRequests:0,usedImages:0,width:1024,height:1024,imagesPerRequest:1,format:'png',expansion:'None',expiresAt:'2999-01-01T00:00:00.000Z'},message:'Configured'};
 const job={id:'job',version:'7',documentId:'document',review:{id:'review',token:'review-token',endpoint:'ideogram/v4',prompt:{hash:'sha256:'+'7'.repeat(64),byteLength:'18',mediaType:'text/plain'},request:{kind:'generate',size:{kind:'custom',width:1024,height:1024},settings:{count:1,format:'png',expansion:'None'}},estimate:{rate:'0.04',unit:'image',count:1,unknown:[]}},stagePlan:[],local:'accepted-local-queue',resultImport:'none',disposition:'eligible',attempts:[{id:'attempt',version:'1',state:'not-started'}]};
 const queue={protocolVersion:1,jobs:[job],nextCursor:null},commands=[],responses=[];let command=async()=>[],prompt=()=>response(page());
 const editor={view:{ready:true,document:{id:'document',revision:'1'}},sessionId:'session',draftOwner:{drafts:new Map()},session:{identity:()=> 'client'},ownedJSON(path,owner,init,owns,maxBytes,kind){assert.equal(kind,path.includes('prompt=requested')?'prompt':'control');return readOwnedJSON(async(path)=>path==='/api/v1/provider'?response(provider):path.startsWith('/api/v1/queue')?response(queue):prompt(),path,{owner,init,owns,maxBytes,kind});},async command(){throw Error('RAW_COMMAND_RESPONSE_FORBIDDEN');},async withCommandEvents(body,consume,document){commands.push({body:structuredClone(body),document});const owned=cloneOwnedModel('provider-command-response',await command(body)),row={value:owned.value,active:true};responses.push(row);try{return await consume(owned.value);}finally{row.active=false;owned.release();}}};
 const host={requestUpdate(){},updateComplete:Promise.resolve(),querySelector(){return {focus(){}};}};
 const controller=new ProviderControls(host,editor);
 return {controller,editor,provider,job,queue,commands,responses,setCommand(value){command=value;},prompt(value){prompt=value;},async initial(){await controller.sync();},inspect(){return controller.inspect(controller.provider,controller.queue.jobs[0],controller.capture());}};
}
test('frozen settings reserve their retained pretty JSON including nested whitespace',()=>{
 const before=allocationLedger.snapshot().cpuBytes,value={a:[{b:'😀',c:[],d:{}},false,null],z:{x:'\\quoted\"'}},owned=frozenSettings(value);
 try{assert.equal(owned.value,JSON.stringify(value,null,2));assert.equal(allocationLedger.snapshot().cpuBytes-before,owned.value.length*2);}finally{owned.release();}
 assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('decoded prompt pages preserve exact Unicode and retain independent async pins',()=>{
 const before=allocationLedger.snapshot().cpuBytes,owned=decodeFrozenPromptPage(page('😀 café'),'10','0'),unpin=owned.pin();
 assert.equal(owned.value.text,'😀 café');assert.ok(allocationLedger.snapshot().cpuBytes>before);owned.release();owned.release();assert.ok(allocationLedger.snapshot().cpuBytes>before);unpin();unpin();assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('decode refusal happens before atob and preserves no new owner',()=>{
 const blocker=allocationLedger.reserve({owner:'provider-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes}),original=globalThis.atob;let calls=0;
 globalThis.atob=(value)=>{calls++;return original(value);};
 try{assert.throws(()=>decodeFrozenPromptPage(page(),'18','0'),/PROMPT_MEMORY_BUDGET/);assert.equal(calls,0);}finally{globalThis.atob=original;blocker.release();}
});
test('malformed or oversized frozen pages fail without retained output',()=>{
 const before=allocationLedger.snapshot().cpuBytes;
 for(const value of [{...page(),bytes:'%%%%'},{...page(),offset:'1'},page('x'.repeat(32769)),{...page(),nextOffset:'1'},page('\ufffd')]){
  if(value.bytes===Buffer.from('\ufffd').toString('base64')){value.bytes='/w==';value.byteLength='1';}
  assert.throws(()=>decodeFrozenPromptPage(value,value.byteLength,'0'));
 }
 assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('failed refresh preserves the old models and review but fences paid authorization',async()=>{
 const f=fixture();await f.initial();await f.inspect();const prior={provider:f.controller.provider,queue:f.controller.queue,review:f.controller.review};
 const current=allocationLedger.snapshot().cpuBytes,pressure=allocationLedger.reserve({owner:'provider-test-cpu-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-current});
 try{await f.controller.refresh(f.controller.capture());assert.equal(f.controller.provider,prior.provider);assert.equal(f.controller.queue,prior.queue);assert.equal(f.controller.review,prior.review);assert.equal(f.controller.fresh,false);await f.controller.authorize(prior.review);assert.equal(f.commands.length,0);}finally{pressure.release();await f.controller.dispose();}
});
test('failed page admission preserves the previous exact page',async()=>{
 const f=fixture();await f.initial();await f.inspect();const prior=f.controller.review.prompt,blocker=allocationLedger.reserve({owner:'provider-test-page-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{await assert.rejects(f.controller.readPrompt(f.controller.review),/PROMPT_MEMORY_BUDGET/);assert.equal(f.controller.review.prompt,prior);assert.equal(f.commands.length,0);}finally{blocker.release();await f.controller.dispose();}
});
test('document release waits for the actual pending cancellation before refunding read and review pins',async()=>{
 const before=allocationLedger.snapshot().cpuBytes,f=fixture(),cancel=deferred();let cancelled=false,drained=false;
 await f.initial();f.prompt(()=>new Response(new ReadableStream({cancel(){cancelled=true;return cancel.promise;}}),{headers:{'content-length':'50'}}));
 const inspecting=f.inspect();void inspecting.catch(()=>{});await flush();const release=f.controller.dispose().then(()=>{drained=true;});await flush();assert.equal(cancelled,true);assert.equal(drained,false);assert.ok(allocationLedger.snapshot().cpuBytes>before);
 cancel.resolve();await release;await assert.rejects(inspecting);assert.equal(allocationLedger.snapshot().cpuBytes,before);assert.equal(f.commands.length,0);
});
test('v4.5 stays admission-blocked without a review clone, prompt read or paid command',async()=>{
 const f=fixture();Object.assign(f.provider,{operation:'generate-v45',ready:false,state:'admission-blocked'});await f.initial();let promptReads=0;f.prompt(()=>{promptReads++;return response(page());});
 try{assert.throws(()=>f.controller.inspect(f.controller.provider,f.controller.queue.jobs[0],f.controller.capture()),/unavailable|withheld/);assert.equal(promptReads,0);assert.equal(f.controller.review,null);assert.equal(f.commands.length,0);}finally{await f.controller.dispose();}
});
test('a settled native cancellation failure survives until and after release',async()=>{
 const f=fixture();await f.initial();const native=Error('native cancellation failed');f.prompt(()=>new Response(new ReadableStream({cancel(){throw native;}}),{headers:{'content-length':'999999'}}));
 await assert.rejects(f.inspect(),PromptReaderCleanupError);await assert.rejects(f.controller.dispose(),/PROVIDER_RELEASE_INCOMPLETE/);await assert.rejects(f.controller.dispose(),/PROVIDER_RELEASE_INCOMPLETE/);assert.equal(f.controller.lifecycle.cleanupFailures,1);assert.equal(f.commands.length,0);
});


test('confirmed provider authorization consumes and releases its owned event response before refreshing',async()=>{
 const before=allocationLedger.snapshot().cpuBytes,f=fixture();
 try{await f.initial();await f.inspect();const review=f.controller.review;f.setCommand(async()=>[{type:'ProviderJobAuthorized',payload:{jobId:'job'}}]);
  const refresh=f.controller.refresh.bind(f.controller);f.controller.refresh=(...args)=>{assert.equal(f.responses.length,1);assert.equal(f.responses[0].active,false);return refresh(...args);};
  await f.controller.authorize(review);assert.equal(f.commands.length,1);assert.equal(f.commands[0].document,null);assert.equal(f.commands[0].body.type,'AuthorizeProviderJob');assert.match(f.controller.message,/Authorization recorded/);
 }finally{await f.controller.dispose();}
 assert.equal(allocationLedger.snapshot().cpuBytes,before);
});

test('provider document release drains an accepted authorization without retaining its late event graph',async()=>{
 const before=allocationLedger.snapshot().cpuBytes,f=fixture(),gate=deferred(),entered=deferred();
 try{await f.initial();await f.inspect();const review=f.controller.review;f.setCommand(async()=>{entered.resolve();return gate.promise;});const action=f.controller.authorize(review);await entered.promise;
  let closed=false;const closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.ok(allocationLedger.snapshot().cpuBytes>before);
  gate.resolve([{type:'ProviderJobAuthorized',payload:{jobId:'job'}}]);await action;await closing;assert.equal(closed,true);assert.equal(f.responses[0].active,false);assert.equal(f.controller.provider,null);assert.equal(f.controller.review,null);
 }finally{gate.resolve([]);await f.controller.dispose();}
 assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
