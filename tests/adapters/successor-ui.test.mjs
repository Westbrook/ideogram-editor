import {stagedModuleURL} from '../adapter-upload-module.mjs';
import {adapterUploadURL} from '../owned-preview-module.mjs';
import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,modelMemoryURL,ownFixtureJSON,uiModule,uiModelOwnerURL} from '../ui-model-module.mjs';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const controls=await uiModule('src/ui/adapters.ts'),profile=await uiModule('src/adapters/profile.ts');
const {AdapterLibraryEditing,replaceAdapterVersion}=await import(await stagedModuleURL('src/ui/adapter-library.ts',{'../observability/adapter-upload.js':adapterUploadURL,'lit':lit,'./adapters.js':controls,'./model-owner.js':uiModelOwnerURL,'../adapters/profile.js':profile,'../observability/model-memory.js':modelMemoryURL}));
const hash='sha256:'+'1'.repeat(64),newHash='sha256:'+'2'.repeat(64);
const entry=(patch={})=>({versionId:'v1',adapterId:'family_1',version:'1',name:'Exact adapter',declaredFamily:'ideogram-v4',declaredFormat:'fal',qualification:'structurally-valid',available:true,weights:{hash,byteLength:'24',mediaType:'application/octet-stream'},config:null,profileId:'v4-fal-public-example-1',runtimeVerified:false,locallyEligible:true,reason:'Supported exact fixture',...patch});
const update=(patch={})=>({protocolVersion:1,current:entry(),latest:entry({versionId:'v2',version:'2',weights:{hash:newHash,byteLength:'28',mediaType:'application/octet-stream'}}),...patch});
const original=()=>[{version:'v1',hash,scale:'0',runtimeAcknowledged:true}];
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(initial=original()){
 let selected=initial,identity='client',response=update(),readOverride=null,rejectChange=false;const reads=[],changes=[],commands=[],focuses=[];
 const editor=ownFixtureJSON({view:{ready:true,document:{id:'doc',revision:'1'}},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map()},
  async json(path){reads.push(path);return readOverride?readOverride(path):structuredClone(response);},async command(body){commands.push(body);throw Error('Unexpected durable command');}});
 const host={updateComplete:Promise.resolve(true),requestUpdate(){this.updateComplete=Promise.resolve(true);},querySelector(selector){return {focus(){focuses.push(selector);}};}};
 const controller=new AdapterLibraryEditing(host,ownFixtureCommands(editor)),change=next=>{if(rejectChange)throw Error('Parent request admission refused');selected=next;changes.push(next);};
 const render=()=>controller.render(selected,change);render();
 return {controller,editor,host,reads,changes,commands,focuses,render,selected:()=>selected,setSelected(value){selected=value;render();},response(value){response=value;},read(fn){readOverride=fn;},identity(value){identity=value;},rejectChange(value){rejectChange=value;},
  run(work){return controller.models.run(work);},async close(){await controller.dispose();}};
}

test('replacement changes one exact attachment, preserves order and zero scale, and resets only its runtime acknowledgement',()=>{
 const before=[{version:'other',hash,scale:'2',runtimeAcknowledged:true},...original(),{version:'third',hash,scale:'4'}],retained=structuredClone(before),next=replaceAdapterVersion(before,1,update());
 assert.deepEqual(before,retained);assert.deepEqual(next,[before[0],{version:'v2',hash:newHash,scale:'0'},before[2]]);assert.notEqual(next[0],before[0]);assert.notEqual(next[2],before[2]);
 for(const changed of [{latest:entry({versionId:'v2',version:'2',available:false})},{latest:entry({versionId:'v2',version:'2',locallyEligible:false})},{latest:entry({versionId:'v2',version:'2',profileId:'unknown'})},{latest:entry({versionId:'v2',version:'2',adapterId:'other'})},{latest:entry({versionId:'v2',version:'1'})},{current:entry({weights:{hash:newHash,byteLength:'24',mediaType:'application/octet-stream'}})}])assert.throws(()=>replaceAdapterVersion(original(),0,update(changed)));
 assert.throws(()=>replaceAdapterVersion([...original(),{version:'v2',hash:newHash,scale:'1'}],0,update()),/already attached/);
});

