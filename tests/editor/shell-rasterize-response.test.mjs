import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';

const root=process.env.SHELL_RASTERIZE_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const memoryURL=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const renderURL=await moduleURL('src/ui/render-models.ts',{'../observability/allocations.js':allocationsURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{cloneOwnedModel,readOwnedJSON}=await import(memoryURL),{RenderModelOwners}=await import(renderURL);
// Compile the actual shell class; bypass browser-only constructor fields.
// The shell methods, reader, cloned models and render pins remain real.
const source=await readFile(root+'/src/ui/shell.ts','utf8'),compiled=(await transformWithOxc(source,'shell.ts')).code;
const body=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const allowance=source.match(/const RASTERIZE_REVIEW_BYTES=([^;]+);/)[1];
const shellModule=await import(data(`import {createOwnedModel,reserveModelBytes,modelPayloadBytes} from ${JSON.stringify(memoryURL)};
class LitElement{};let editor;const RASTERIZE_REVIEW_BYTES=${allowance};
export function bind(value){editor=value;}
${body}
export {EditorShell};`));
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,gpu:s.gpuBytes,handles:s.handles,records:s.activeRecords};};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const response=value=>{const text=JSON.stringify(value);return new Response(text,{headers:{'content-length':String(Buffer.byteLength(text)),'content-type':'application/json'}});};
const alive=model=>{const release=model.pin();release();},released=model=>assert.throws(()=>model.pin(),/MODEL_MEMORY_RELEASED/);
function fixture(options={}){
 const before=totals(),fields=cloneOwnedModel('fixture-inspector',{document:{id:'document',revision:'7'},layer:{id:'layer',version:'4',kind:'text',locked:false,name:'Editable name',assetId:'asset'},values:{}}),renders=new RenderModelOwners(),panel=deferred(),commit=deferred(),command=deferred();
 const connection={identity:()=> 'client'},started=[];let updates=0,shown=0,responseOwner,commandBody;
 const shell=Object.create(shellModule.EditorShell.prototype);
 const editor={session:connection,sessionId:'ui',documentEpoch:1,view:{document:fields.value.document},async withJSON(path,owner,work,init,owns,maxBytes){assert.equal(maxBytes,65536);responseOwner=await readOwnedJSON(async()=>response(options.response??{source:{render:{id:'render-accepted'}}}),path,{owner,init,owns,maxBytes});try{options.beforeWork?.();return await work(responseOwner.value);}finally{responseOwner.release();}},async withCommandEvents(body,consume){commandBody=body;await command.promise;return consume([]);}};
 Object.assign(shell,{fieldsOwner:fields,inspectorFieldsGeneration:1,copyPanelEpoch:0,panel:null,lifecycle:new AbortController(),panels:()=>options.deferPanel?panel.promise:Promise.resolve(),updateComplete:options.deferCommit?commit.promise:Promise.resolve(),requestUpdate(){updates++;},querySelector(){return {show(){shown++;}};}});shellModule.bind(editor);
 const start=()=>{const task=shell.reviewTextRasterOwned();started.push(task);void task.catch(()=>{});return task;};
 return {before,fields,shell,editor,renders,panel,commit,command,start,get shown(){return shown;},get updates(){return updates;},get responseOwner(){return responseOwner;},get commandBody(){return commandBody;},async cleanup(){panel.resolve();commit.resolve();command.resolve();await Promise.allSettled(started);shell.setRasterizeReview();shell.setFields();renders.clear();assert.deepEqual(totals(),before);}};
}

