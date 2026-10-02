import '@en-reve/tokens/default.css';
import {LitElement,html,nothing} from 'lit';
import {createElementScope} from '@en-reve/elements/element-scope.js';
import {definitions} from '@en-reve/elements/catalog.js';
import {RequestEditing} from '@request-prompt-source/ui/request.js';
import {allocationLedger,ALLOCATION_LIMITS,type Lease} from '@request-prompt-source/observability/allocations.js';
import {cloneOwnedModel,type Owned} from '@request-prompt-source/observability/model-memory.js';
import type {NativeEvent,PromptFixture,Saved,Usage} from './types.js';

// Actual controller, child controllers, public custom elements and allocation
// ledger. Only persistence/transport is a deterministic fixture boundary. This
// fixture does not qualify server durability, process RSS, or physical IME use.
const scope=createElementScope({document,registry:'auto'});scope.register(definitions);
const usage=():Usage=>{const {cpuBytes,promptBytes,handles,activeRecords}=allocationLedger.snapshot();return {cpuBytes,promptBytes,handles,activeRecords};};
const before=usage(),saved:Saved[]=[],commands:string[]=[],events:NativeEvent[]=[],errors:string[]=[],registrations=new Map<string,{documentId:string;count:number}>(),refused=new Map<string,string>();
const responseOwners=new Set<Owned<unknown>>();let pressure:Lease|undefined,uiPins=0,disposed=false;
function ensure(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message);}
const checkpoint=cloneOwnedModel('prompt-fixture-checkpoint',{drafts:[]});
function owned<T>(value:T,label:string){const model=cloneOwnedModel(label,value);responseOwners.add(model);return {value:model.value,pin:()=>model.pin(),release(){ensure(responseOwners.delete(model),'FIXTURE_RESPONSE_DOUBLE_RELEASE');model.release();}};}
function registerDraft(id:string,documentId:string){
 ensure(!disposed&&documentId==='document','FIXTURE_DRAFT_OWNER_CHANGED');const row=registrations.get(id);
 ensure(!row||row.documentId===documentId,'FIXTURE_DRAFT_IDENTITY_CHANGED');if(row)row.count++;else registrations.set(id,{documentId,count:1});let live=true;
 return ()=>{if(!live)return;live=false;const current=registrations.get(id);ensure(current&&current.count>0,'FIXTURE_DRAFT_UNREGISTERED');if(!--current.count){registrations.delete(id);refused.delete(id);}};
}
type DraftRow={id:string;kind:string;text:string;targetLayerId:string|null;composing:boolean;expectedDocumentRevision:string;documentId:string;generation:string;savedGeneration:string|null;pending:boolean;error:null};
const draftOwner={drafts:new Map<string,DraftRow>(),registerDraft,
 refuseChange(id:string,documentId:string){const registration=registrations.get(id);ensure(registration?.documentId===documentId,'FIXTURE_REFUSAL_WITHOUT_REGISTRATION');refused.set(id,documentId);},
 acceptRetained(id:string,text:string){if(this.drafts.get(id)?.text===text)refused.delete(id);},
 get hasRefusedChanges(){return refused.size>0;},get hasPendingRequests(){return false;},
};
const imageIdentity={state:{hash:'sha256:'+'0'.repeat(64),byteLength:'2',mediaType:'application/json'},semanticDigest:'sha256:'+'1'.repeat(64),compositeAssetId:'fixture-visible'};
const editor={sessionId:'session',draftOwner,ui:checkpoint.value,documentEpoch:1,
 view:{ready:true,document:{id:'document',revision:'1',width:512,height:512,image:imageIdentity},image:{schemaVersion:5,width:512,height:512,layers:[],composition:null},selected:[] as string[]},
 session:{identity:()=> 'client',transport:async()=>{throw Error('FIXTURE_UNEXPECTED_TRANSPORT');}},
 registerDraft,pinUI(){const release=checkpoint.pin();uiPins++;let live=true;return ()=>{if(live){live=false;uiPins--;release();}};},
 pinViewModels:()=>()=>{},beginFeedback(){},
 changeDraft(id:string,kind:string,text:string,targetLayerId:string|null,composing:boolean,expectedDocumentRevision:string){
  const registration=registrations.get(id);ensure(registration?.documentId==='document','FIXTURE_SAVE_WITHOUT_REGISTRATION');
  const prior=draftOwner.drafts.get(id),generation=String(BigInt(prior?.generation??'0')+1n),value=JSON.parse(text);
  draftOwner.drafts.set(id,{id,kind,text,targetLayerId,composing,expectedDocumentRevision,documentId:'document',generation,savedGeneration:generation,pending:false,error:null});
  refused.delete(id);saved.push({id,text:value.text,operation:value.draft.operation,mode:value.draft.prompt.mode,generation,composing});
 },
 async flushDrafts(){for(const row of draftOwner.drafts.values())row.savedGeneration=row.generation;},
 async ownedJSON(path:string){ensure(path.endsWith('/request-reviews'),'FIXTURE_UNEXPECTED_READ '+path);return owned({items:[]},'prompt-fixture-response');},
 async withCommandEvents(body:{type:string}){commands.push(body.type);throw Error('FIXTURE_UNEXPECTED_COMMAND '+body.type);},
 async ownedCommand(body:{type:string}){commands.push(body.type);throw Error('FIXTURE_UNEXPECTED_COMMAND '+body.type);},
 async ownedRequestReview(){throw Error('FIXTURE_UNEXPECTED_REQUEST_REVIEW');},
 command(){throw Error('FIXTURE_UNOWNED_COMMAND');},json(){throw Error('FIXTURE_UNOWNED_JSON');},
};
class PromptHost extends LitElement {
 flow:RequestEditing|undefined;
 constructor(){super();this.renderOptions.creationScope=scope.creationScope;}
 protected createRenderRoot(){return this;}
 protected render(){const flow=this.flow;if(!flow)return nothing;return html`<en-select label="Operation" .value=${flow.operation} @en-change=${flow.operationChoice(()=>this.requestUpdate())}><en-select-option value="Generate image">Generate image</en-select-option><en-select-option value="Generate with Fast">Generate with Fast</en-select-option></en-select>${flow.render()}`;}
}
customElements.define('request-prompt-fixture',PromptHost);
const host=document.createElement('request-prompt-fixture') as PromptHost;document.querySelector('#fixture')!.append(host);
const flow=new RequestEditing(host,editor);host.flow=flow;
const tick=async()=>{await host.updateComplete;await new Promise<void>(resolve=>setTimeout(resolve,0));await host.updateComplete;};
const releasePressure=()=>{pressure?.release();pressure=undefined;};
const api:PromptFixture={
 snapshot:()=>({saved:saved.map(row=>({...row})),refused:refused.size>0,refusedIds:[...refused.keys()],registrations:[...registrations.values()].reduce((total,row)=>total+row.count,0),uiPins,commands:[...commands],usage:usage(),events:events.map(row=>({...row})),errors:[...errors],disposed}),
 async pressure(remaining=0){releasePressure();await tick();ensure(Number.isSafeInteger(remaining)&&remaining>=0,'FIXTURE_PRESSURE_ARGUMENT');const available=ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-remaining;ensure(available>=0,'FIXTURE_PRESSURE_ARGUMENT');pressure=allocationLedger.reserve({owner:'request-prompt-browser-pressure',kind:'prompt',cpuBytes:available});},
 releasePressure,
 async repaint(){host.requestUpdate();await tick();},
 async dispose(){releasePressure();if(!disposed){await flow.dispose();await tick();disposed=true;checkpoint.release();draftOwner.drafts.clear();host.remove();}return {before,after:usage(),registrations:[...registrations.values()].reduce((total,row)=>total+row.count,0),uiPins,responseOwners:responseOwners.size};},
};
window.promptFixture=api;
addEventListener('error',event=>errors.push(event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
for(const type of ['beforeinput','input','compositionstart','compositionend'])document.addEventListener(type,event=>{
 const control=event.composedPath()[0];if(!(control instanceof HTMLTextAreaElement))return;
 if(!event.composedPath().some(node=>node instanceof HTMLElement&&node.id==='prompt'))return;
 // Observe the settled cancellation result. Read only native DOM properties;
 // no private custom-element field/model or internal selector is inspected.
 queueMicrotask(()=>{const input=event as InputEvent;events.push({type,trusted:event.isTrusted,cancelable:event.cancelable,prevented:event.defaultPrevented,inputType:input.inputType??'',isComposing:input.isComposing??false,units:control.value.length,start:control.selectionStart,end:control.selectionEnd,maximum:control.maxLength});});
});
await flow.sync();await tick();
await Promise.all([...host.querySelectorAll('en-textarea,en-select,en-button')].map(element=>(element as LitElement).updateComplete));
document.querySelector('#fixture-status')!.textContent='Ready: '+scope.mode;
