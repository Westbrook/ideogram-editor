import type {Draft} from '../protocol/ui.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {reservePromptPayload} from '../observability/prompt-memory.js';
import {ModelPayload,type OwnedModel} from '../observability/model-memory.js';
import {measureControl} from './control-memory.js';

export type LocalDraft=Omit<Draft,'assetId'|'status'>&{text:string;savedGeneration:string|null;pending:boolean;error:string|null};
export const DRAFT_METADATA_LIMITS=Object.freeze({ids:64,rows:256,editableBorrowers:128,metadataBytes:65536,sequenceUnits:128,errorUnits:4096});
export const DRAFT_REFUSAL='Draft workspace is full. Your new input remains in the editor; revise it or release another preview, then edit again to save. The previous saved draft is retained.';
const unsupportedError='Draft returned an unsupported diagnostic. The current input and original delivery remain retained.';
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function sequence(value:unknown):asserts value is string{if(typeof value!=='string'||value.length>DRAFT_METADATA_LIMITS.sequenceUnits||!/^(0|[1-9][0-9]*)$/.test(value))throw Error('DRAFT_SEQUENCE_LIMIT');}
export function nextDraftGeneration(value:string){sequence(value);const next=String(BigInt(value)+1n);sequence(next);return next;}
function errorText(value:unknown):string|null{return value===null?null:typeof value==='string'&&value.length<=DRAFT_METADATA_LIMITS.errorUnits?value:unsupportedError;}
function freezeData<T>(value:T):T{if(value&&typeof value==='object'){for(const field of Object.values(value))freezeData(field);Object.freeze(value);}return value;}
type Registration={id:string;documentId:string;refused:boolean;rows:number;editors:number;attached:boolean;lease:AllocationLease};
/** Admission for an editable identity precedes exposing its native/control owner.
 * A refusal toggles existing booked state and never allocates a new identity. */
