import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {viewModelDependencies} from '../view-model-module.mjs';
import {allocationsURL as allocations,promptMemoryURL as prompt} from '../owned-preview-module.mjs';
const root=process.env.CLIENT_RENDER_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [key,value]of Object.entries(imports))code=code.replaceAll(JSON.stringify(key),JSON.stringify(value)).replaceAll("'"+key+"'",JSON.stringify(value));return data(code);}
const memory=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocations,'./prompt-memory.js':prompt}),owners=await moduleURL(root+'/src/ui/render-models.ts',{'../observability/allocations.js':allocations});
const {allocationLedger}=await import(allocations),{cloneOwnedModel}=await import(memory),{RenderModelOwners,RENDER_MODEL_LIMIT}=await import(owners);
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
test('template scalar aliases keep their actual model until the next successful commit',()=>{
 const before=totals(),owner=new RenderModelOwners(),first=cloneOwnedModel('render-test',{name:'old literal'}),second=cloneOwnedModel('render-test',{name:'new literal'});owner.begin([first]);owner.commit();first.release();owner.begin([second]);second.release();assert.equal(owner.ownership.roots,2);assert.equal(owner.ownership.pending,true);owner.commit();assert.equal(owner.ownership.roots,1);owner.clear();assert.deepEqual(totals(),before);
});
test('failed rendering retains attempted roots and a successful retry retires all old aliases',()=>{
 const before=totals(),owner=new RenderModelOwners();for(let i=0;i<3;i++){const model=cloneOwnedModel('render-test',{name:String(i)});owner.begin([model]);model.release();if(i===0)owner.commit();}assert.equal(owner.ownership.roots,3);owner.commit();assert.equal(owner.ownership.roots,1);owner.clear();assert.deepEqual(totals(),before);
});
test('render pin admission failure preserves the preceding render and rolls back partial pins',()=>{
 const before=totals(),owner=new RenderModelOwners(),prior=cloneOwnedModel('render-test',{name:'prior'}),next=cloneOwnedModel('render-test',{name:'next'});owner.begin([prior]);owner.commit();prior.release();assert.throws(()=>owner.begin([next,{value:{},pin(){throw Error('unowned');}}]),/unowned/);next.release();assert.equal(owner.ownership.roots,1);assert.equal(owner.ownership.pending,false);owner.clear();assert.deepEqual(totals(),before);
});
test('failed render attempts have an explicit root-count cap and can be cleared for retry',()=>{
 const before=totals(),owner=new RenderModelOwners();for(let i=0;i<RENDER_MODEL_LIMIT;i++){const model=cloneOwnedModel('render-test',{name:String(i)});owner.begin([model]);model.release();}const refused=cloneOwnedModel('render-test',{name:'refused'});assert.throws(()=>owner.begin([refused]),/previous editor render/);refused.release();assert.equal(owner.ownership.roots,RENDER_MODEL_LIMIT);owner.clear();assert.deepEqual(totals(),before);
});
// Use the actual shell's independent native-container cleanup method.
const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code,shellClass=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const mod=await import(data(`class LitElement{};const nothing=null,scope={creationScope:{}};let clear;function renderInto(_value,root){clear(root);}export function setClear(value){clear=value;}\n`+shellClass+'\nexport {EditorShell};'));
test('native render clearing attempts every root and retains pins after any failed clear',()=>{
 const before=totals(),owner=new RenderModelOwners(),model=cloneOwnedModel('render-test',{name:'held'});owner.begin([model]);owner.commit();model.release();const shell=Object.create(mod.EditorShell.prototype);Object.assign(shell,{requestNode:'request',inspectorNode:'inspector',renderRoot:'main',renderModelOwners:owner});let seen=[];mod.setClear(root=>{seen.push(root);if(root==='inspector')throw Error('clear failed');});assert.throws(()=>shell.clearRenderedModels(),/EDITOR_RENDER_CLEAR_INCOMPLETE/);assert.deepEqual(seen,['request','inspector','main']);assert.equal(owner.ownership.roots,1);seen=[];mod.setClear(root=>seen.push(root));shell.clearRenderedModels();assert.deepEqual(seen,['request','inspector','main']);assert.deepEqual(totals(),before);
});

const {viewURL}=await viewModelDependencies(allocations,{root,promptURL:prompt,memoryURL:memory});
const {ViewModelOwners}=await import(viewURL),documentURL=await moduleURL('src/state/document-list.ts',{'../observability/model-memory.js':memory}),{collectOwnedDocuments}=await import(documentURL);
const clientCode=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(clientCode));
test('actual client render descriptors deduplicate document rows and nested model aliases by admitted root',async()=>{
 const before=totals(),documents=[{id:'one',revision:'1'},{id:'two',revision:'1'}],selected=[{id:'prior',revision:'1'}];
 const collect=values=>collectOwnedDocuments({async published(){return {generation:'1',cursor:'1'};},async *rows(){for(const value of values)yield {value};}});
 const list=await collect(documents),oldList=await collect(selected),views=new ViewModelOwners(),render=new RenderModelOwners(),client=Object.create(EditorClient.prototype),model=cloneOwnedModel('render-image',{image:{layers:[{id:'layer'}]}});
 Object.assign(client,{documentsMetadata:list,selectedDocumentMetadata:oldList,viewModels:views});views.publish([{slot:'image',model,identity:'image-1',exposed:model.value.image,references:()=>[model.value.image,...model.value.image.layers]}],()=>{});
 const descriptors=client.renderViewModels(documents[0],documents[1],selected[0],model.value.image,model.value.image.layers[0]);assert.equal(descriptors.length,3);assert.deepEqual(new Set(descriptors.map(value=>value.value)),new Set([list.documents,oldList.documents,model.value]));
 render.begin(descriptors);render.commit();list.release();oldList.release();views.clearReplaced({image:null});assert.equal(views.ownership.activePins,1);assert.throws(()=>client.renderViewModels({id:'unowned'}),/VIEW_MODEL_UNOWNED/);assert(totals().cpu>before.cpu);render.begin([]);render.commit();assert.equal(views.ownership.activePins,0);assert.deepEqual(totals(),before);
});