test('update discovery and review retain the old draft until exact explicit confirmation',async()=>{
 const baseline=totals(),f=fixture(),old=f.selected(),acceptedJob={request:{adapters:structuredClone(old)}};
 try{
  await f.run(()=>f.controller.checkUpdates(()=>true));assert.equal(f.selected(),old);assert.equal(f.changes.length,0);assert.equal(f.controller.updates[0].latest.versionId,'v2');
  await f.run(()=>f.controller.previewReplacement(0,()=>true));assert.equal(f.selected(),old);assert.equal(f.focuses.at(-1),'#adapter-replacement-review');const review=f.controller.replacement;
  await f.run(()=>f.controller.confirmReplacement(review,f.controller.capture(),()=>true));assert.deepEqual(f.selected(),[{version:'v2',hash:newHash,scale:'0'}]);assert.deepEqual(acceptedJob.request.adapters,old);assert.equal(f.controller.replacement,null);assert.equal(f.commands.length,0);assert.equal(f.changes.length,1);
 }finally{await f.close();}assert.deepEqual(totals(),baseline);
});

test('changed selection or parent admission refusal cannot partially publish replacement',async()=>{
 const baseline=totals(),f=fixture();
 try{
  await f.run(()=>f.controller.previewReplacement(0,()=>true));const review=f.controller.replacement,prior=f.selected();f.rejectChange(true);
  await assert.rejects(f.run(()=>f.controller.confirmReplacement(review,f.controller.capture(),()=>true)),/Parent request admission refused/);assert.equal(f.selected(),prior);assert.equal(f.controller.selected,prior);assert.equal(f.controller.replacement,review);
  f.rejectChange(false);f.setSelected([{...prior[0],scale:'2'}]);const reads=f.reads.length;await f.run(()=>f.controller.confirmReplacement(review,f.controller.capture(),()=>true));assert.equal(f.reads.length,reads);assert.equal(f.selected()[0].version,'v1');assert.equal(f.selected()[0].scale,'2');
 }finally{await f.close();}assert.deepEqual(totals(),baseline);
});

for(const successor of [null,entry({versionId:'v2',version:'2',available:false}),entry({versionId:'v3',version:'3'})])test('fresh confirmation refuses changed successor metadata '+(successor?.versionId??'none'),async()=>{
 const baseline=totals(),f=fixture();try{await f.run(()=>f.controller.previewReplacement(0,()=>true));const review=f.controller.replacement,old=f.selected();f.response(update({latest:successor}));await assert.rejects(f.run(()=>f.controller.confirmReplacement(review,f.controller.capture(),()=>true)),/changed/);assert.equal(f.selected(),old);assert.equal(f.changes.length,0);}finally{await f.close();}assert.deepEqual(totals(),baseline);
});

for(const boundary of ['identity','document','revision','session','draft-owner','selection'])test('late replacement lookup is fenced by '+boundary,async()=>{
 const baseline=totals(),f=fixture(),gate=deferred();
 try{
  f.read(()=>gate.promise);const old=f.selected(),pending=f.run(()=>f.controller.previewReplacement(0,()=>true));await turn();
  if(boundary==='identity')f.identity('other');if(boundary==='document')f.editor.view.document={id:'other',revision:'1'};if(boundary==='revision')f.editor.view.document.revision='2';if(boundary==='session')f.editor.sessionId='other';if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='selection')f.setSelected([{...old[0],scale:'2'}]);
  // The public action supplies the captured owner predicate; a selected-array
  // change is additionally checked by the replacement controller itself.
  if(boundary!=='selection')f.controller.render(f.selected(),()=>{});
  gate.resolve(update());await assert.rejects(pending,{name:'AbortError'});assert.equal(f.controller.replacement,null);assert.equal(f.changes.length,0);
 }finally{gate.resolve(update());await f.close();}assert.deepEqual(totals(),baseline);
});