test('actual raster review scopes response and independently owns the accepted render identity',async()=>{
 const f=fixture();try{await f.start();const review=f.shell.rasterizeOwner;assert.equal(review.value.render,'render-accepted');assert.equal(review.value.layer.name,'Editable name');assert.notEqual(review.value.document,f.fields.value.document);assert.notEqual(review.value.layer,f.fields.value.layer);released(f.responseOwner);f.fields.value.layer.name='Later local field';assert.equal(review.value.layer.name,'Editable name');assert.equal(f.shown,1);alive(review);}finally{await f.cleanup();}
});
test('adopted review lives through actual render retirement after the panel closes',async()=>{
 const f=fixture();try{await f.start();const model=f.shell.rasterizeOwner;f.renders.begin([model]);f.renders.commit();f.shell.closePanel();assert.equal(f.shell.rasterizeReview,null);alive(model);f.renders.begin([]);alive(model);f.renders.commit();released(model);}finally{await f.cleanup();}
});
test('an in-flight Apply pins the review after close and render retirement until command settlement',async()=>{
 const f=fixture();let applying;try{await f.start();const model=f.shell.rasterizeOwner;f.renders.begin([model]);f.renders.commit();applying=f.shell.applyTextRasterOwned();void applying.catch(()=>{});assert.equal(f.commandBody.reviewedRender,'render-accepted');f.shell.closePanel();f.renders.begin([]);f.renders.commit();alive(model);f.command.resolve();await applying;released(model);}finally{f.command.resolve();await applying?.catch(()=>{});await f.cleanup();}
});
for(const change of ['close','session','identity','document-epoch'])test('stale raster review '+change+' cannot publish after awaited panels',async()=>{
 const f=fixture({deferPanel:true});try{const work=f.start();while(!f.responseOwner)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));if(change==='close')f.shell.closePanel();else if(change==='session')f.editor.sessionId='replacement';else if(change==='identity')f.editor.session={identity:()=> 'replacement'};else f.editor.documentEpoch++;f.panel.resolve();await assert.rejects(work,/Text changed/);assert.equal(f.shell.rasterizeReview,null);assert.equal(f.shown,0);released(f.responseOwner);}finally{await f.cleanup();}
});
test('prospective review-model refusal preserves the previous admitted review',async()=>{
 let pressure;const f=fixture({beforeWork(){if(!f.shell.rasterizeOwner)return;const s=allocationLedger.snapshot();pressure=allocationLedger.reserve({owner:'fixture-rasterize-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(s.cpuBytes-s.text.ownedReservationBytes)-1});}});
 try{await f.start();const prior=f.shell.rasterizeOwner;await assert.rejects(f.start(),/ALLOCATION_BUDGET/);assert.equal(f.shell.rasterizeOwner,prior);alive(prior);released(f.responseOwner);}finally{pressure?.release();await f.cleanup();}
});
test('invalid returned render identity refuses before replacing review state',async()=>{
 const f=fixture({response:{source:{render:{id:'invalid/slash'}}}});try{await assert.rejects(f.start(),/Text render is unavailable/);assert.equal(f.shell.rasterizeReview,null);released(f.responseOwner);}finally{await f.cleanup();}
});
test('failed host commit keeps an admitted review until actual render roots can be cleared',async()=>{
 const f=fixture({deferCommit:true});try{const work=f.start();while(!f.shell.rasterizeOwner)await new Promise(resolve=>setImmediate(resolve));const model=f.shell.rasterizeOwner;f.renders.begin([model]);f.commit.reject(Error('HOST_COMMIT_FAILED'));await assert.rejects(work,/HOST_COMMIT_FAILED/);f.shell.closePanel();alive(model);f.renders.clear();released(model);}finally{await f.cleanup();}
});

test('oversized layer metadata refuses before cloning and preserves the previous review',async t=>{
 const f=fixture();try{await f.start();const prior=f.shell.rasterizeOwner,fields=cloneOwnedModel('fixture-large-inspector',{...f.fields.value,layer:{...f.fields.value.layer,name:'x'.repeat(33*1024)}});f.shell.setFields(fields);let reviewClones=0;const clone=structuredClone;t.mock.method(globalThis,'structuredClone',(value,...options)=>{if(value&&typeof value==='object'&&'render'in value&&'document'in value&&'layer'in value)reviewClones++;return clone(value,...options);});
 await assert.rejects(f.start(),/review metadata is too large/);assert.equal(reviewClones,0,'The actual oversized review is rejected before native structuredClone');assert.equal(f.shell.rasterizeOwner,prior);alive(prior);released(f.responseOwner);
 }finally{await f.cleanup();}
});
