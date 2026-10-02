import assert from 'node:assert/strict';
import {nothing} from 'lit';
import {RequestEditing,modelMemoryURL} from './request-controller-module.mjs';
const {cloneOwnedModel,createOwnedModel,modelPayloadBytes,readOwnedJSON}=await import(modelMemoryURL);
export function rendered(flow){
 const slots=[];const html=v=>{if(v===nothing||v===null||v===undefined)return '';if(Array.isArray(v))return v.map(html).join('');if(v?.strings)return v.strings.reduce((s,t,i)=>s+t+(i<v.values.length?html(v.values[i]):''),'');return '__slot'+(slots.push(v)-1)+'__';};
 const markup=html(flow.render()),resolve=s=>s.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)]));
 const buttons=[...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,a,label])=>{const disabled=/\?disabled=__slot(\d+)__/.exec(a),click=/@click=__slot(\d+)__/.exec(a);return {name:resolve(label).trim(),disabled:disabled?Boolean(slots[Number(disabled[1])]):false,click:click?slots[Number(click[1])]:undefined};});
 const busy=/<en-card id="durable-queue"[^>]*aria-busy=__slot(\d+)__/.exec(markup);const validation=/<en-validation-summary[^>]*\.items=([^ >]+)/.exec(markup),errors=validation?[...validation[1].matchAll(/__slot(\d+)__/g)].map(m=>slots[Number(m[1])].message):[];const fields=[...markup.matchAll(/<en-textarea\b([^>]*)>/g)].map(([,a])=>{const id=/id="([^"]+)"/.exec(a),input=/@en-input=__slot(\d+)__/.exec(a);return {id:id?.[1],input:input?slots[Number(input[1])]:undefined};});const announcement=/<p\b[^>]*\bid="request-announcements"[^>]*>([\s\S]*?)<\/p>/.exec(markup);return {fields,buttons,busy:busy?slots[Number(busy[1])]:undefined,announcement:announcement?resolve(announcement[1]):undefined,text:resolve(markup.replace(/<[^>]+>/g,'')),errors};
}
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export async function until(fn){const end=Date.now()+2000;while(!fn()){assert.ok(Date.now()<end,'Expected observable controller state');await new Promise(setImmediate);}}
export const turn=async()=>{await new Promise(r=>setTimeout(r,0));await new Promise(setImmediate);};
export const recover='Check existing request attempt',cancel='Request cancellation attempt';
export async function fixture(t){
 let uiPins=0,viewPins=0,identity='client',updates=0,candidates={items:[],requestedCount:1,actualCount:null};const draftRegistrations=new Map(),commands=[],responseOwners=[],recovery=deferred(),cancellation=deferred();
 const attempt={id:'attempt',state:'acknowledged',requestId:'known',count:'dispatched',spendSessionId:'spend',hold:true,recoveryRequired:true,estimate:{rate:0.015,unit:'megapixel',count:1,source:'fixture',unknown:[]}};
 const job={id:'job',documentId:'doc',version:'5',local:'ready-to-dispatch',disposition:'eligible',review:{endpoint:'ideogram/v4',request:{kind:'generate',settings:{count:1}}},attempts:[attempt]};let queue={session:{id:'spend',version:'1',cap:null},counts:{reserved:0,dispatched:1,remaining:null,active:1},jobs:[job],nextCursor:null};
 const editor={view:{ready:true,document:{id:'doc',revision:'1',width:512,height:512},image:{layers:[]},selected:[]},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map()},ui:{drafts:[]},registerDraft(id,documentId){
   const owner=this.draftOwner;if(!owner||this.view.document?.id!==documentId)throw Error('DRAFT_OWNER_CHANGED');
   if(typeof owner.registerDraft==='function')return owner.registerDraft(id,documentId);
   let rows=draftRegistrations.get(owner);if(!rows){rows=new Map();draftRegistrations.set(owner,rows);}let row=rows.get(id);
   if(row&&row.documentId!==documentId)throw Error('DRAFT_IDENTITY_CHANGED');if(row)row.count++;else{row={documentId,count:1};rows.set(id,row);}let live=true;
   return ()=>{if(!live)return;live=false;if(!--row.count){rows.delete(id);if(!rows.size)draftRegistrations.delete(owner);}};
  },pinViewModels(document,image){const model=createOwnedModel('legacy-queue-view-pin',modelPayloadBytes({document,image}),()=>({document,image}));viewPins++;let live=true;return ()=>{if(live){live=false;viewPins--;model.release();}};},pinUI(){uiPins++;let held=true;return ()=>{assert(held,'UI checkpoint pin released twice');held=false;uiPins--;};},changeDraft(id,kind,text,targetLayerId,composing,expectedDocumentRevision){const prior=this.draftOwner.drafts.get(id),generation=String(BigInt(prior?.generation??'0')+1n);this.draftOwner.drafts.set(id,{id,kind,text,targetLayerId,composing,expectedDocumentRevision,documentId:this.view.document.id,generation,savedGeneration:null});},async flushDrafts(){for(const draft of this.draftOwner.drafts.values())draft.savedGeneration=draft.generation;},json:async path=>path.startsWith('/api/v1/queue')?structuredClone(queue):path.includes('/candidates')?structuredClone({protocolVersion:1,jobId:'job',documentId:'doc',request:{endpoint:'ideogram/v4',prompt:{hash:'sha256:'+'1'.repeat(64),byteLength:'0',mediaType:'text/plain'},seed:null},observation:null,provenance:null,inert:false,nextCursor:null,...candidates,items:candidates.items.map(candidate=>({jobId:'job',attemptId:'attempt',documentId:'doc',...candidate}))}): {items:[]},command:async body=>{commands.push(body);if(body.type==='RecoverJob')await recovery.promise;if(body.type==='CancelJob')await cancellation.promise;return [];} };
 // Existing scenarios replace json/command to control asynchronous boundaries.
 // Owned wrappers preserve those scenarios while matching the current API lifetime.
 const owned=model=>{const row={model,released:false};responseOwners.push(row);return {value:model.value,pin:()=>model.pin(),release(){assert(!row.released,'Fixture response released twice');row.released=true;model.release();}};};
 editor.ownedJSON=(path,owner,init,owns,maxBytes,kind)=>readOwnedJSON(async()=>{const text=JSON.stringify(await editor.json(path,init));return new Response(text,{headers:{'content-length':String(Buffer.byteLength(text))}});},path,{owner,init,owns,maxBytes,kind}).then(owned);
 editor.withCommandEvents=async(body,work,document,newId,onJournaled)=>{const result=await editor.command(body,document,newId,onJournaled),model=owned(cloneOwnedModel('legacy-queue-fixture-events',Array.isArray(result)?result:[]));try{return await work(model.value);}finally{model.release();}};
 // Template inspection does not mount a native prompt. A prompt-input case
 // explicitly installs its event target; lookup must return that same node.
 let prompt=null;const nativePrompt=value=>{if(!prompt)prompt={value:'',isConnected:true,updateComplete:Promise.resolve(),focus(){}};prompt.value=value;return prompt;};
 let flow;const host={requestUpdate(){updates++;},updateComplete:Promise.resolve(),querySelector(selector){return selector==='#prompt'?prompt:{focus(){}};}};flow=new RequestEditing(host,editor);t.after(async()=>{recovery.resolve();cancellation.resolve();
  // Model removal of the fixture's control before awaiting native retirement.
  // The production owner still observes the real value and enforces its pins.
  if(prompt){prompt.isConnected=false;prompt=null;}await flow.dispose();assert.equal(draftRegistrations.size,0,'Every synthetic draft registration released');assert.equal(viewPins,0,'Every view-model pin released');assert.equal(uiPins,0,'Every checkpoint restoration pin released');assert(responseOwners.every(row=>row.released),'Every returned fixture response released');});
 const event=()=>{const h={isConnected:true};return {currentTarget:h,composedPath:()=>[h],defaultPrevented:false};};
 const button=name=>{const b=rendered(flow).buttons.find(b=>b.name===name);assert.ok(b,'Public button '+name);return b;};
 const click=(name,e=event())=>{const b=button(name);assert.equal(b.disabled,false,'Public action enabled '+name);b.click(e);return e;};
 await flow.sync();click('Refresh durable queue');await until(()=>rendered(flow).buttons.some(b=>b.name===cancel));
 return {flow,editor,commands,recovery,cancellation,button,click,event,job,attempt,nativePrompt,render:()=>rendered(flow),updates:()=>updates,setIdentity:v=>identity=v,setCandidates:v=>candidates=v,setQueue:q=>queue=q,getQueue:()=>structuredClone(queue),async heldRecovery(){click(recover);await until(()=>commands.some(c=>c.type==='RecoverJob'));},async refreshedRecovery(){queue=structuredClone(queue);queue.jobs[0].version='6';queue.jobs[0].attempts[0].recoveryRequired=false;click('Refresh durable queue');await until(()=>!rendered(flow).text.includes('Recovery is paused after restart'));}};
}