test('pressure refuses before update transport and keeps the prior review unchanged',async()=>{
 const baseline=totals(),f=fixture();let pressure;
 try{await f.run(()=>f.controller.previewReplacement(0,()=>true));const review=f.controller.replacement,old=f.selected(),reads=f.reads.length;pressure=allocationLedger.reserve({owner:'adapter-successor-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});await assert.rejects(f.run(()=>f.controller.checkUpdates(()=>true)),/ALLOCATION_BUDGET/);assert.equal(f.reads.length,reads);assert.equal(f.controller.replacement,review);assert.equal(f.selected(),old);}finally{pressure?.release();await f.close();}assert.deepEqual(totals(),baseline);
});

for(const count of [1,2])test('aggregate logical update payload is refused before cloning beyond its admitted workspace: '+count,async()=>{
 const baseline=totals(),f=fixture(count===1?original():[...original(),{version:'other',hash,scale:'1'}]),clone=globalThis.structuredClone;let copied=0;
 try{
  await f.run(()=>f.controller.previewReplacement(0,()=>true));const review=f.controller.replacement,old=f.selected();
  f.read(path=>update({current:entry({versionId:path.includes('/other/')?'other':'v1'}),padding:Array(count===1?25000:14000).fill(0)}));
  globalThis.structuredClone=(value,...options)=>{if(value?.padding)copied++;return clone(value,...options);};
  await assert.rejects(f.run(()=>f.controller.checkUpdates(()=>true)),/UI_MODEL_LIMIT/);assert.equal(copied,count-1);assert.equal(f.controller.replacement,review);assert.equal(f.selected(),old);assert.equal(f.changes.length,0);
 }finally{globalThis.structuredClone=clone;await f.close();}assert.deepEqual(totals(),baseline);
});

test('freshness compares exact metadata structurally regardless of JSON object key order',async()=>{
 const baseline=totals(),f=fixture();
 try{
  await f.run(()=>f.controller.previewReplacement(0,()=>true));const review=f.controller.replacement,prior=review.update;
  const reverse=value=>Object.fromEntries(Object.entries(value).reverse());f.response({latest:reverse(prior.latest),current:reverse(prior.current),protocolVersion:1});
  await f.run(()=>f.controller.confirmReplacement(review,f.controller.capture(),()=>true));assert.equal(f.selected()[0].version,'v2');assert.equal(f.changes.length,1);
 }finally{await f.close();}assert.deepEqual(totals(),baseline);
});

test('job update inspection owns only a bounded snapshot and never changes frozen provenance',async()=>{
 const baseline=totals(),f=fixture(),job={id:'job',version:'1',uses:original()},before=structuredClone(job);let current=job;
 try{await f.run(()=>f.controller.inspectJobUpdates(job.id,job.version,(id,version)=>current?.id===id&&current.version===version?current.uses:null,()=>true));assert.deepEqual(job,before);assert.deepEqual(f.controller.jobUpdates.uses,job.uses);assert.notEqual(f.controller.jobUpdates.uses,job.uses);assert.equal(f.controller.jobUpdates.updates[0].latest.versionId,'v2');assert.equal(f.changes.length,0);assert.equal(f.commands.length,0);
  const gate=deferred();f.read(()=>gate.promise);const prior=f.controller.jobUpdates,pending=f.run(()=>f.controller.inspectJobUpdates('job','1',(id,version)=>current?.id===id&&current.version===version?current.uses:null,()=>true));await turn();current=null;gate.resolve(update());await assert.rejects(pending,{name:'AbortError'});assert.equal(f.controller.jobUpdates,prior);
 }finally{await f.close();}assert.deepEqual(totals(),baseline);
});
