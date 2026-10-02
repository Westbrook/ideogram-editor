import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';

// Exercise the actual controller and rendered callbacks. The Lit stand-in retains
// template values; it supplies no authorization, event handling or editor logic.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const root=process.env.PROVIDER_UI_SOURCE_ROOT??'.';
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const adapter=await moduleURL('src/ui/adapters.ts'),json=await moduleURL('src/protocol/json.ts');
const memory=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const payload=await moduleURL('src/ui/provider-payload.ts',{'../observability/model-memory.js':memory,'../observability/prompt-memory.js':promptMemoryURL,'../observability/allocations.js':allocationsURL,'../protocol/json.js':json});
const v45=await moduleURL('src/request/v45.ts'),requestV45=await moduleURL('src/ui/request-v45.ts',{'lit':lit,'../request/v45.js':v45});
const controllerURL=await moduleURL(root+'/src/ui/provider.ts',{'lit':lit,'./adapters.js':adapter,'../observability/model-memory.js':memory,'../observability/prompt-memory.js':promptMemoryURL,'./provider-payload.js':payload,'./request-v45.js':requestV45});
const {ProviderControls}=await import(controllerURL),{readOwnedJSON,cloneOwnedModel}=await import(memory),{allocationLedger}=await import(allocationsURL);
const owned=new Set(),gates=new Set();
const totals=()=>{const value=allocationLedger.snapshot();return {cpu:value.cpuBytes,handles:value.handles,records:value.activeRecords,prompt:value.promptBytes};};
const baseline=totals();
test.afterEach(async()=>{
 for(const gate of gates)gate.resolve([]);gates.clear();await settle();
 const outcomes=await Promise.allSettled([...owned].map(controller=>controller.dispose()));owned.clear();await settle();
 assert.deepEqual(outcomes.filter(value=>value.status==='rejected'),[]);assert.deepEqual(totals(),baseline);
});
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});const gate={promise,resolve,reject};gates.add(gate);return gate;}
function find(template,part){
 if(!template||typeof template!=='object')return;
 if(template.strings){const i=template.strings.findIndex(s=>s.includes(part));if(i>=0)return {strings:template.strings.slice(i),values:template.values.slice(i)};}
 for(const value of Array.isArray(template)?template:template.values??[]){const found=find(value,part);if(found)return found;}
}
function buttonWithLabel(template,label){
 if(!template||typeof template!=='object')return;
 if(template.strings){const i=template.strings.findIndex(s=>s.includes('>'+label+'</en-button>'));if(i>0&&typeof template.values[i-1]==='function')return template.values[i-1];}
 for(const value of Array.isArray(template)?template:template.values??[]){const callback=buttonWithLabel(value,label);if(callback)return callback;}
}
function text(template){
 if(template===null||template===undefined||typeof template==='function')return '';
 if(Array.isArray(template))return template.map(text).join('');
 if(template.strings)return template.strings.map((s,i)=>s+text(template.values[i])).join('');
 return String(template);
}
function event(){const host={isConnected:true};return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};}
const promptText='Frozen paid prompt',ref={hash:'sha256:'+'7'.repeat(64),byteLength:'18',mediaType:'text/plain'};
const promptPage=(text=promptText,offset='0',total=ref.byteLength)=>({bytes:Buffer.from(text).toString('base64'),byteLength:total,offset,nextOffset:BigInt(offset)+BigInt(Buffer.byteLength(text))===BigInt(total)?null:String(BigInt(offset)+BigInt(Buffer.byteLength(text)))});
function provider(){return {protocolVersion:1,mode:'fal',ready:true,state:'ready',configurationId:'configured-run',configurationHash:'sha256:'+'a'.repeat(64),epoch:'writer-epoch',credentialConfigured:true,operation:'generate',endpoint:'ideogram/v4',profile:{id:'documented-fal',version:1,evidenceDigest:'sha256:'+'b'.repeat(64),disclosureDigest:'sha256:'+'c'.repeat(64),disclosure:['Retention is provider controlled.','Requested expiration is not a guarantee of deletion.'],requestedStoreIO:'0',expirationSeconds:3600,initialACL:'public',enforcement:'documented'},limits:{maximumRequests:2,maximumImages:2,usedRequests:0,usedImages:0,width:1024,height:1024,imagesPerRequest:1,format:'png',expansion:'None',expiresAt:new Date(Date.now()+3600000).toISOString()},message:'Explicit provider configuration available.'};}
function job(){return {id:'retained-job',version:'7',documentId:'document',review:{id:'immutable-review',token:'accepted-review-token',endpoint:'ideogram/v4',prompt:{...ref},request:{kind:'generate',size:{kind:'custom',width:1024,height:1024},settings:{count:1,format:'png',expansion:'None'}},estimate:{rate:'0.04',unit:'image',count:1,unknown:['final provider charge']}},stagePlan:[],local:'accepted-local-queue',resultImport:'none',disposition:'eligible',attempts:[{id:'retained-attempt',version:'1',state:'not-started',count:'none'}]};}
function fixture(){
 let instance,rendered,identity='client';const commands=[],reads=[],focus=[];
 let p=provider(),q={protocolVersion:1,jobs:[job()],nextCursor:null,production:'denied',session:{id:'spend-session',version:'1',cap:null},counts:{reserved:0,dispatched:0,remaining:null,active:0},limits:{active:1,target:100,maximum:1000}};
 const editor={view:{ready:true,document:{id:'document',revision:'1'}},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map()},async transportJSON(path){reads.push(path);if(path==='/api/v1/provider')return p;if(path.startsWith('/api/v1/queue'))return q;if(path==='/api/v1/jobs/retained-job/candidates?attempt=retained-attempt&prompt=requested&offset=0')return promptPage();throw Error('Unexpected read '+path);},async json(){throw Error('RAW_PROVIDER_JSON_FORBIDDEN');},async command(){throw Error('RAW_PROVIDER_COMMAND_FORBIDDEN');},async commandResult(body,document){commands.push({body:structuredClone(body),document});return [];},
  async ownedJSON(path,owner,init,owns,maxBytes,kind){
   assert.equal(kind,path.includes('&prompt=requested&')?'prompt':'control');
   const result=await readOwnedJSON(async requested=>{const value=await editor.transportJSON(requested),body=JSON.stringify(value);return new Response(body,{headers:{'content-length':String(Buffer.byteLength(body))}});},path,{owner,init,owns,maxBytes,kind});
   // Test mutations represent updates to the current live provider/queue
   // projection, not detached pre-transport inputs. Reviews remain real clones.
   if(path==='/api/v1/provider')p=result.value;else if(path.startsWith('/api/v1/queue'))q=result.value;
   return result;
  },
  async withCommandEvents(body,consume,document){const result=cloneOwnedModel('provider-ui-command-result',await editor.commandResult(body,document));try{return await consume(result.value);}finally{result.release();}}
 };
 const host={requestUpdate(){this.updateComplete=Promise.resolve().then(()=>rendered=instance.render());},updateComplete:Promise.resolve(),querySelector(selector){return {focus(){focus.push(selector);}};}};
 instance=new ProviderControls(host,editor);owned.add(instance);
 const callback=part=>{const found=find(rendered,part);assert(found,'Rendered '+part);const cb=found.values.find(v=>typeof v==='function');assert(cb,'Callback '+part);return cb;};
 return {instance,host,editor,get provider(){return p;},get job(){return q.jobs[0];},get queue(){return q;},commands,reads,focus,identity(v){identity=v;},template:()=>rendered,text:()=>text(rendered),callback,refresh:()=>callback('<en-button id="refresh-provider"'),review:()=>callback('<en-button ?disabled='),authorize:()=>callback('<en-button id="authorize-provider"'),local:()=>callback('>Acknowledge paid attempt and privacy fallback; authorize dispatch</en-button><en-button'),async initial(){await instance.sync();host.requestUpdate();await flush();},async inspect(){callback('<en-button ?disabled=')(event());await settle();assert(find(rendered,'<en-card id="provider-dispatch-review"'),'Explicit review card');},composition(){return find(rendered,'<en-accordion-item label="Live provider"').values.filter(v=>typeof v==='function').slice(0,2);}};
}
function replaceOwner(f,boundary){
 if(boundary==='document')f.editor.view.document={id:'replacement-document',revision:'1'};
 if(boundary==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};
 if(boundary==='session')f.editor.sessionId='replacement-session';
 if(boundary==='identity')f.identity('replacement-client');
 if(boundary==='connection')f.editor.session={...f.editor.session};
 if(boundary==='draft owner')f.editor.draftOwner={drafts:new Map()};
 if(boundary==='disposal')f.instance.dispose();
 if(boundary==='readiness')f.editor.view.ready=false;
 if(boundary==='composition')f.composition()[0]();
}

