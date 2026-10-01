// Additive owner-transition correction. Authored source only during the freeze.
// Promoted sources are default; select frozen dependencies and corrected UI with
// COMPOSITION_STAGED_ROOT and COMPOSITION_CORRECTION_ROOT for staged evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const sourceRoot=process.env.COMPOSITION_STAGED_ROOT??'.',controllerRoot=process.env.COMPOSITION_CORRECTION_ROOT??sourceRoot;
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [specifier,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(url)).replaceAll("'"+specifier+"'",JSON.stringify(url));return data(code);}
const allocationURL=data((await transformWithOxc(await readFile('src/observability/allocations.ts','utf8'),'allocations.ts')).code+'\n// owner-transition fixture ledger\n');
const promptURL=await source(sourceRoot+'/src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const coreURL=await source(sourceRoot+'/src/composition/core.ts');
const memoryURL=await source(sourceRoot+'/src/composition/memory.ts',{'../observability/allocations.js':allocationURL,'../observability/prompt-memory.js':promptURL,'./core.js':coreURL});
const jsonURL=await source('src/protocol/json.ts'),adapterURL=await source('src/ui/adapters.ts');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const color=data('export function parseColor(){throw Error("unused color path")}export function exportSRGB(){throw Error("unused color path")}');
const destination=data('export function chooseDestination(){throw Error("unused destination")}export function writeDestination(){throw Error("unused destination")}');
const phases=data('export const browserPhases={recorder:{start(){return {end(){}};}}};');
const uiURL=await source(controllerRoot+'/src/ui/composition.ts',{'lit':lit,'@en-reve/elements/color-picker.js':color,'../state/destination.js':destination,'../observability/browser.js':phases,'./adapters.js':adapterURL,'../protocol/json.js':jsonURL,'../composition/core.js':coreURL,'../composition/memory.js':memoryURL,'../observability/prompt-memory.js':promptURL});
const {CompositionEditing}=await import(uiURL),{emptyComposition}=await import(coreURL),{compositionPayloadBytes}=await import(memoryURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL);
const flush=async()=>{for(let n=0;n<64;n++)await Promise.resolve();};
function field(template,id){if(!template||typeof template!=='object')return null;if(template.strings?.[0].includes('<en-textarea id=')&&template.values[0]===id)return template;for(const value of Array.isArray(template)?template:template.values??[]){const found=field(value,id);if(found)return found;}return null;}
function event(value){const target={value,isConnected:true};return {currentTarget:target,composedPath:()=>[target],detail:{isComposing:false},defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};}
function fixture(){
 const document={id:'old-document',revision:'1',width:360,height:200},value=emptyComposition(360,200,'old-composition');value.scene='Old owner scene';
 let payload={composition:value,layers:[],bindings:{},revision:'1'},rendered,instance,reads=0;const saved=[];
 const editor={sessionId:'old-session',draftOwner:{drafts:new Map()},view:{ready:true,document},ui:{drafts:[]},session:{identity:()=> 'client',async transport(){reads++;const text=JSON.stringify(payload);return new Response(text,{headers:{'content-length':String(new TextEncoder().encode(text).byteLength)}});}},changeDraft(id,kind,text,target,composing,revision){saved.push({id,kind,graph:JSON.parse(text),documentId:editor.view.document.id,revision});}};
 const host={requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{rendered=instance.request();});},updateComplete:Promise.resolve(),querySelector(){return null;}};
 instance=new CompositionEditing(host,editor,()=>{},()=>{},async()=>{},()=>{});
 return {instance,editor,saved,scene:()=>field(rendered,'composition-scene'),freshScene:()=>field(instance.request(),'composition-scene'),setPayload(value){payload=value;},reads:()=>reads,async initial(){await instance.sync();await flush();assert(this.scene());}};
}
for(const transition of ['document','session','draft-owner'])for(const stage of ['clone','bindings'])test(`${transition} transition remains atomic when ${stage} admission refuses after parsing`,async()=>{
 const before=allocationLedger.snapshot(),f=fixture();let pressure,completion,settle;const nativeClone=globalThis.structuredClone;
 try{
  await f.initial();const c=f.instance.c,accepted=f.instance.accepted,layers=f.instance.layers,bindings=f.instance.bindings,base=f.instance.base,key=f.instance.key,predicate=f.instance.ownsModel,draftId=f.instance.draftId,draftLease=f.instance.payloads.get('draft'),viewLease=f.instance.payloads.get('view'),oldScene=f.scene().values.at(-1),retained=allocationLedger.snapshot();
  if(transition==='document')f.editor.view.document={...f.editor.view.document,id:'successor-document'};
  if(transition==='session')f.editor.sessionId='successor-session';
  if(transition==='draft-owner')f.editor.draftOwner={drafts:new Map()};
  assert.equal(predicate(),false);
  const next=emptyComposition(360,200,'successor-composition');next.scene='Successor scene';const incoming={composition:next,layers:[],bindings:{binding:'successor-layer'},revision:'1'};f.setPayload(incoming);
  const barrier=new Promise(resolve=>settle=()=>{f.instance.settlements.delete(barrier);resolve();});f.instance.settlements.add(barrier);
  completion=f.instance.sync();void completion.catch(()=>{});await flush();
  // The native response was consumed and the real parsed model is retained;
  // the controller is stopped at its real field-settlement boundary.
  assert.equal(f.reads(),2);assert.equal(allocationLedger.snapshot().promptBytes,retained.promptBytes+compositionPayloadBytes(incoming));assert.equal(f.instance.key,key);
  const allowance=stage==='clone'?0:compositionPayloadBytes(next);
  pressure=allocationLedger.reserve({owner:'composition-owner-transition-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-allowance});
  let clones=0;globalThis.structuredClone=(...args)=>{clones++;return nativeClone(...args);};settle();await assert.rejects(completion,/PROMPT_MEMORY_BUDGET/);globalThis.structuredClone=nativeClone;
  assert.equal(clones,stage==='clone'?0:1);assert.equal(f.instance.c,c);assert.equal(f.instance.accepted,accepted);assert.equal(f.instance.layers,layers);assert.equal(f.instance.bindings,bindings);assert.equal(f.instance.base,base);assert.equal(f.instance.key,key);assert.equal(f.instance.draftId,draftId);assert.equal(f.instance.ownsModel,predicate);assert.equal(f.instance.ownsModel(),false);assert.equal(f.instance.payloads.get('draft'),draftLease);assert.equal(f.instance.payloads.get('view'),viewLease);
  pressure.release();pressure=undefined;assert.equal(allocationLedger.snapshot().promptBytes,retained.promptBytes);
  // Both the previous rendered callback and a newly rendered old-model callback
  // must remain unable to save into the successor after refusal.
  oldScene(event('Retained callback contamination'));f.freshScene().values.at(-1)(event('Fresh callback contamination'));await flush();assert.equal(f.saved.length,0);assert.equal(c.scene,'Old owner scene');
  await f.instance.sync();await flush();assert.equal(f.reads(),3);assert.notEqual(f.instance.c,c);assert.equal(f.instance.c.scene,'Successor scene');assert.equal(f.instance.ownsModel(),true);assert.equal(f.saved.length,0);
  oldScene(event('Old callback after successor install'));await flush();assert.equal(f.saved.length,0);assert.equal(f.instance.c.scene,'Successor scene');
  f.scene().values.at(-1)(event('Successor edit'));await flush();assert.equal(f.saved.length,1);assert.equal(f.saved[0].graph.composition.scene,'Successor edit');assert.equal(f.saved[0].documentId,f.editor.view.document.id);
 }finally{globalThis.structuredClone=nativeClone;pressure?.release();settle?.();await completion?.catch(()=>{});await f.instance.dispose();}
 const after=allocationLedger.snapshot();assert.equal(after.cpuBytes,before.cpuBytes);assert.equal(after.promptBytes,before.promptBytes);assert.equal(after.activeRecords,before.activeRecords);assert.equal(after.handles,before.handles);
});
