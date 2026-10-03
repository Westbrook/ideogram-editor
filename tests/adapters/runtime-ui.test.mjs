import {readStagedSource} from '../adapter-upload-module.mjs';
import {adapterUploadURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import {allocationsURL,modelMemoryURL,uiModelOwnerURL,ownFixtureJSON} from '../ui-model-module.mjs';
import assert from 'node:assert/strict';
import {transformWithOxc} from 'vite';
import {hash,newDraft,resolve,routes,runtimeAdaptersVerified} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

// Synthetic metadata exercises matching only. No provider request, model
// compatibility claim, or production profile qualification is made here.
const H=char=>'sha256:'+char.repeat(64),operation='generate-adapters';
const uses=()=>[{version:'version_a',hash:H('a'),scale:'0'},{version:'version_b',hash:H('b'),scale:'1.50'}];
const currentProfile=()=>({id:'synthetic-scope-matcher-profile',version:1,evidenceDigest:'c'.repeat(64),endpoint:routes[operation].endpoint});
function context(selected=uses()){
 const profile=currentProfile(),scope={kind:'adapter-runtime-scope-1',...routes[operation],routeHash:hash(canonical(routes[operation])),profile,adapters:selected.map((a,index)=>({version:a.version,weightsHash:a.hash,configHash:index===0?null:H('d'),scale:Number(a.scale)}))};
 const record={kind:'adapter-runtime-evidence-1',scope,jobId:'job',attemptId:'attempt',requestId:'request',candidateId:'candidate',outputAssetId:'output',outputHash:H('e'),observationHash:H('f')};
 const eligibility={adapters:new Map(selected.map((a,index)=>[a.version,{hash:a.hash,available:true,profile:'v4-safe-1',runtimeVerified:true,configHash:scope.adapters[index].configHash,runtimeProfile:structuredClone(profile),runtimeEvidence:[structuredClone(record)]}]))};
 return {selected,scope,record,eligibility};
}
function draft(selected){const d=newDraft({hash:hash('an image'),byteLength:'8',mediaType:'text/plain'});d.operation=operation;d.adapters=selected;return d;}
const ackFailure=work=>assert.throws(work,error=>error.issues?.some(issue=>issue.code==='ADAPTER_RUNTIME_ACK_REQUIRED'));

test('a display-only runtime flag never waives uncertainty acknowledgement',()=>{
 const f=context();for(const entry of f.eligibility.adapters.values()){delete entry.runtimeProfile;delete entry.runtimeEvidence;delete entry.configHash;}
 assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),false);ackFailure(()=>resolve(draft(f.selected),'an image',f.eligibility));
 const acknowledged=f.selected.map(a=>({...a,runtimeAcknowledged:true}));assert.equal(resolve(draft(acknowledged),'an image',f.eligibility).kind,operation);
});
test('one exact current-profile observation matches the complete numeric stack and preserves scale zero',()=>{
 const f=context();assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),true);const request=resolve(draft(f.selected),'an image',f.eligibility);assert.equal(request.adapters[0].scale,'0');assert.equal(request.adapters[1].scale,'1.50');assert(request.adapters.every(a=>a.runtimeAcknowledged===undefined));
 const equivalent=f.selected.map(a=>({...a,scale:a.scale==='0'?'0.00':'1.5'}));assert.equal(runtimeAdaptersVerified(operation,equivalent,f.eligibility),true);
});
for(const boundary of ['endpoint','schema','route','profile-id','profile-version','profile-evidence','weights','config','order','subset','superset','scale','missing-config','missing-current-profile','different-current-profiles'])test('recorded runtime evidence cannot cross '+boundary,()=>{
 const f=context();let selected=f.selected,op=operation;
 if(boundary==='endpoint')op='transform-adapters';
 if(['schema','route'].includes(boundary))for(const entry of f.eligibility.adapters.values())entry.runtimeEvidence[0].scope[boundary==='schema'?'schemaHash':'routeHash']=H('0');
 if(['profile-id','profile-version','profile-evidence'].includes(boundary))for(const entry of f.eligibility.adapters.values()){const p=entry.runtimeProfile;if(boundary==='profile-id')p.id='new-profile';if(boundary==='profile-version')p.version=2;if(boundary==='profile-evidence')p.evidenceDigest='0'.repeat(64);}
 if(boundary==='weights'){selected=selected.map((a,i)=>i===0?{...a,hash:H('0')}:a);f.eligibility.adapters.get('version_a').hash=H('0');}
 if(boundary==='config')f.eligibility.adapters.get('version_a').configHash=H('0');
 if(boundary==='order')selected=[...selected].reverse();
 if(boundary==='subset')selected=selected.slice(0,1);
 if(boundary==='superset'){selected=[...selected,{version:'version_c',hash:H('0'),scale:'1'}];f.eligibility.adapters.set('version_c',{...f.eligibility.adapters.get('version_a'),hash:H('0')});}
 if(boundary==='scale')selected=selected.map((a,i)=>i===0?{...a,scale:'1'}:a);
 if(boundary==='missing-config')delete f.eligibility.adapters.get('version_a').configHash;
 if(boundary==='missing-current-profile')for(const entry of f.eligibility.adapters.values())entry.runtimeProfile=null;
 if(boundary==='different-current-profiles')f.eligibility.adapters.get('version_a').runtimeProfile.version=2;
 assert.equal(runtimeAdaptersVerified(op,selected,f.eligibility),false);
 if(op===operation)ackFailure(()=>resolve(draft(selected),'an image',f.eligibility));
});
test('successful singleton observations cannot be combined into evidence for an unobserved stack',()=>{
 const f=context();for(const [index,entry] of [...f.eligibility.adapters.values()].entries())entry.runtimeEvidence[0].scope.adapters=[entry.runtimeEvidence[0].scope.adapters[index]];
 assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),false);ackFailure(()=>resolve(draft(f.selected),'an image',f.eligibility));
});
test('malformed, excessive or unavailable evidence cannot become a waiver',()=>{
 for(const kind of ['malformed','excessive','unavailable','wrong-local-profile']){const f=context();for(const entry of f.eligibility.adapters.values()){if(kind==='malformed')entry.runtimeEvidence[0].observationHash='invalid';if(kind==='excessive')entry.runtimeEvidence=Array.from({length:5},()=>structuredClone(f.record));if(kind==='unavailable')entry.available=false;if(kind==='wrong-local-profile')entry.profile='unverified';}assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),false,kind);}
});
test('a Generate-only production profile cannot qualify any direct LoRA route',()=>{const f=context();for(const entry of f.eligibility.adapters.values())entry.runtimeProfile={...entry.runtimeProfile,endpoint:'ideogram/v4'};assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),false);ackFailure(()=>resolve(draft(f.selected),'an image',f.eligibility));});