export class DraftRegistrations {
 private slots=new Map<string,Registration>();private all=new Set<Registration>();private borrowers=0;private disposed=false;private waiting?:Promise<void>;private finish?:()=>void;
 register(idValue:string,documentId:string):()=>void{
  if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');if(this.borrowers>=DRAFT_METADATA_LIMITS.editableBorrowers)throw Error('DRAFT_EDITABLE_LIMIT');
  const slot=this.ensure(idValue,documentId);let lease:AllocationLease;
  try{lease=allocationLedger.reserve({owner:'draft-editable-owner',kind:'control',cpuBytes:(idValue.length+documentId.length)*2,handles:1});}catch(error){this.collect(slot);throw error;}
  this.borrowers++;slot.editors++;let live=true;return ()=>{if(live){live=false;lease.release();this.borrowers--;slot.editors--;this.collect(slot);}};
 }
 private ensure(idValue:string,documentId:string){
  if(this.disposed)throw Error('DRAFT_OWNER_DISPOSED');if(!id(idValue)||!id(documentId))throw Error('DRAFT_ID');
  const previous=this.slots.get(idValue);if(previous){if(previous.documentId!==documentId)throw Error('DRAFT_DOCUMENT_CHANGED');return previous;}
  if(this.all.size>=DRAFT_METADATA_LIMITS.ids)throw Error('DRAFT_ID_LIMIT');
  // Exact UTF-16 keys/identity/message aliases and the three numeric counters /
  // flags. This is logical application payload, not object/Map heap overhead.
  const bytes=(idValue.length*2+documentId.length+DRAFT_REFUSAL.length)*2+('id'+'documentId'+'refused'+'rows'+'editors'+'attached').length*2+19;
  const lease=allocationLedger.reserve({owner:'draft-identity',kind:'control',cpuBytes:bytes,handles:1});
  const slot={id:idValue,documentId,refused:false,rows:0,editors:0,attached:true,lease};this.slots.set(idValue,slot);this.all.add(slot);return slot;
 }
 attachRow(idValue:string,documentId:string){const slot=this.ensure(idValue,documentId);slot.rows++;let live=true;return ()=>{if(live){live=false;slot.rows--;this.collect(slot);}};}
 private collect(slot:Registration){if(slot.rows||slot.editors||slot.attached&&slot.refused)return;if(this.slots.get(slot.id)===slot)this.slots.delete(slot.id);slot.attached=false;if(this.all.delete(slot))slot.lease.release();if(!this.all.size){this.finish?.();this.finish=undefined;this.waiting=undefined;}}
 refuse(idValue:string,documentId:string){const slot=this.slots.get(idValue);if(!slot||slot.documentId!==documentId)throw Error('DRAFT_UNREGISTERED');slot.refused=true;}
 get(idValue:string){const slot=this.slots.get(idValue);return slot?.refused?slot:undefined;}
 delete(idValue:string){const slot=this.slots.get(idValue);if(!slot)return false;const changed=slot.refused;slot.refused=false;this.collect(slot);return changed;}
 clear(){for(const slot of this.slots.values()){slot.refused=false;this.collect(slot);}}
 *values(){for(const slot of this.slots.values())if(slot.refused)yield slot;}
 get size(){let size=0;for(const slot of this.slots.values())if(slot.refused)size++;return size;}
 assertSaved(documentId:string){for(const slot of this.slots.values())if(slot.documentId===documentId&&slot.refused)throw Error(DRAFT_REFUSAL);}
 dispose(){this.disposed=true;for(const slot of this.slots.values()){slot.attached=false;slot.refused=false;this.collect(slot);}this.slots.clear();}
 drain(){return this.all.size?this.waiting??=new Promise<void>(resolve=>{this.finish=resolve;}):Promise.resolve();}
 inspect(){return {identities:this.all.size,editableBorrowers:this.borrowers,refused:this.size};}
}
type RowOwner={value:LocalDraft;text:ModelPayload;releaseText:()=>void;metadata:AllocationLease;metadataBytes:number;releaseRegistration:()=>void;refs:number;live:boolean};
/** Each row owns exact stable metadata plus prospectively admitted status slots.
 * Generation/error/status writes stay within those slots even during pressure.
 * Retired rows survive only while a concrete asynchronous borrower pins them. */
