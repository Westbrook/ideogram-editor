import {html,nothing,type LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {BlobRef} from '../protocol/store.js';
import type {CandidateView} from '../protocol/candidates.js';
import {inspectReturnedDescription,approximateReturnedTextBox,type ReturnedDescriptionInspection,type ReturnedTextProposal} from '../text/returned-description.js';
import {SHA256} from '../protocol/sha256.js';
import {allocationLedger} from '../observability/allocations.js';
import {cloneOwnedModel,createOwnedModel,type OwnedModel} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {ControlAdapter} from './adapters.js';
type Target={jobId:string;attemptId:string;documentId:string;documentRevision:string;returnedPrompt:BlobRef};
type Inspection={target:Target;value:ReturnedDescriptionInspection};
/** Local caption parsing is deliberate. It creates no layer and supplies no image admission. */
export class ReturnedDescriptionEditing {
 private adapter=new ControlAdapter();private currentGuard:()=>boolean=()=>false;private current?:OwnedModel<Inspection>;private epoch=0;private reads=new Set<AbortController>();private pending=new Set<Promise<unknown>>();private cleanup=new Set<PromptReaderCleanupError>();private retired=new Set<OwnedModel<Inspection>>();private selected=-1;private acknowledged=false;private placement:'keep-both'|'separate-placement'='separate-placement';private message='';
 constructor(private host:LitElement,private editor:EditorClient,private begin:(trigger:HTMLElement,proposal:ReturnedTextProposal)=>Promise<void>){}
 private changed(){this.host.requestUpdate();}
 private retire(){const old=this.current;this.current=undefined;if(!old)return;this.retired.add(old);this.changed();const task=Promise.resolve().then(()=>this.host.updateComplete).then(()=>{old.release();this.retired.delete(old);});this.track(task);}
 private track<T>(task:Promise<T>){this.pending.add(task);void task.finally(()=>this.pending.delete(task)).catch(()=>{});return task;}
 private own(target:Target,epoch:number){return this.currentGuard()&&this.epoch===epoch&&this.editor.view.ready&&this.editor.view.document?.id===target.documentId&&this.editor.view.document.revision===target.documentRevision;}
 private action(event:Event,work:()=>Promise<void>,owns:()=>boolean){this.adapter.action(event,()=>{if(!owns())return;const workResult=work(),epoch=this.epoch;const task=workResult.catch(error=>{if(error instanceof PromptReaderCleanupError)this.cleanup.add(error);if(owns()&&this.currentGuard()&&this.epoch===epoch&&!(error instanceof DOMException&&error.name==='AbortError')){this.message=error instanceof Error?error.message:String(error);this.changed();}});this.track(task);});}
 private async inspect(target:Target,owns:()=>boolean){
  if(!owns())throw new DOMException('Caption owner changed.','AbortError');const sessionId=this.editor.sessionId,draftOwner=this.editor.draftOwner;this.currentGuard=()=>owns()&&this.editor.sessionId===sessionId&&this.editor.draftOwner===draftOwner;
  for(const read of this.reads)read.abort();const epoch=++this.epoch,owned=cloneOwnedModel('returned-description-target',target),abort=new AbortController();this.reads.add(abort);this.retire();this.selected=-1;this.acknowledged=false;this.message='Reading exact retained caption…';this.changed();
  let workspace:ReturnType<typeof allocationLedger.reserve>|undefined;
  try{const t=owned.value,length=Number(t.returnedPrompt.byteLength);if(!Number.isSafeInteger(length)||length<0||length>262144)throw Error('The retained caption exceeds the supported local parser limit.');workspace=allocationLedger.reserve({owner:'returned-description-parser',kind:'prompt',cpuBytes:length*8+65536,handles:2});
   const bytes=new Uint8Array(length);let at=0,pages=0;
   do{if(++pages>9)throw Error('Retained caption page count exceeds its bound.');const page=await this.editor.ownedJSON<{bytes:string;byteLength:string;offset:string;nextOffset:string|null}>('/api/v1/jobs/'+t.jobId+'/candidates?attempt='+t.attemptId+'&prompt=returned&offset='+at,'returned-description-page',{signal:abort.signal},()=>this.own(t,epoch),65536,'prompt');
    try{if(!this.own(t,epoch))throw new DOMException('Caption review changed.','AbortError');const p=page.value;if(typeof p.bytes!=='string'||p.bytes.length>44000||p.byteLength!==t.returnedPrompt.byteLength||p.offset!==String(at))throw Error('Caption page identity changed.');const decoded=atob(p.bytes);if(decoded.length>32768||at+decoded.length>length||!decoded.length&&at!==length)throw Error('Caption page size changed.');for(let i=0;i<decoded.length;i++)bytes[at+i]=decoded.charCodeAt(i);at+=decoded.length;if(p.nextOffset!==(at<length?String(at):null))throw Error('Caption page boundary changed.');}finally{page.release();}
   }while(at<length);
   if(new SHA256().update(bytes).digest()!==t.returnedPrompt.hash)throw Error('Retained caption identity changed.');if(!this.own(t,epoch))throw new DOMException('Caption review changed.','AbortError');
   const result=createOwnedModel<Inspection>('returned-description-inspection',length*6+65536,()=>({target:structuredClone(t),value:inspectReturnedDescription(bytes)}),'prompt');this.current=result;this.message=result.value.value.state==='available'?'Choose a supported text element. Original caption bytes stay unchanged.':result.value.value.reason;this.changed();
  }finally{workspace?.release();owned.release();this.reads.delete(abort);}
 }
 private async open(trigger:HTMLElement){
  const model=this.current;if(!model||!this.acknowledged)throw Error('Review duplication and approximate placement first.');const unpin=model.pin(),epoch=this.epoch;
  try{const {target,value}=model.value;if(value.state!=='available'||!this.own(target,epoch))throw Error('Review this caption again for the current document.');const element=value.elements.find(e=>e.index===this.selected);if(!element)throw Error('Choose a text element first.');const document=this.editor.view.document!,position=approximateReturnedTextBox(element.box,document.width,document.height);
   // Native editing synchronously admits its own proposal before the first await.
   await this.begin(trigger,{selection:{kind:'returned-description-selection-1',jobId:target.jobId,attemptId:target.attemptId,returnedPrompt:target.returnedPrompt,elementIndex:element.index,elementHash:element.elementHash,placementChoice:this.placement,duplicationAcknowledged:true},literal:element.literal,frame:position.frame,placement:position.placement});
   if(this.own(target,epoch)){this.message='Editable draft opened. Review the literal, local font and placement, then preview and Apply explicitly.';this.changed();}
  }finally{unpin();}
 }
 render(view:CandidateView,attemptId:string,owns:()=>boolean){
  const p=view.provenance,available=!!p&&p.returnedPrompt!==null&&p.complete&&!p.quarantined&&p.inspection==='supported',jobId=view.jobId,documentId=view.documentId,ref=available?p!.returnedPrompt!:null;
  const current=this.current?.value,shown=current?.target.jobId===jobId&&current.target.attemptId===attemptId?current:undefined;
  const capturedEpoch=this.epoch,still=()=>owns()&&this.epoch===capturedEpoch;
  return html`<en-accordion-item label="Create editable text from returned description"><p>This creates a new local text draft from a supported caption. It does not read lettering from pixels, recover a font, or erase generated lettering.</p>
   ${!available?html`<p>${view.request.endpoint.startsWith('ideogram/v4.5')?'This model contract has no returned prompt. Editable text from a returned description is unavailable.':'A complete, supported, unquarantined retained caption is required. Original prompt inspection remains separate.'}</p>`:html`<en-button @click=${(event:Event)=>{if(!owns())return;const doc=this.editor.view.document;if(!doc||doc.id!==documentId)return;const target={jobId,attemptId,documentId,documentRevision:doc.revision,returnedPrompt:ref!};this.action(event,()=>this.inspect(target,owns),owns);}}>Review supported caption text</en-button>`}
   ${shown?.value.state==='available'?html`<en-select label="Returned text element" .value=${String(this.selected)} @en-change=${(event:Event)=>{const input=event.currentTarget as HTMLInputElement;this.adapter.settled(event,()=>input.value,value=>{if(still()){this.selected=Number(value);this.acknowledged=false;this.changed();}});}}><en-select-option value="-1">Choose an element</en-select-option>${shown.value.elements.map(element=>html`<en-select-option value=${String(element.index)}>Element ${element.index+1}: ${element.literal}</en-select-option>`)}</en-select>
    ${shown.value.elements.filter(e=>e.index===this.selected).map(element=>html`<en-textarea label="Exact returned literal" readOnly .value=${element.literal}></en-textarea><p>${element.description}</p><p>${element.box?'Suggested caption box (top, left, bottom, right): '+element.box.join(', '):'No caption box: start with an explicit local frame.'} Geometry is approximate and can be changed in the text editor.</p>`)}
    <en-select label="Placement review" .value=${this.placement} @en-change=${(event:Event)=>{const input=event.currentTarget as HTMLInputElement;this.adapter.settled(event,()=>input.value,value=>{if(still()&&(value==='keep-both'||value==='separate-placement')){this.placement=value;this.acknowledged=false;this.changed();}});}}><en-select-option value="separate-placement">Review a separate placement</en-select-option><en-select-option value="keep-both">Knowingly keep both letterings</en-select-option></en-select>
    <en-switch label="I understand generated lettering remains and will review duplicate text, approximate placement and a local font" .checked=${this.acknowledged} @en-change=${(event:Event)=>{const input=event.currentTarget as unknown as {checked:boolean};this.adapter.settled(event,()=>input.checked,value=>{if(still()){this.acknowledged=value;this.changed();}});}}></en-switch>
    <en-button ?disabled=${!this.acknowledged||this.selected<0||!owns()} @click=${(event:Event)=>{const trigger=event.currentTarget as HTMLElement;if(still())this.action(event,()=>this.open(trigger),still);}}>Open reviewed editable text draft</en-button>`:nothing}
   ${shown?html`<p role="status">${this.message}</p>`:nothing}</en-accordion-item>`;
 }
 async releaseDocument(){this.epoch++;this.currentGuard=()=>false;this.adapter.invalidate();for(const read of this.reads)read.abort();this.retire();this.selected=-1;this.acknowledged=false;this.message='';this.changed();while(this.pending.size)await Promise.allSettled([...this.pending]);for(const error of this.cleanup){await error.retry();this.cleanup.delete(error);}await this.host.updateComplete;for(const model of this.retired)model.release();this.retired.clear();}
}