const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const controls=data((await transformWithOxc(await readStagedSource('src/ui/adapters.ts'),'adapters.ts')).code);
const profileModule=data((await transformWithOxc(await readStagedSource('src/adapters/profile.ts'),'profile.ts')).code);
let ui=(await transformWithOxc(await readStagedSource('src/ui/adapter-library.ts'),'adapter-library.ts')).code;
for(const [name,url] of [['../observability/adapter-upload.js',adapterUploadURL],['lit',lit],['./adapters.js',controls],['./model-owner.js',uiModelOwnerURL],['../observability/model-memory.js',modelMemoryURL],['../adapters/profile.js',profileModule]])ui=ui.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
const {AdapterLibraryEditing}=await import(data(ui));
const {allocationLedger}=await import(allocationsURL);
const openViews=new Set();let baseline;
const usage=()=>{const s=allocationLedger.snapshot();return Object.fromEntries(['cpuBytes','promptBytes','handles','activeRecords'].map(key=>[key,s[key]]));};
test.beforeEach(()=>{baseline=usage();});
test.afterEach(async()=>{for(const view of openViews){await view.controller.dispose();await view.host.updateComplete;assert.deepEqual(view.controller.lifecycle,{models:0,reads:0,pending:0,cleanupFailures:0});}openViews.clear();assert.deepEqual(usage(),baseline);});
function text(template){if(template==null)return '';if(typeof template!=='object')return String(template);if(Array.isArray(template))return template.map(text).join(' ');return (template.strings??[]).map((s,i)=>s+text(template.values[i])).join('');}
function find(template,part){if(!template||typeof template!=='object')return;if(template.strings){const i=template.strings.findIndex(s=>s.includes(part));if(i>=0)return template.values.slice(i).find(v=>typeof v==='function');const id=/^id="([^"]+)"$/.exec(part)?.[1],bound=id===undefined?-1:template.values.findIndex((value,index)=>value===id&&template.strings[index].endsWith(' id='));if(bound>=0)return template.values.slice(bound+1).find(v=>typeof v==='function');}for(const child of Array.isArray(template)?template:template.values??[]){const result=find(child,part);if(result)return result;}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function library(f){
 const rows=f.selected.map((a,index)=>({versionId:a.version,adapterId:'adapter_'+index,version:'1',name:'Adapter '+index,declaredFamily:'ideogram-v4',declaredFormat:'fal',qualification:'structurally-valid',available:true,weights:{hash:a.hash,byteLength:'24',mediaType:'application/octet-stream'},config:index?{hash:H('d'),byteLength:'2',mediaType:'text/plain'}:null,origin:'import',profileId:'v4-fal-public-example-1',locallyEligible:true,runtimeVerified:true,reason:'Scoped observation retained.',runtimeProfile:f.eligibility.adapters.get(a.version).runtimeProfile,runtimeEvidence:f.eligibility.adapters.get(a.version).runtimeEvidence}));
 let template,controller,identity='client';const requests=[],changes=[],editor={view:{ready:true,document:{id:'doc',revision:'1'}},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map()},json:async path=>{requests.push(path);return path==='/api/v1/adapters'?{protocolVersion:1,items:rows,nextAfter:null}:rows.find(row=>path.endsWith('/'+row.versionId));}};
 const render=()=>template=controller.render(f.selected,next=>changes.push(next));const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve().then(render);},querySelector(){return {focus(){}};}};controller=new AdapterLibraryEditing(host,ownFixtureJSON(editor));render();
 const view={controller,editor,host,rows,requests,changes,render,template:()=>template,identity:value=>identity=value,async drain(){await tick();while(controller.lifecycle.pending)await Promise.allSettled([...controller.models.pending]);await host.updateComplete;}};openViews.add(view);return view;
}
test('UI forwards exact metadata without using global runtime summary as a waiver',async()=>{
 const f=context(),view=library(f);for(const row of view.rows)row.runtimeProfile=null;
 const e=await view.controller.eligibility(f.selected);assert.equal(e.adapters.get('version_a').runtimeVerified,true);assert.equal(e.adapters.get('version_b').configHash,H('d'));assert.equal(e.adapters.get('version_a').runtimeProfile,null);assert.equal(runtimeAdaptersVerified(operation,f.selected,e),false);assert.deepEqual(view.changes,[]);
});
test('missing config metadata cannot be treated as an authoritative no-config identity',async()=>{const f=context(),view=library(f);delete view.rows[0].config;const e=await view.controller.eligibility(f.selected);assert.equal(e.adapters.get('version_a').configHash,undefined);assert.equal(runtimeAdaptersVerified(operation,f.selected,e),false);});
test('library discloses the exact recorded endpoint, profile, run and whole stack without changing acknowledgement',async()=>{
 const f=context(),view=library(f),callback=find(view.template(),'id="search-adapter-library"'),host={isConnected:true};callback({currentTarget:host,composedPath:()=>[host],defaultPrevented:false});await view.drain();
 const visible=text(view.template());assert.equal(view.rows[0].config,null);assert.equal(f.record.scope.adapters[0].configHash,null);assert.equal(runtimeAdaptersVerified(operation,f.selected,f.eligibility),true);assert.equal(resolve(draft(f.selected),'an image',f.eligibility).kind,operation);assert(!visible.includes('id="request-adapter-ack-error"'),'A whole-stack runtime waiver creates no acknowledgement error for unchecked controls');assert(visible.includes('Runtime verified for recorded scopes'));assert(visible.includes('Config not supplied'));assert(!visible.includes('Config not supplied; V4 compatibility not runtime verified'));for(const value of [f.scope.endpoint,f.scope.schemaHash,f.scope.routeHash,f.scope.profile.id,f.scope.profile.evidenceDigest,'Job job','attempt attempt','version_a','version_b','scale 0','scale 1.5','do not establish image quality'])assert(visible.includes(value),value);assert.deepEqual(view.changes,[]);assert(f.selected.every(a=>a.runtimeAcknowledged===undefined));
});
test('late eligibility metadata cannot escape the original UI owner',async()=>{const f=context(),view=library(f);let release,entered;const started=new Promise(resolve=>entered=resolve);view.editor.json=()=>new Promise(resolve=>{release=resolve;entered();});const pending=view.controller.eligibility(f.selected);await started;view.identity('other');release(view.rows[0]);await assert.rejects(pending,/selection changed/);});

