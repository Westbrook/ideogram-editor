import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {uiModelOwnerURL,ownFixtureJSON} from '../ui-model-module.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64'),lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}'),adapter=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapter.ts')).code);
let code=(await transformWithOxc(await readFile('src/ui/deletion.ts','utf8'),'deletion.ts')).code;for(const [name,url]of Object.entries({'lit':lit,'./adapters.js':adapter,'./model-owner.js':uiModelOwnerURL}))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));const {DocumentDeletion}=await import(data(code));
const tick=()=>new Promise(r=>setTimeout(r,10));
function find(t,part){if(!t||typeof t!=='object')return;if(t.strings){const i=t.strings.findIndex(s=>s.includes(part));if(i>=0)return {strings:t.strings.slice(i),values:t.values.slice(i)};}for(const v of Array.isArray(t)?t:t.values??[]){const found=find(v,part);if(found)return found;}}
function fixture(){const commands=[],plan={id:'plan',documentId:'doc',documentRevision:'1',rootGeneration:'root',planHash:'hash',histories:1,checkpoints:0,drafts:0,jobs:0,exclusiveBytes:'1',retainedBytes:'0',pendingBytes:'0',retainedRoots:[],unresolvedAttempts:[]};let composition=false,identity='client';const editor={session:{identity:()=>identity},view:{document:{id:'doc',revision:'1'},busy:false},draftOwner:{drafts:new Map()},command:async b=>commands.push(b),json:async()=>({plan}),copy:async()=>{}};const host={requestUpdate(){}},flow=new DocumentDeletion(host,ownFixtureCommands(ownFixtureJSON(editor)),()=>composition),event=()=>{const host={isConnected:true};return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};};return {flow,editor,commands,plan,event,setComposition:v=>composition=v,setIdentity:v=>identity=v};}
for(const boundary of ['revision','document','identity','session','draft-owner','pending-draft','composition','dispose','detach','late-veto'])test('actual deletion control cannot authorize stale '+boundary,async()=>{const f=fixture(),cb=find(f.flow.render(),'<en-button id="preview-document-deletion" ?disabled=').values.find(v=>typeof v==='function'),e=f.event();cb(e);if(boundary==='revision')f.editor.view.document.revision='2';if(boundary==='document')f.editor.view.document={id:'other',revision:'1'};if(boundary==='identity')f.setIdentity('other');if(boundary==='session')f.editor.session={...f.editor.session};if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='pending-draft')f.editor.draftOwner.drafts.set('draft',{generation:'2',savedGeneration:'1',pending:true});if(boundary==='composition')f.setComposition(true);if(boundary==='dispose')f.flow.dispose();if(boundary==='detach')e.currentTarget.isConnected=false;if(boundary==='late-veto')e.defaultPrevented=true;await tick();assert.equal(f.commands.length,0);});
test('public deletion preview action issues only preview and an invalidated confirmation cannot delete',async()=>{const f=fixture(),cb=find(f.flow.render(),'<en-button id="preview-document-deletion" ?disabled=').values.find(v=>typeof v==='function');cb(f.event());await tick();assert.deepEqual(f.commands.map(c=>c.type),['PreviewDocumentDeletion']);const p=f.flow.plan;f.flow.plan=null;await f.flow.confirm(p);assert.equal(f.commands.length,1);});

for(const boundary of ['identity','document','draft-owner','dispose'])test('pristine deletion controls do not announce a stale review on '+boundary,async()=>{
 const f=fixture();f.editor.view.document=null;f.flow.render();const generation=f.flow.generation;
 if(boundary==='identity')f.setIdentity('paired');
 if(boundary==='document')f.editor.view.document={id:'opened',revision:'1'};
 if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};
 if(boundary==='dispose')await f.flow.dispose();
 f.flow.render();assert.equal(f.flow.message,'');assert(f.flow.generation>generation);assert.equal(f.flow.plan,null);assert.equal(f.flow.planReady,false);assert.deepEqual(f.commands,[]);
 await f.flow.dispose();
});
test('a real deletion review still announces and clears stale authority after a document change',async()=>{
 const f=fixture(),cb=find(f.flow.render(),'<en-button id="preview-document-deletion" ?disabled=').values.find(v=>typeof v==='function');
 cb(f.event());await tick();assert.deepEqual(f.commands.map(c=>c.type),['PreviewDocumentDeletion']);assert.equal(f.flow.planReady,true);
 f.editor.view.document={id:'other',revision:'1'};f.flow.render();
 assert.match(f.flow.message,/Deletion view changed/);assert.equal(f.flow.plan,null);assert.equal(f.flow.planReady,false);assert.equal(f.flow.active,null);assert.equal(f.flow.busy,false);
 assert.deepEqual(f.commands.map(c=>c.type),['PreviewDocumentDeletion']);await f.flow.dispose();
});