export class DraftValues extends Map<string,LocalDraft>{
 private current=new Map<string,RowOwner>();private all=new Set<RowOwner>();
 constructor(private registrations:DraftRegistrations){super();}
 override set(idValue:string,draft:LocalDraft){
  if(idValue!==draft.id)throw Error('DRAFT_ID');if(this.all.size>=DRAFT_METADATA_LIMITS.rows)throw Error('DRAFT_ROW_LIMIT');
  if(typeof draft.text!=='string'||!id(draft.documentId)||!(draft.targetLayerId===null||id(draft.targetLayerId)))throw Error('DRAFT_METADATA');
  sequence(draft.generation);if(draft.savedGeneration!==null)sequence(draft.savedGeneration);sequence(draft.expectedDocumentRevision);
  if(typeof draft.pending!=='boolean'||typeof draft.composing!=='boolean'||!['prompt','inspector','text','mask','composition','request'].includes(draft.kind))throw Error('DRAFT_METADATA');
  const stable={id:draft.id,kind:draft.kind,documentId:draft.documentId,targetLayerId:draft.targetLayerId,expectedDocumentRevision:draft.expectedDocumentRevision,composing:draft.composing,...draft.maskBindings?{maskBindings:draft.maskBindings}:{},...draft.compositionBindings?{compositionBindings:draft.compositionBindings}:{}};
  const measured=measureControl(stable,DRAFT_METADATA_LIMITS.metadataBytes),releaseRegistration=this.registrations.attachRow(idValue,draft.documentId);let metadata:AllocationLease|undefined,text:ModelPayload|undefined,releaseText:(()=>void)|undefined;
  try{
   // Two bounded sequence strings, error string, fixed property names, pending
   // bool and map key. State transitions need no new reservation or arena.
   const bytes=measured.logicalBytes+idValue.length*2+4*DRAFT_METADATA_LIMITS.sequenceUnits+2*DRAFT_METADATA_LIMITS.errorUnits+('generation'+'savedGeneration'+'pending'+'error'+'text').length*2+1;
   metadata=allocationLedger.reserve({owner:'draft-row-metadata',kind:'control',cpuBytes:bytes,handles:1});
   const previous=this.current.get(idValue);if(previous?.value.text===draft.text){text=previous.text;releaseText=text.pin();}else{text=new ModelPayload(reservePromptPayload('draft-retained-text',draft.text.length*2));releaseText=()=>text!.release();}
   let generation=draft.generation,savedGeneration=draft.savedGeneration,pending=draft.pending,error=errorText(draft.error);
   const value={...freezeData(structuredClone(stable)),text:draft.text} as LocalDraft;
   Object.defineProperties(value,{generation:{enumerable:true,get:()=>generation,set:(next:string)=>{sequence(next);generation=next;}},savedGeneration:{enumerable:true,get:()=>savedGeneration,set:(next:string|null)=>{if(next!==null)sequence(next);savedGeneration=next;}},pending:{enumerable:true,get:()=>pending,set:(next:boolean)=>{if(typeof next!=='boolean')throw Error('DRAFT_METADATA');pending=next;}},error:{enumerable:true,get:()=>error,set:(next:unknown)=>{error=errorText(next);}}});Object.freeze(value);
   const row:RowOwner={value,text,releaseText,metadata,metadataBytes:bytes,releaseRegistration,refs:1,live:true};this.current.set(idValue,row);this.all.add(row);super.set(idValue,value);if(previous)this.releaseRoot(previous);return this;
  }catch(error){releaseText?.();metadata?.release();releaseRegistration();throw error;}
 }
 private unref(row:RowOwner){if(!--row.refs){row.releaseText();row.metadata.release();row.releaseRegistration();this.all.delete(row);}}
 private releaseRoot(row:RowOwner){if(row.live){row.live=false;this.unref(row);}}
 private pin(row:RowOwner){if(!row.refs)throw Error('DRAFT_ROW_RELEASED');row.refs++;let live=true;return ()=>{if(live){live=false;this.unref(row);}};}
 borrow(idValue:string):OwnedModel<LocalDraft>{
  const row=this.current.get(idValue);if(!row)throw Error('Draft missing');
  // A save retains scalar aliases (notably its original generation) while the
  // current row's bounded status slots may change. Book that working alias set.
  const aliases=allocationLedger.reserve({owner:'draft-row-borrow',kind:'control',cpuBytes:row.metadataBytes,handles:1}),releaseRow=this.pin(row);let refs=1,live=true;
  const unref=()=>{if(!--refs){aliases.release();releaseRow();}};return Object.freeze({value:row.value,release:()=>{if(live){live=false;unref();}},pin:()=>{if(!refs)throw Error('DRAFT_ROW_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});
 }
 borrowText(idValue:string):OwnedModel<string>{const row=this.current.get(idValue);if(!row)throw Error('Draft missing');return {value:row.value.text,release:row.text.pin(),pin:()=>row.text.pin()};}
 override delete(idValue:string){const row=this.current.get(idValue),removed=super.delete(idValue);this.current.delete(idValue);if(row)this.releaseRoot(row);return removed;}
 override clear(){super.clear();this.current.clear();for(const row of this.all)this.releaseRoot(row);}
 invalidate(){
  if(!this.size)return;const workspace=allocationLedger.reserve({owner:'draft-generation-work',kind:'control',cpuBytes:this.size*(DRAFT_METADATA_LIMITS.sequenceUnits*6+8),handles:1});
  try{const next:Array<readonly [LocalDraft,string]>=[];for(const row of this.values())next.push([row,nextDraftGeneration(row.generation)]);for(const [row,generation]of next){row.generation=generation;row.pending=false;row.savedGeneration=null;}}finally{workspace.release();}
 }
 inspect(){return {currentRows:this.size,retainedRows:this.all.size};}
}