test('eligibility owns detached scoped evidence after each response model is released',async()=>{
 const f=context(),view=library(f),read=view.editor.ownedJSON,released=[];
 view.editor.ownedJSON=async(...args)=>{const model=await read(...args);return {...model,release(){released.push(model.value);model.release();model.value.runtimeProfile.version=999;model.value.runtimeEvidence[0].scope.adapters[0].scale=4;}};};
 const e=await view.controller.eligibility(f.selected);assert.equal(released.length,2);assert.equal(runtimeAdaptersVerified(operation,f.selected,e),true);
 for(const [index,entry] of [...e.adapters.values()].entries()){assert.notEqual(entry.runtimeProfile,released[index].runtimeProfile);assert.notEqual(entry.runtimeEvidence,released[index].runtimeEvidence);assert.equal(entry.runtimeProfile.version,1);assert.equal(entry.runtimeEvidence[0].scope.adapters[0].scale,0);}
 await view.controller.releaseDocument();await view.host.updateComplete;assert.equal(view.controller.lifecycle.models,0);
});
test('oversized scoped evidence cannot exceed the existing eligibility workspace',async()=>{
 const f=context(),view=library(f);view.rows[0].runtimeEvidence=Array.from({length:4},()=>{const record=structuredClone(f.record);record.requestId='x'.repeat(8192);return record;});
 await assert.rejects(view.controller.eligibility(f.selected),/UI_MODEL_LIMIT/);assert.equal(view.controller.lifecycle.models,0);assert.deepEqual(view.changes,[]);
});