test('sync, refresh, review and keeping a job local never grant dispatch authority',async()=>{
 const f=fixture();await f.initial();assert.deepEqual(f.commands,[]);f.refresh()(event());await settle();assert.deepEqual(f.commands,[]);
 await f.inspect();assert.deepEqual(f.commands,[]);assert.deepEqual(f.focus,['#provider-dispatch-review']);
 f.local()(event());await settle();assert.deepEqual(f.commands,[]);assert(!find(f.template(),'<en-card id="provider-dispatch-review"'));
 assert.match(f.text(),/Live dispatch was not authorized/);
});
test('only the deliberately confirmed frozen review emits the exact authorization body once',async()=>{
 const f=fixture();await f.initial();await f.inspect();const callback=f.authorize();callback(event());callback(event());await settle();
 assert.deepEqual(f.commands,[{document:null,body:{type:'AuthorizeProviderJob',jobId:'retained-job',attemptId:'retained-attempt',expectedVersion:'7',reviewToken:'accepted-review-token',configurationId:f.provider.configurationId,configurationHash:f.provider.configurationHash,epoch:'writer-epoch',profileId:'documented-fal',profileVersion:1,disclosureDigest:f.provider.profile.disclosureDigest,acknowledgeChargeAndPrivacy:true}}]);
 assert.match(f.text(),/Authorization recorded/);assert(!find(f.template(),'<en-card id="provider-dispatch-review"'));
});
for(const action of ['review','authorize'])for(const boundary of ['document','revision','session','identity','connection','draft owner','disposal','readiness','composition'])for(const queued of [false,true])test(`${action} callback refuses ${boundary} ${queued?'after scheduling':'before invocation'}`,async()=>{
 const f=fixture();await f.initial();if(action==='authorize')await f.inspect();const callback=f[action](),e=event();if(queued)callback(e);replaceOwner(f,boundary);if(!queued)callback(e);await settle();assert.deepEqual(f.commands,[]);
 if(action==='review')assert.equal(f.instance.review,null);
});
for(const action of ['review','authorize','refresh'])for(const boundary of ['late native veto','detached host'])test(`${action} respects ${boundary}`,async()=>{
 const f=fixture();await f.initial();if(action==='authorize')await f.inspect();const reads=f.reads.length,e=event();f[action]()(e);if(boundary==='late native veto')e.defaultPrevented=true;else e.currentTarget.isConnected=false;await settle();assert.deepEqual(f.commands,[]);assert.equal(f.reads.length,reads);if(action==='review')assert.equal(f.instance.review,null);
});
test('composition ending in the dispatch turn cannot resurrect a canceled review',async()=>{
 const f=fixture();await f.initial();await f.inspect();f.authorize()(event());const [start,end]=f.composition();start();end();await settle();assert.deepEqual(f.commands,[]);assert.equal(f.instance.review,null);await f.inspect();f.authorize()(event());await settle();assert.equal(f.commands.length,1);
});
test('an abandoned composition cannot keep a replacement document controller permanently disabled',async()=>{
 const f=fixture();await f.initial();f.composition()[0]();f.editor.view.document={id:'replacement-document',revision:'1'};await f.instance.sync();f.editor.view.document={id:'document',revision:'1'};await f.instance.sync();await f.inspect();assert.deepEqual(f.commands,[]);f.authorize()(event());await settle();assert.equal(f.commands.length,1);
});
test('refresh removes an old review and its already rendered authorization callback',async()=>{
 const f=fixture();await f.initial();await f.inspect();const old=f.authorize();f.refresh()(event());old(event());await settle();assert.deepEqual(f.commands,[]);assert.equal(f.instance.review,null);
});
test('review details are captured independently of later input object mutations',async()=>{
 const f=fixture();await f.initial();await f.inspect();f.provider.profile.disclosure[0]='Replacement disclosure';f.job.review.prompt.hash='replacement-hash';f.host.requestUpdate();await flush();const card=text(find(f.template(),'<en-card id="provider-dispatch-review"'));assert.match(card,/Retention is provider controlled/);assert(!card.includes('Replacement disclosure'));assert(card.includes(ref.hash));assert(!card.includes('replacement-hash'));assert.deepEqual(f.commands,[]);
});
for(const [name,change]of [
 ['configuration hash',f=>f.provider.configurationHash='replacement-hash'],
 ['writer epoch',f=>f.provider.epoch='replacement-epoch'],
 ['configuration id',f=>f.provider.configurationId='replacement-configuration'],
 ['privacy profile id',f=>f.provider.profile.id='replacement-profile'],
 ['privacy profile version',f=>f.provider.profile.version=2],
 ['privacy disclosure digest',f=>f.provider.profile.disclosureDigest='replacement-disclosure'],
 ['job version',f=>f.job.version='8'],
 ['review token',f=>f.job.review.token='replacement-token'],
 ['attempt id',f=>f.job.attempts[0].id='replacement-attempt'],
])test('authorizing a review refuses changed '+name,async()=>{
 const f=fixture();await f.initial();await f.inspect();const confirm=f.authorize();change(f);confirm(event());await settle();assert.deepEqual(f.commands,[]);
});
for(const [name,change]of [
 ['disabled provider',f=>{f.provider.ready=false;f.provider.mode='disabled';}],
 ['absent profile',f=>f.provider.profile=null],
 ['expired allowance',f=>f.provider.limits.expiresAt='2000-01-01T00:00:00.000Z'],
 ['exhausted requests',f=>f.provider.limits.usedRequests=2],
 ['exhausted images',f=>f.provider.limits.usedImages=2],
 ['canceled local job',f=>f.job.local='locally-cancelled'],
 ['set-aside job',f=>f.job.disposition='set-aside'],
 ['already dispatched attempt',f=>f.job.attempts[0].state='dispatching'],
 ['wrong operation',f=>f.job.review.request.kind='edit'],
 ['wrong dimensions',f=>f.job.review.request.size.width=512],
 ['wrong output count',f=>f.job.review.request.settings.count=2],
 ['wrong format',f=>f.job.review.request.settings.format='jpeg'],
 ['wrong expansion',f=>f.job.review.request.settings.expansion='auto'],
])test('direct invocation of retained confirmation cannot bypass '+name,async()=>{
 const f=fixture();await f.initial();await f.inspect();const confirm=f.authorize();change(f);confirm(event());await settle();assert.deepEqual(f.commands,[]);
});
test('disabled provider never renders a review or confirmation and sync performs reads only',async()=>{
 const f=fixture();Object.assign(f.provider,{mode:'disabled',ready:false,profile:null,limits:null});await f.initial();assert(!find(f.template(),'<en-button ?disabled='));assert(!find(f.template(),'<en-button id="authorize-provider"'));assert.deepEqual(f.commands,[]);assert.deepEqual(f.reads,['/api/v1/provider','/api/v1/queue']);
});
test('authorization failure keeps the exact attempt uncertain without retrying or recreating confirmation',async()=>{
 const f=fixture();await f.initial();await f.inspect();const original=f.editor.commandResult,reads=f.reads.length;f.editor.commandResult=async(...args)=>{await original(...args);throw Error('Connection lost after request');};const confirm=f.authorize();confirm(event());await settle();await settle();confirm(event());await settle();assert.equal(f.commands.length,1);assert.equal(f.reads.length,reads);assert.match(f.text(),/Authorization could not be confirmed/);assert.match(f.text(),/Inspect the durable queue/);assert.equal(f.instance.review,null);
});
test('stale command completion cannot refresh or publish into a replacement owner',async()=>{
 const f=fixture();await f.initial();await f.inspect();const pending=deferred(),original=f.editor.commandResult;f.editor.commandResult=async(...args)=>{await original(...args);return pending.promise;};f.authorize()(event());await settle();assert.equal(f.commands.length,1);replaceOwner(f,'draft owner');await f.instance.sync();const reads=f.reads.length;pending.resolve([]);await settle();assert.equal(f.reads.length,reads);assert(!f.text().includes('Authorization recorded'));assert.equal(f.instance.review,null);
});
test('stale command rejection cannot clear a replacement owner review',async()=>{
 const f=fixture();await f.initial();await f.inspect();const pending=deferred();f.editor.commandResult=()=>pending.promise;f.authorize()(event());await settle();replaceOwner(f,'draft owner');await f.instance.sync();await f.inspect();const review=f.instance.review;pending.reject(Error('Old connection failed'));await settle();assert.equal(f.instance.review,review);assert(!f.text().includes('Old connection failed'));
});
test('older provider read cannot overwrite a later owner and generation',async()=>{
 const f=fixture(),pending=deferred(),read=f.editor.transportJSON;f.editor.transportJSON=path=>path==='/api/v1/provider'?pending.promise:read(path);const first=f.instance.sync();await flush();replaceOwner(f,'session');f.editor.transportJSON=read;await f.instance.sync();const current=f.instance.provider;pending.resolve({...f.provider,message:'Stale provider message'});await first;await flush();assert.equal(f.instance.provider,current);assert(!f.text().includes('Stale provider message'));assert.deepEqual(f.commands,[]);
});
test('a rejected older render cannot discard a newer review after provider refresh',async()=>{
 const f=fixture();await f.initial();const pending=deferred(),requestUpdate=f.host.requestUpdate;let hold=true;
 f.host.requestUpdate=function(){requestUpdate.call(this);if(hold)this.updateComplete=pending.promise;};
 await f.inspect();hold=false;f.refresh()(event());await settle();await f.inspect();const current=f.instance.review;pending.reject(Error('Old render failed'));await settle();assert.equal(f.instance.review,current);assert(!f.text().includes('Old render failed'));assert.deepEqual(f.commands,[]);
});
for(const completion of ['acceptance','rejection'])test('old authorization '+completion+' cannot act after leaving and reopening the same document',async()=>{
 const f=fixture();await f.initial();await f.inspect();const pending=deferred();f.editor.commandResult=()=>pending.promise;f.authorize()(event());await settle();
 f.editor.view.document={id:'other-document',revision:'1'};await f.instance.sync();f.editor.view.document={id:'document',revision:'1'};await f.instance.sync();await f.inspect();const current=f.instance.review,reads=f.reads.length;
 if(completion==='acceptance')pending.resolve([]);else pending.reject(Error('Old authorization failed'));
 await settle();assert.equal(f.reads.length,reads);assert.equal(f.instance.review,current);assert(!f.text().includes('Authorization recorded'));assert(!f.text().includes('Old authorization failed'));
});
test('paid review displays exact retained prompt content and frozen settings',async()=>{
 const f=fixture();await f.initial();await f.inspect();const card=text(find(f.template(),'<en-card id="provider-dispatch-review"'));assert(card.includes(promptText));assert(card.includes(JSON.stringify(f.job.review.request,null,2)));assert.deepEqual(f.commands,[]);assert.equal(f.reads.at(-1),'/api/v1/jobs/retained-job/candidates?attempt=retained-attempt&prompt=requested&offset=0');
});
for(const [name,change]of [
 ['wrong total length',page=>({...page,byteLength:'19'})],
 ['wrong offset',page=>({...page,offset:'1'})],
 ['wrong next page',page=>({...page,nextOffset:'4'})],
 ['nonterminal page without progress',page=>({...page,bytes:'',nextOffset:'0'})],
 ['truncated final bytes',page=>({...page,bytes:Buffer.from('short').toString('base64')})],
 ['oversized page',page=>({...page,bytes:'A'.repeat(44004)})],
 ['invalid base64',page=>({...page,bytes:'***'})],
 ['invalid UTF-8',page=>({...page,bytes:Buffer.concat([Buffer.from([255]),Buffer.alloc(17,32)]).toString('base64')})],
])test('invalid frozen prompt '+name+' leaves no authorization',async()=>{
 const f=fixture();await f.initial();const read=f.editor.transportJSON;f.editor.transportJSON=path=>path.includes('&prompt=requested&')?Promise.resolve(change(promptPage())):read(path);f.review()(event());await settle();assert.equal(f.instance.review,null);assert(!find(f.template(),'<en-button id="authorize-provider"'));assert.deepEqual(f.commands,[]);
});
for(const boundary of ['document','revision','session','identity','connection','draft owner','disposal','readiness','composition'])test('pending frozen prompt cannot authorize across '+boundary,async()=>{
 const f=fixture();await f.initial();const pending=deferred(),read=f.editor.transportJSON;f.editor.transportJSON=path=>path.includes('&prompt=requested&')?pending.promise:read(path);await f.inspect();assert.equal(f.instance.review.prompt,null);assert.equal(f.instance.review.promptLoading,true);const confirm=f.authorize();confirm(event());await settle();assert.deepEqual(f.commands,[]);replaceOwner(f,boundary);pending.resolve(promptPage());await settle();confirm(event());await settle();assert.deepEqual(f.commands,[]);assert(!f.instance.review?.prompt);
});
test('frozen prompt paging performs reads only and preserves the same immutable review',async()=>{
 const f=fixture();f.job.review.prompt.byteLength='6';await f.initial();const read=f.editor.transportJSON;f.editor.transportJSON=path=>path.includes('&prompt=requested&')?Promise.resolve(promptPage(path.endsWith('offset=0')?'one':'two',path.endsWith('offset=0')?'0':'3','6')):read(path);await f.inspect();const review=f.instance.review;assert.equal(review.prompt.text,'one');const next=buttonWithLabel(f.template(),'Next frozen prompt page');assert(next);next(event());await settle();assert.equal(f.instance.review,review);assert.equal(review.prompt.text,'two');assert.equal(review.prompt.offset,'3');assert.deepEqual(f.commands,[]);
});
test('a refused next prompt page preserves the already reviewed page and its exact owner',async()=>{
 const f=fixture();f.job.review.prompt.byteLength='6';await f.initial();const read=f.editor.transportJSON;
 f.editor.transportJSON=path=>path.includes('&prompt=requested&')?Promise.resolve(path.endsWith('offset=0')?promptPage('one','0','6'):{...promptPage('two','3','6'),bytes:'***'}):read(path);
 await f.inspect();const review=f.instance.review,page=review.prompt,ownedPage=f.instance.promptPayload;
 const next=buttonWithLabel(f.template(),'Next frozen prompt page');assert(next);next(event());await settle();
 assert.equal(f.instance.review,review);assert.equal(review.prompt,page);assert.equal(f.instance.promptPayload,ownedPage);assert.equal(page.text,'one');assert.equal(page.next,'3');assert.equal(review.promptLoading,false);assert.match(f.text(),/Frozen prompt page identity/);assert.deepEqual(f.commands,[]);
});
function retainedAuthorization(f,older=false){return {id:'retained-authorization',configurationId:f.provider.configurationId,configurationHash:f.provider.configurationHash,epoch:older?'previous-writer-epoch':f.provider.epoch,jobId:f.job.id,attemptId:f.job.attempts[0].id,reviewToken:f.job.review.token,profileId:f.provider.profile.id,profileVersion:f.provider.profile.version,disclosureDigest:f.provider.profile.disclosureDigest,authorizedAt:'2026-09-30T12:00:00.000Z'};}
test('retained current and earlier-session authorizations disable review and cannot be approved again through its callback',async()=>{
 for(const older of [false,true]){
  const f=fixture(),authorization=retainedAuthorization(f,older);f.job.attempts[0].providerAuthorization=authorization;await f.initial();const publishedAuthorization=f.job.attempts[0].providerAuthorization;assert.deepEqual(publishedAuthorization,authorization);
  assert.equal(find(f.template(),'<en-button ?disabled=').values[0],true);assert.match(f.text(),older?/earlier provider session or configuration/:/already authorized/);
  const reads=f.reads.length;f.review()(event());await settle();assert.deepEqual(f.commands,[]);assert.equal(f.reads.length,reads);assert.equal(f.instance.review,null);assert(!find(f.template(),'<en-button id="authorize-provider"'));assert.equal(f.job.attempts[0].providerAuthorization,publishedAuthorization);
  if(older)assert.match(f.text(),/Cancel this unstarted job locally, then prepare and enqueue a fresh request/);
 }
});
test('authorization arriving after confirmation is scheduled cannot be overwritten or reused for another authorization',async()=>{
 for(const older of [false,true]){
  const f=fixture();await f.initial();await f.inspect();const confirm=f.authorize(),reads=f.reads.length;confirm(event());
  const authorization=retainedAuthorization(f,older);f.job.attempts[0].providerAuthorization=authorization;await settle();
  assert.deepEqual(f.commands,[]);assert.equal(f.reads.length,reads);assert.equal(f.instance.review,null);assert.equal(f.job.attempts[0].providerAuthorization,authorization);assert.match(f.text(),/job changed/);
  f.refresh()(event());await settle();const refreshedAuthorization=f.job.attempts[0].providerAuthorization;assert.deepEqual(refreshedAuthorization,authorization);confirm(event());f.review()(event());await settle();assert.deepEqual(f.commands,[]);assert.equal(f.instance.review,null);assert.equal(f.job.attempts[0].providerAuthorization,refreshedAuthorization);assert.match(f.text(),older?/earlier provider session or configuration/:/already authorized/);
 }
});
