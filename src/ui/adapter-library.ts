import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Adapter,Eligibility,EligibleAdapter,Issue} from '../request/core.js';
import type {Asset} from '../protocol/assets.js';
import type {DomainEvent} from '../protocol/store.js';
import type {AdapterDeletionPlan,AdapterLibraryEntry,AdapterLibraryUpdates,AdapterLibraryPage as Page} from '../protocol/adapters.js';
import {isSupportedAdapterProfile} from '../adapters/profile.js';
import {ControlAdapter} from './adapters.js';
import {UIModelOwner} from './model-owner.js';
import {modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import type {AdapterOpaqueUpload} from '../observability/adapter-upload-hook.js';

type Filters={search:string;family:string;format:string;origin:string;status:string};
type Files={weights:File|null;config:File|null;provenance:File|null};
type ImportDraft={name:string;family:string;format:string;provenanceText:string;adapterId:string|null;previousVersionId:string|null};
type Prepared={draft:ImportDraft;weights:Asset;config:Asset|null;provenance:Asset|null;fileName:string};
type Replacement={index:number;update:AdapterLibraryUpdates;selection:readonly Adapter[]};
type JobUpdates={jobId:string;jobVersion:string;uses:readonly Adapter[];updates:AdapterLibraryUpdates[]};
type ValidationScope='import'|'search';
type ValidationIssue={target:string;message:string};
type Validation={scope:ValidationScope;items:ValidationIssue[]};
const forbiddenImportControl=(value:string)=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:EditorClient['draftOwner'];documentId:string|undefined;revision:string|undefined;epoch:number};
const adapterIdentity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
/** Compare already-owned bounded JSON metadata without serialized copies. */
function sameMetadata(a:unknown,b:unknown,depth=0):boolean{
 if(depth>64)throw Error('MODEL_MEMORY_DEPTH');
 if(Object.is(a,b))return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 if(Array.isArray(a)&&Array.isArray(b)){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!sameMetadata(a[i],b[i],depth+1))return false;return true;}
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
 for(const key in left)if(Object.hasOwn(left,key)&&(!Object.hasOwn(right,key)||!sameMetadata(left[key],right[key],depth+1)))return false;
 for(const key in right)if(Object.hasOwn(right,key)&&!Object.hasOwn(left,key))return false;
 return true;
}

export function attachAdapterVersion(selected:readonly Adapter[],entry:AdapterLibraryEntry):Adapter[]{
 if(!entry.available||!entry.locallyEligible||!isSupportedAdapterProfile(entry.profileId))throw Error('This version is stored, but cannot attach until its bytes and V4 compatibility profile are verified.');
 if(selected.some(a=>a.version===entry.versionId))throw Error('This exact adapter version is already attached.');
 if(selected.length>=3)throw Error('A request can attach at most three distinct adapter versions.');
 return [...selected.map(a=>({...a})),{version:entry.versionId,hash:entry.weights.hash,scale:'1'}];
}
/** Replacement is an explicit edit of one immutable request attachment. */
export function replaceAdapterVersion(selected:readonly Adapter[],index:number,update:AdapterLibraryUpdates):Adapter[]{
 const old=selected[index],from=update.current,to=update.latest;
 if(update.protocolVersion!==1||!old||!to||old.version!==from.versionId||old.hash!==from.weights.hash||to.adapterId!==from.adapterId||to.versionId===from.versionId||!adapterIdentity(to.versionId)||!/^sha256:[a-f0-9]{64}$/.test(to.weights.hash)||!/^([1-9][0-9]*)$/.test(from.version)||!/^([1-9][0-9]*)$/.test(to.version)||BigInt(to.version)<=BigInt(from.version))throw Error('Adapter replacement identities changed. Check for updates again.');
 if(!to.available||!to.locallyEligible||!isSupportedAdapterProfile(to.profileId))throw Error('The newer version is not available with a verified V4 compatibility profile. Keep the current attachment.');
 if(selected.some((item,i)=>i!==index&&item.version===to.versionId))throw Error('This successor version is already attached. Remove the duplicate explicitly before replacement.');
 adapterScale(old.scale);
 return selected.map((item,i)=>i===index?{version:to.versionId,hash:to.weights.hash,scale:old.scale}:{...item});
}
export function adapterScale(value:string):string{
 if(!value.trim()||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>4)throw Error('Adapter scale must be a number from 0 to 4.');
 return value;
}
const SCALE_DRAFT_CHARACTERS=64;
function scaleDraft(value:string):string{
 if(value.length>SCALE_DRAFT_CHARACTERS)throw Error('Adapter scale exceeds 64 characters. The previous complete value is retained.');
 return value;
}
function scaleError(value:string):string{
 try{adapterScale(value);return '';}catch{return 'Adapter scale must be a number from 0 to 4.';}
}
export function adapterImportProvenance(files:Files,text:string):string{
 if(text.length+(files.weights?.name.length??0)+(files.config?.name.length??0)+(files.provenance?.name.length??0)>4096)throw Error('Import provenance plus the original filenames exceeds 4096 characters. Shorten your provenance text; originals remain selected.');
 const value='Local filenames: '+JSON.stringify({weights:files.weights?.name??null,config:files.config?.name??null,provenance:files.provenance?.name??null})+'\nUser provenance: '+text;
 if(value.length>4096)throw Error('Import provenance plus the original filenames exceeds 4096 characters. Shorten your provenance text; originals remain selected.');
 return value;
}
export function adapterStatus(entry:AdapterLibraryEntry):string{
 if(!entry.available)return 'Missing artifact';
 if(entry.qualification==='incompatible')return 'Incompatible';
 if(!entry.locallyEligible)return entry.qualification==='unverified'?'Validation required':'Stored — compatibility unverified';
 return entry.runtimeVerified?'Runtime verified for recorded scopes':'Not runtime verified';
}

/** Local imports require a second, explicit registration action after hash review. */
export class AdapterLibraryEditing{
 private controls=new ControlAdapter();private uploadControllers=new Set<AbortController>();private epoch=0;private owner:Owner|null=null;private active:object|null=null;private latestAction:object|null=null;private disposed=false;
 private files:Files={weights:null,config:null,provenance:null};private draft:ImportDraft={name:'',family:'ideogram-v4',format:'fal',provenanceText:'',adapterId:null,previousVersionId:null};
 private shownFiles:Record<keyof Files,readonly File[]>={weights:[],config:[],provenance:[]};
 private prepared:Prepared|null=null;private items:AdapterLibraryEntry[]=[];private next:string|null=null;private loaded=false;private busy=false;private message='';private error='';private composing=false;
 private pageCursors:string[]=[''];private pageIndex=0;
 private validation:Validation|null=null;
 private deletion:AdapterDeletionPlan|null=null;private deletionReady=false;private models:UIModelOwner;
 private updates:AdapterLibraryUpdates[]=[];private replacement:Replacement|null=null;private jobUpdates:JobUpdates|null=null;
 private filters:Filters={search:'',family:'',format:'',origin:'',status:''};private selected:readonly Adapter[]=[];private requestIssues:readonly Issue[]=[];private change:((value:Adapter[])=>void)|null=null;
 constructor(private host:LitElement,private editor:EditorClient){this.models=new UIModelOwner(host,editor,'adapter-library-model');}
 get lifecycle(){return this.models.lifecycle;}
 /** Reveal and focus the first invalid attachment only while its exact view lives. */
 async focusInvalidScale():Promise<boolean>{
  const c=this.capture(),selected=this.selected,index=selected.findIndex(item=>!!scaleError(item.scale));
  const current=()=>this.owns(c)&&this.selected===selected&&!this.busy&&!this.composing&&this.editor.view.ready;
  if(index<0||!current())return false;
  return this.models.run(async()=>{
   if(!current())return false;
   const accordion=this.host.querySelector<HTMLElement&{open:boolean;requestOpen:(open:boolean)=>unknown;updateComplete:Promise<unknown>}>('#request-adapters');
   if(!accordion?.isConnected)return false;
   if(!accordion.open)accordion.requestOpen(true);
   await accordion.updateComplete;
   if(!current()||!accordion.isConnected||!accordion.open||this.host.querySelector('#request-adapters')!==accordion)return false;
   const field=this.host.querySelector<HTMLElement>('#request-adapter-scale-'+index);
   if(!field?.isConnected)return false;
   field.focus();return true;
  });
 }

 /** Navigate only a current strict issue; an unchecked switch is a recovery aid,
  * not evidence about that version's eligibility or stack runtime coverage. */
 async focusAttachmentIssue(issue:Issue,callerCurrent:()=>boolean=()=>true):Promise<boolean>{
  const c=this.capture(),selected=this.selected,issues=this.requestIssues,action=this.latestAction;
  const current=()=>callerCurrent()&&this.owns(c)&&this.selected===selected&&this.requestIssues===issues&&this.latestAction===action&&!this.busy&&!this.composing&&this.editor.view.ready;
  if(issue.field!=='adapters'||!issues.includes(issue)||!current())return false;
  let target:string|null=null;
  if(issue.code==='ADAPTER_COUNT')target=selected.length===0?'adapter-search':selected.length>3?'request-adapter-remove-3':null;
  if(issue.code==='DUPLICATE_ADAPTER'){const index=selected.findIndex((item,index)=>selected.slice(0,index).some(previous=>previous.version===item.version));if(index>=0)target='request-adapter-remove-'+index;}
  if(issue.code==='ADAPTER_RUNTIME_ACK_REQUIRED'){const index=selected.findIndex(item=>!item.runtimeAcknowledged);if(index>=0)target='request-adapter-ack-'+index;}
  if(!target)return false;
  return this.models.run(async()=>{
   if(!current())return false;
   const accordion=this.host.querySelector<HTMLElement&{open:boolean;requestOpen:(open:boolean)=>unknown;updateComplete:Promise<unknown>}>('#request-adapters');
   if(!accordion?.isConnected)return false;if(!accordion.open)accordion.requestOpen(true);await accordion.updateComplete;
   if(!current()||!accordion.isConnected||!accordion.open||this.host.querySelector('#request-adapters')!==accordion)return false;
   const field=this.host.querySelector<HTMLElement>('#'+target);if(!field?.isConnected)return false;
   field.focus();return true;
  });
 }

 async eligibility(uses:readonly Adapter[]=this.selected):Promise<Eligibility>{
  if(uses.length>16)throw Error('Adapter eligibility supports at most 16 exact versions.');
  return this.models.run(async()=>{
   const c=this.capture(),selected=this.selected,current=()=>this.owns(c)&&selected===this.selected,workspace=this.models.temporary(65536),adapters=new Map<string,EligibleAdapter>();
   try{for(const attachment of uses){
    if(!current())throw Error('Adapter selection changed. Review the current request again.');
    if(!adapterIdentity(attachment.version))throw Error('Adapter version identity is unavailable.');
    const model=await this.models.read<AdapterLibraryEntry>('/api/v1/adapters/'+encodeURIComponent(attachment.version),current,65536).catch(error=>{if(error instanceof Error&&error.name==='AbortError'&&!current())throw Error('Adapter selection changed. Review the current request again.');throw error;});
    try{const entry=model.value;if(!current())throw Error('Adapter selection changed. Review the current request again.');
     if(entry.versionId===attachment.version&&entry.locallyEligible&&isSupportedAdapterProfile(entry.profileId)&&entry.available){
      if(entry.versionId.length>128||!/^sha256:[a-f0-9]{64}$/.test(entry.weights.hash))throw Error('Adapter eligibility metadata is unavailable.');
      const value:EligibleAdapter={hash:entry.weights.hash,available:true,profile:'v4-safe-1',runtimeVerified:entry.runtimeVerified,configHash:entry.config===null?null:entry.config?.hash,runtimeProfile:entry.runtimeProfile??null,runtimeEvidence:entry.runtimeEvidence??[]};
      // Detach only after the bounded workspace admits the entire retained map.
      if(modelPayloadBytes([...adapters,[entry.versionId,value]])>65536)throw Error('UI_MODEL_LIMIT');
      adapters.set(entry.versionId,structuredClone(value));
     }
    }finally{model.release();}
   }
   const result={adapters},model=this.models.model(result,65536,[...adapters]);this.models.replace('eligibility',model);return result;
   }finally{workspace.release();}
  });
 }
 releaseDocument(){
  this.epoch++;for(const abort of this.uploadControllers)abort.abort();this.controls.invalidate();this.active=null;this.latestAction=null;this.owner=null;this.busy=false;this.composing=false;
  this.files={weights:null,config:null,provenance:null};this.shownFiles={weights:[],config:[],provenance:[]};
  this.prepared=null;this.deletion=null;this.deletionReady=false;this.updates=[];this.replacement=null;this.jobUpdates=null;this.items=[];this.next=null;this.loaded=false;this.pageCursors=[''];this.pageIndex=0;
  this.selected=[];this.requestIssues=[];this.change=null;this.message='';this.clearError();this.clearValidation();this.filters={search:'',family:'',format:'',origin:'',status:''};
  this.draft={name:'',family:'ideogram-v4',format:'fal',provenanceText:'',adapterId:null,previousVersionId:null};
  return this.models.release();
 }
 dispose(){this.disposed=true;return this.releaseDocument();}
 private changed(){this.host.requestUpdate();}
 private fileList(kind:keyof Files){const file=this.files[kind],shown=this.shownFiles[kind];if(shown[0]!==file&&!(shown.length===0&&file===null))this.shownFiles[kind]=file?[file]:[];return this.shownFiles[kind];}
 private capture():Owner{const session=this.editor.session,d=this.editor.view.document;return {session,identity:session.identity(),sessionId:this.editor.sessionId,draftOwner:this.editor.draftOwner,documentId:d?.id,revision:d?.revision,epoch:this.epoch};}
 private owns(c:Owner){const d=this.editor.view.document;return !this.disposed&&!this.models.releasing&&c.epoch===this.epoch&&c.session===this.editor.session&&c.identity===c.session.identity()&&c.sessionId===this.editor.sessionId&&c.draftOwner===this.editor.draftOwner&&c.documentId===d?.id&&c.revision===d?.revision;}
 private syncOwner(){if(this.owner&&!this.owns(this.owner))this.releaseDocument();this.owner=this.capture();}
 private fail(error:unknown){const value=error instanceof Error?error.message:String(error);try{const model=this.models.model(value,65536);this.models.replace('error',model);this.error=value;}catch{this.error='The local workspace cannot retain this error detail. Your previous view is retained.';this.models.clear('error');}this.changed();}
 private clearError(){this.error='';this.models.clear('error');}
 private clearValidation(){this.validation=null;this.models.clear('validation');}
 private validationError(target:string){return this.validation?.items.find(issue=>issue.target===target)?.message??'';}
 /** Preserve the explicit action limits and the registration protocol text rules. */
 private validationIssues(scope:ValidationScope,form:{files:Files;draft:ImportDraft;filters:Filters}={files:this.files,draft:this.draft,filters:this.filters}):ValidationIssue[]{
  const items:ValidationIssue[]=[];
  if(scope==='search'){
   for(const [key,value] of Object.entries(form.filters))if(value.length>120)items.push({target:key==='search'?'adapter-search':'adapter-'+key+'-filter',message:({search:'Search adapter names',family:'Filter by declared family',format:'Filter by naming format',origin:'Filter by origin',status:'Filter by validation status'} as Record<string,string>)[key]+' must contain at most 120 characters. Your complete input is retained.'});
   return items;
  }
  const {files,draft}=form;
  if(!files.weights)items.push({target:'adapter-weights',message:'Choose a local .safetensors weights file.'});
  else if(!/\.safetensors$/i.test(files.weights.name)||files.weights.size===0)items.push({target:'adapter-weights',message:'Choose a nonempty .safetensors file. The backend checks its actual format.'});
  for(const [key,label] of [['name','Adapter name'],['family','Declared model family'],['format','Declared naming format']] as const){
   if(!draft[key].trim()||draft[key].length>120)items.push({target:'adapter-'+key,message:label+' must contain 1–120 characters, including a non-space character.'});
   else if(forbiddenImportControl(draft[key]))items.push({target:'adapter-'+key,message:label+' cannot contain control characters other than tab, line feed or carriage return.'});
  }
  try{if(forbiddenImportControl(adapterImportProvenance(files,draft.provenanceText)))items.push({target:'adapter-provenance',message:'Import provenance cannot contain control characters other than tab, line feed or carriage return.'});}catch{items.push({target:'adapter-provenance',message:'Import provenance plus the original filenames exceeds 4096 characters. Shorten your provenance text or choose files with shorter names; originals remain selected.'});}
  return items;
 }
 private validate(scope:ValidationScope,current:()=>boolean):boolean{
  if(!current())return false;
  const items=this.validationIssues(scope);if(!items.length){this.clearValidation();return true;}
  // At most five fixed-wording issues, independent of untrusted input length.
  const validation={scope,items},model=this.models.model(validation,8192);try{this.models.replace('validation',model);}catch(error){model.release();throw error;}this.validation=validation;this.changed();
  return false;
 }
 private async focusValidation(c:Owner,validation:Validation,target:string):Promise<boolean>{
  const action=this.latestAction,current=()=>this.owns(c)&&this.latestAction===action&&this.validation===validation&&!this.busy&&!this.composing&&this.editor.view.ready;
  if(!validation.items.some(issue=>issue.target===target)||!current())return false;
  return this.models.run(async()=>{
   if(!current())return false;
   const accordion=this.host.querySelector<HTMLElement&{open:boolean;requestOpen:(open:boolean)=>unknown;updateComplete:Promise<unknown>}>('#request-adapters');
   if(!accordion?.isConnected)return false;
   if(!accordion.open)accordion.requestOpen(true);await accordion.updateComplete;
   if(!current()||!accordion.isConnected||!accordion.open||this.host.querySelector('#request-adapters')!==accordion)return false;
   const field=this.host.querySelector<HTMLElement>('#'+target);if(!field?.isConnected)return false;
   field.focus();return true;
  });
 }
 private form(patch:{draft?:ImportDraft;filters?:Filters;files?:Files}){
  const draft=patch.draft??this.draft,filters=patch.filters??this.filters,files=patch.files??this.files,nativeFiles=[...new Set(Object.values(files).filter((file):file is File=>file!==null))];
  const validation=this.validation?{scope:this.validation.scope,items:this.validationIssues(this.validation.scope,{draft,filters,files})}:null;
  const metadata={draft,filters,files:nativeFiles.map(file=>({name:file.name,type:file.type,size:file.size,lastModified:file.lastModified})),validation};
  const model=this.models.model({draft,filters,files,validation},65536,metadata,1+nativeFiles.length);try{this.models.replace('form',model);}catch(error){model.release();throw error;}this.draft=draft;this.filters=filters;this.files=files;
  // Corrections retain current remaining errors in the admitted form model;
  // replacing this snapshot also revokes any pending old-summary focus.
  this.models.clear('validation');this.validation=validation?.items.length?validation:null;
 }
 private changeDraft(patch:Partial<ImportDraft>){this.form({draft:{...this.draft,...patch}});}
 private clearPrepared(){this.prepared=null;this.models.clear('prepared');}
 private clearUpdates(){this.updates=[];this.models.clear('updates');this.clearReplacement();}
 private clearReplacement(){this.replacement=null;this.models.clear('replacement');}
 private clearDeletion(){this.deletion=null;this.deletionReady=false;this.models.clear('deletion');}
 private edit(event:Event,c:Owner,read:()=>string,set:(value:string)=>void,restore?:string){
  if(!this.owns(c))return;
  const host=event.currentTarget as HTMLElement&{value:string};let unpin:()=>void;
  try{unpin=this.models.hold();}catch(error){if(restore!==undefined)this.controls.write(host,'value',restore);this.fail(error);return;}
  this.controls.settled(event,read,value=>{if(!this.owns(c)||this.busy)return;try{set(value);this.clearPrepared();this.clearError();this.changed();}catch(e){if(restore!==undefined)this.controls.write(host,'value',restore);this.fail(e);}});queueMicrotask(unpin);
 }
 private action(event:Event,c:Owner,work:(current:()=>boolean)=>Promise<void>|void){
  if(!this.owns(c))return;
  let unpin:()=>void;try{unpin=this.models.hold();}catch(error){this.fail(error);return;}let settled=false;
  this.controls.action(event,()=>{
   settled=true;if(!this.owns(c)||this.busy||this.composing||!this.editor.view.ready){unpin();return;}
   const token={},priorValidation=this.validation;this.active=token;this.latestAction=token;this.busy=true;this.clearError();this.changed();const current=()=>this.active===token&&this.owns(c);
   let task:Promise<void>;try{task=this.models.run(()=>{if(current())return work(current);});}catch(error){task=Promise.reject(error);}
   void task.catch(e=>{if(current())this.fail(e);}).finally(async()=>{
    try{if(this.active===token){
     this.active=null;this.busy=false;this.changed();const validation=this.validation;
     if(validation&&validation!==priorValidation)try{await this.models.run(async()=>{
      await this.host.updateComplete;
      if(this.owns(c)&&this.latestAction===token&&!this.active&&!this.busy&&!this.composing&&this.editor.view.ready&&this.validation===validation){const summary=this.host.querySelector<HTMLElement>('#adapter-validation-summary');if(summary?.isConnected)summary.focus();}
     });}catch(error){if(this.owns(c)&&this.latestAction===token&&this.validation===validation)this.fail(error);}
    }}finally{unpin();}
   });
  });setTimeout(()=>{if(!settled)unpin();},0);
 }
 private selectFile(event:Event,c:Owner,kind:keyof Files){
  if(!this.owns(c))return;
  const host=event.currentTarget as HTMLElement&{files:readonly File[]};let unpin:()=>void;
  try{unpin=this.models.hold();}catch(error){this.controls.write(host,'files',this.fileList(kind));this.fail(error);return;}
  this.controls.settled(event,()=>host.files,files=>{if(!this.owns(c)||this.busy)return;try{const next={...this.files,[kind]:files[0]??null},draft=kind==='weights'&&files[0]&&!this.draft.name?{...this.draft,name:files[0].name.replace(/\.safetensors$/i,'').slice(0,120)}:this.draft;this.form({files:next,draft});this.clearPrepared();this.clearError();this.changed();}catch(error){this.controls.write(host,'files',this.fileList(kind));this.fail(error);}});queueMicrotask(unpin);
 }
 private original(events:readonly DomainEvent[]):Asset{const event=events.find(e=>e.type==='AssetRegistered');if(!event||event.type!=='AssetRegistered')throw Error('Original file registration acknowledgement is unavailable.');return event.payload.asset;}
 private async stage(file:File,purpose:'adapter'|'caption',current:()=>boolean,diagnosticUpload?:AdapterOpaqueUpload):Promise<OwnedModel<Asset>|null>{
  if(!current())return null;const abort=new AbortController();this.uploadControllers.add(abort);let staged:Awaited<ReturnType<EditorClient['ownedUpload']>>|undefined;
  try{staged=await this.editor.ownedUpload(file,purpose,purpose==='adapter'?'application/octet-stream':'text/plain',undefined,current,abort.signal,diagnosticUpload);if(!current())return null;const events=await this.editor.ownedCommand({type:'FinalizeStaging',stagingId:staged.value.stagingId,expectedSha256:staged.value.sha256},null);let transferred=false;
   try{if(!current())return null;const asset=this.original(events.value);transferred=true;return {value:asset,release:()=>events.release(),pin:()=>events.pin()};}finally{if(!transferred)events.release();}
  }finally{staged?.release();this.uploadControllers.delete(abort);}
 }
 private async prepare(current:()=>boolean){
  if(!this.validate('import',current))return;
  const workspace=this.models.temporary(65536);let weights:OwnedModel<Asset>|null=null,config:OwnedModel<Asset>|null=null,provenance:OwnedModel<Asset>|null=null;
  try{
  const files={...this.files},draft={...this.draft};if(!files.weights||!current())return;
  draft.provenanceText=adapterImportProvenance(files,draft.provenanceText);
  this.message='Hashing and transferring local originals. Structural inspection follows explicit registration.';this.changed();
  // Load the actual byte producer only for explicit import, before the first
  // selected File read. This cost stays inside the original import action.
  const {bindAdapterUpload}=await import('../observability/adapter-upload.js');if(!current())return;
  weights=await this.stage(files.weights,'adapter',current,bindAdapterUpload(files.weights,'adapter-weights'));if(!current()||!weights)return;
  config=files.config?await this.stage(files.config,'caption',current,bindAdapterUpload(files.config,'adapter-config')):null;if(!current())return;
  provenance=files.provenance?await this.stage(files.provenance,'caption',current,bindAdapterUpload(files.provenance,'adapter-provenance')):null;if(!current())return;
  const prepared={draft,weights:weights.value,config:config?.value??null,provenance:provenance?.value??null,fileName:files.weights.name},model=this.models.model(prepared,4*1024**2);this.models.replace('prepared',model);this.prepared=prepared;this.message='Original bytes are retained locally. Review their identities, then register this immutable version.';
  }finally{weights?.release();config?.release();provenance?.release();workspace.release();}
 }
 private async register(prepared:Prepared,current:()=>boolean){
  if(this.prepared!==prepared||!current())return;
  await this.editor.withCommandEvents({type:'RegisterAdapterVersion',adapterId:prepared.draft.adapterId,previousVersionId:prepared.draft.previousVersionId,weightsAssetId:prepared.weights.id,configAssetId:prepared.config?.id??null,provenanceAssetId:prepared.provenance?.id??null,name:prepared.draft.name,declaredFamily:prepared.draft.family,declaredFormat:prepared.draft.format,provenanceText:prepared.draft.provenanceText},()=>undefined,null);
  if(!current())return;this.form({files:{weights:null,config:null,provenance:null},draft:{...this.draft,adapterId:null,previousVersionId:null}});this.clearPrepared();await this.list(current);if(current()&&this.selected.length)await this.checkUpdates(current);if(current())this.message='Immutable adapter version registered. Inspect its compatibility status before attachment.';
 }
 private filterChanged(key:keyof Filters,value:string){this.form({filters:{...this.filters,[key]:value}});this.items=[];this.next=null;this.loaded=false;this.pageCursors=[''];this.pageIndex=0;this.models.clear('page');this.models.clear('cursors');}
 private async list(current:()=>boolean,direction:'first'|'previous'|'next'='first',focus=false){
  if(!current())return;
  if(!this.validate('search',current))return;
  if(direction==='next'&&this.next&&this.pageIndex>=1023)throw Error('Adapter page history is full. Return to the first page or start a new search.');
  const workspace=this.models.temporary(131072);let cursorModel:OwnedModel<string[]>|undefined,pageModel:OwnedModel<Page>|undefined,adopted=false;
  try{
  let cursors=direction==='first'?['']:[...this.pageCursors],index=direction==='first'?0:this.pageIndex;
  if(direction==='previous'){if(index===0)return;index--;}
  if(direction==='next'){if(!this.next)return;cursors=[...cursors.slice(0,index+1),this.next];index++;}
  const after=cursors[index]!;
  cursorModel=this.models.model(cursors,65536);if(after&&!adapterIdentity(after))throw Error('Adapter page cursor is unavailable.');
  const query=new URLSearchParams();for(const [key,value] of Object.entries(this.filters))if(value)query.set(key,value);if(after)query.set('after',after);
  pageModel=await this.models.read<Page>('/api/v1/adapters'+(query.size?'?'+query:''),current);if(!current())return;const page=pageModel.value;
  if(page.protocolVersion!==1||!Array.isArray(page.items)||page.items.length>20||page.nextAfter!==null&&!adapterIdentity(page.nextAfter))throw Error('Adapter library metadata is unavailable.');this.models.replace('page',pageModel);this.models.replace('cursors',cursorModel);adopted=true;this.items=page.items;this.next=page.nextAfter;this.loaded=true;this.pageCursors=cursors;this.pageIndex=index;
  if(focus){this.changed();await this.host.updateComplete;if(current())this.host.querySelector<HTMLElement>('#adapter-library-results')?.focus();}
  }finally{if(!adopted){cursorModel?.release();pageModel?.release();}workspace.release();}
 }
 private async saveDependencies(current:()=>boolean){
  const owner=this.editor.draftOwner;if(!owner)throw Error('The current draft owner is unavailable. Reconnect before deletion review.');
  const unsaved=()=>[...owner.drafts.values()].some(d=>d.pending||d.composing||d.savedGeneration!==d.generation);
  await this.editor.flushDrafts();if(!current())return;
  if(unsaved()){await this.editor.flushDrafts();if(!current())return;}
  if(unsaved())throw Error('Save or finish composing the current drafts before reviewing adapter deletion.');
 }
 private async previewDeletion(entry:AdapterLibraryEntry,current:()=>boolean){
  this.deletionReady=false;await this.saveDependencies(current);if(!current())return;
  await this.editor.withCommandEvents({type:'PreviewAdapterDeletion',versionId:entry.versionId},async events=>{if(!current())return;const asset=this.original(events);
  const record=asset.adapterDeletion;if(record?.kind!=='preview'||record.versionId!==entry.versionId||!adapterIdentity(record.planId))throw Error('Adapter deletion preview acknowledgement is unavailable.');
  const model=await this.models.read<AdapterDeletionPlan>('/api/v1/adapters/deletion-reviews/'+encodeURIComponent(record.planId),current);let adopted=false;
  try{if(!current())return;const plan=model.value;if(plan.kind!=='adapter-deletion-plan-1'||plan.id!==record.planId||plan.versionId!==entry.versionId||plan.token!==record.token)throw Error('Adapter deletion review changed. Prepare a fresh preview.');this.models.replace('deletion',model);adopted=true;this.deletion=plan;this.deletionReady=true;this.message=plan.canDelete?'Review removal of this library version. Original bytes will be retained.':'This library version is still referenced. Resolve the listed dependencies before preparing a fresh deletion review.';}finally{if(!adopted)model.release();}
  },null);
 }
 private async deleteVersion(plan:AdapterDeletionPlan,current:()=>boolean){
  if(this.deletion!==plan||!this.deletionReady||!plan.canDelete||!current())return;
  await this.saveDependencies(current);if(!current()||this.deletion!==plan)return;this.deletionReady=false;
  await this.editor.withCommandEvents({type:'DeleteAdapterVersion',versionId:plan.versionId,planId:plan.id,token:plan.token},async events=>{if(!current())return;const asset=this.original(events);
  const record=asset.adapterDeletion;if(record?.kind!=='deleted'||record.versionId!==plan.versionId||record.planId!==plan.id)throw Error('Adapter deletion acknowledgement is unavailable. Inspect a fresh library page before trying again.');
  this.clearDeletion();await this.list(current);if(current())this.message='Library version deleted. Original bytes and retained provenance remain; no disk space was freed.';
  },null);
 }
 private async readUpdates(uses:readonly Adapter[],current:()=>boolean):Promise<OwnedModel<AdapterLibraryUpdates[]>|null>{
  if(uses.length>3)throw Error('Review at most three adapter attachments at a time.');
  const workspace=this.models.temporary(196608),updates:AdapterLibraryUpdates[]=[];let bytes=0,result:OwnedModel<AdapterLibraryUpdates[]>|undefined;
  try{for(const use of uses){
   if(!adapterIdentity(use.version))throw Error('Adapter version identity is unavailable.');
   const response=await this.models.read<AdapterLibraryUpdates>('/api/v1/adapters/'+encodeURIComponent(use.version)+'/updates',current,65536);
   try{if(!current())return null;const update=response.value;if(update.protocolVersion!==1||update.current?.versionId!==use.version||update.current.weights.hash!==use.hash||update.latest!==null&&(update.latest.adapterId!==update.current.adapterId||!adapterIdentity(update.latest.versionId)))throw Error('Adapter update metadata changed. Check again.');const nextBytes=bytes+modelPayloadBytes(update);if(nextBytes>196608)throw Error('UI_MODEL_LIMIT');updates.push(structuredClone(update));bytes=nextBytes;}finally{response.release();}
  }
  if(!current())return null;result=this.models.model(updates,196608);return result;
  }finally{workspace.release();}
 }
 private async checkUpdates(current:()=>boolean){
  const selected=this.selected,owns=()=>current()&&this.selected===selected,model=await this.readUpdates(selected,owns);if(!model)return;
  let adopted=false;try{if(!owns())return;this.models.replace('updates',model);adopted=true;this.updates=model.value;this.clearReplacement();this.message=this.updates.some(update=>update.latest)?'Newer library versions are available. Existing attachments and accepted jobs stay on their exact versions until an explicit replacement.':'These attachments have no newer registered library versions.';}finally{if(!adopted)model.release();}
 }
 private async previewReplacement(index:number,current:()=>boolean){
  const selected=this.selected,owns=()=>current()&&this.selected===selected;if(!selected[index])return;
  const response=await this.readUpdates([selected[index]!],owns);if(!response)return;
  try{if(!owns())return;const update=response.value[0]!;replaceAdapterVersion(selected,index,update);
   const review:Replacement={index,update,selection:selected},model=this.models.model(review,196608);let adopted=false;
   try{if(!owns())return;this.models.replace('replacement',model);adopted=true;this.replacement=review;this.message='Review the exact attachment replacement. Only this draft changes after confirmation.';}finally{if(!adopted)model.release();}
   this.changed();await this.host.updateComplete;if(owns())this.host.querySelector<HTMLElement>('#adapter-replacement-review')?.focus();
  }finally{response.release();}
 }
 private async confirmReplacement(review:Replacement,c:Owner,current:()=>boolean){
  if(this.replacement!==review||this.selected!==review.selection||!current())return;
  const owns=()=>current()&&this.replacement===review&&this.selected===review.selection,response=await this.readUpdates([review.selection[review.index]!],owns);if(!response)return;
  try{if(!owns())return;const fresh=response.value[0]!;
   if(!sameMetadata(fresh,review.update))throw Error('The replacement version or its availability changed. Check for updates and review again.');
   const next=replaceAdapterVersion(review.selection,review.index,fresh);if(!owns())return;
   this.selectedChange(c,review.selection,next);this.message='Attachment replaced in this draft. Review runtime uncertainty again before request review. Old accepted jobs remain unchanged.';
  }finally{response.release();}
 }
 private async inspectJobUpdates(jobId:string,jobVersion:string,resolve:(id:string,version:string)=>readonly Adapter[]|null,current:()=>boolean){
  if(!adapterIdentity(jobId))throw Error('Retained job identity is unavailable.');
  const workspace=this.models.temporary(196608);let snapshot:OwnedModel<Adapter[]>|undefined;
  try{const uses=resolve(jobId,jobVersion);if(!current()||!uses)return;if(uses.length>3)throw Error('Review at most three adapter attachments at a time.');
   snapshot=this.models.model(uses.map(use=>({...use})),65536);const owns=()=>current()&&resolve(jobId,jobVersion)!==null,response=await this.readUpdates(snapshot.value,owns);if(!response)return;
   try{if(!owns())return;const value:JobUpdates={jobId,jobVersion,uses:snapshot.value,updates:response.value},model=this.models.model(value,196608);let adopted=false;
    try{if(!owns())return;this.models.replace('job-updates',model);adopted=true;this.jobUpdates=value;}finally{if(!adopted)model.release();}
   }finally{response.release();}
  }finally{snapshot?.release();workspace.release();}
 }
 renderJobUpdates(jobId:string,jobVersion:string,resolve:(id:string,version:string)=>readonly Adapter[]|null){
  if(this.disposed)return nothing;this.syncOwner();const c=this.capture(),view=this.jobUpdates?.jobId===jobId&&this.jobUpdates.jobVersion===jobVersion?this.jobUpdates:null;
  return html`<en-button id=${'adapter-job-updates-'+jobId} ?disabled=${this.busy||this.models.releasing||!this.editor.view.ready} @click=${(event:Event)=>this.action(event,c,current=>this.inspectJobUpdates(jobId,jobVersion,resolve,current))}>Inspect adapter updates</en-button>${view?html`<en-card aria-label="Retained job adapter updates"><p>This accepted job retains its exact versions, order and scales. A library update cannot change or resubmit it.</p>${view.updates.map((update,index)=>html`<p>${index+1}. Accepted ${update.current.versionId} · scale ${view.uses[index]!.scale}. ${update.latest?'Update available: version '+update.latest.version+' ('+update.latest.versionId+'). '+adapterStatus(update.latest)+'. '+update.latest.reason:'No newer registered version.'}</p>`)}</en-card>`:nothing}`;
 }
 private attachmentUpdate(item:Adapter,index:number,c:Owner,unavailable:boolean){
  const update=this.updates.find(value=>value.current.versionId===item.version);if(!update)return nothing;const latest=update.latest;
  return html`<p>${latest?'Update available: version '+latest.version+' ('+latest.versionId+'). '+adapterStatus(latest)+'. '+latest.reason:'No newer registered version.'}</p>${latest?html`<en-button id=${'review-adapter-replacement-'+item.version} ?disabled=${unavailable||!latest.available||!latest.locallyEligible||!isSupportedAdapterProfile(latest.profileId)} @click=${(event:Event)=>this.action(event,c,current=>this.previewReplacement(index,current))}>Review replacement for adapter ${index+1}</en-button>`:nothing}`;
 }
 private runtimeEvidence(entry:AdapterLibraryEntry){const observations=entry.runtimeEvidence??[];if(!observations.length)return nothing;return html`<en-accordion-item label="Scoped runtime evidence"><p>Successful retained output was observed for each recorded scope. These observations do not establish image quality or compatibility with other endpoints, profiles or adapter combinations. Request review checks the current operation and the entire ordered stack separately.</p>${observations.slice(0,4).map(evidence=>html`<section aria-label="Recorded adapter run"><p>Endpoint ${evidence.scope.endpoint}</p><p>Schema ${evidence.scope.schemaHash} · route ${evidence.scope.routeHash}</p><p>Production profile ${evidence.scope.profile.id} · version ${evidence.scope.profile.version} · evidence ${evidence.scope.profile.evidenceDigest}</p><p>Job ${evidence.jobId} · attempt ${evidence.attemptId} · request ${evidence.requestId}</p><p>Retained output ${evidence.outputAssetId} · ${evidence.outputHash}</p><p>Ordered stack: ${evidence.scope.adapters.map((adapter,index)=>(index+1)+'. '+adapter.version+' · weights '+adapter.weightsHash+' · config '+(adapter.configHash??'not supplied')+' · scale '+adapter.scale).join('; ')}</p></section>`)}</en-accordion-item>`;}
 private selectedChange(c:Owner,selected:readonly Adapter[],next:Adapter[]){if(!this.owns(c)||this.selected!==selected||!this.change)return;this.change(next);this.selected=next;this.clearUpdates();this.clearError();this.changed();}
 render(selected:readonly Adapter[],change:(next:Adapter[])=>void,issues:readonly Issue[]=[]){
  if(this.disposed)return nothing;
  this.syncOwner();if(this.selected!==selected)this.clearUpdates();this.selected=selected;this.change=change;this.requestIssues=issues;const c=this.capture(),prepared=this.prepared,deletion=this.deletion,replacement=this.replacement,validation=this.validation,unavailable=this.busy||this.models.releasing||!this.editor.view.ready,act=(e:Event,work:(current:()=>boolean)=>Promise<void>|void)=>this.action(e,c,work),field=(e:Event,set:(value:string)=>void,restore?:string)=>{const host=e.currentTarget as HTMLElement&{value:string};this.edit(e,c,()=>host.value,set,restore);};
  const countError=selected.length>3||!selected.length&&issues.some(issue=>issue.field==='adapters'&&issue.code==='ADAPTER_COUNT'),ackError=issues.some(issue=>issue.field==='adapters'&&issue.code==='ADAPTER_RUNTIME_ACK_REQUIRED');
  const text=(id:string,label:string,value:string,set:(v:string)=>void)=>html`<en-text-field id=${id} label=${label} .value=${value} .error=${this.validationError(id)} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,set,value)}></en-text-field>`;
  const filter=(key:keyof Filters,label:string,values:string[])=>html`<en-select label=${label} id=${'adapter-'+key+'-filter'} .value=${this.filters[key]} .error=${this.validationError('adapter-'+key+'-filter')} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,v=>this.filterChanged(key,v),this.filters[key])}><en-select-option value="">All</en-select-option>${values.map(v=>html`<en-select-option value=${v}>${v}</en-select-option>`)}</en-select>`;
  return html`<en-accordion-item id="request-adapters" tabindex="-1" label="Adapter library"><section aria-label="Local adapter library" aria-busy=${String(this.busy)} @compositionstart=${()=>{if(this.owns(c))this.composing=true;}} @compositionend=${()=>{if(this.owns(c))this.composing=false;}}>
   ${!this.editor.view.ready?html`<p>Reconnect to the local editor before importing or changing library entries.</p>`:nothing}
   <p>Import local V4 .safetensors weights and optional config/provenance. Source links are retained as text. Structural validation alone does not establish provider compatibility.</p>
   ${validation?html`<en-validation-summary id="adapter-validation-summary" tabindex="-1" heading="Adapter library needs attention" .items=${validation.items} @en-action=${(event:Event)=>{if(event.defaultPrevented)return;event.preventDefault();const target=(event as CustomEvent).detail?.data?.target;if(typeof target==='string')void this.focusValidation(c,validation,target).catch(error=>{if(this.owns(c)&&this.validation===validation)this.fail(error);});}}></en-validation-summary>`:nothing}
   <en-file-upload id="adapter-weights" label="Adapter weights" accept=".safetensors" .files=${this.fileList('weights')} .error=${this.validationError('adapter-weights')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'weights')}></en-file-upload><en-file-upload label="Optional adapter config" accept=".json,.txt" .files=${this.fileList('config')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'config')}></en-file-upload><en-file-upload label="Optional adapter provenance" accept=".json,.txt" .files=${this.fileList('provenance')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'provenance')}></en-file-upload>
   ${this.files.weights?html`<p>${this.files.weights.name} · ${this.files.weights.size} bytes · local file</p>`:nothing}
   ${text('adapter-name','Adapter name',this.draft.name,v=>this.changeDraft({name:v}))}${text('adapter-family','Declared model family',this.draft.family,v=>this.changeDraft({family:v}))}${text('adapter-format','Declared naming format',this.draft.format,v=>this.changeDraft({format:v}))}
   <en-textarea id="adapter-provenance" label="Import provenance (text only)" .value=${this.draft.provenanceText} .error=${this.validationError('adapter-provenance')} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,v=>this.changeDraft({provenanceText:v}),this.draft.provenanceText)}></en-textarea><p>Provenance and the recorded original filenames must fit 4096 characters. The complete retained text appears in registration review.</p>
   ${this.draft.previousVersionId?html`<p>New version of ${this.draft.adapterId}; previous ${this.draft.previousVersionId}. Existing requests keep their exact versions.</p><en-button ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.changeDraft({adapterId:null,previousVersionId:null});this.clearPrepared();})}>Import as a separate adapter</en-button>`:nothing}
   <en-button id="prepare-adapter-import" ?disabled=${unavailable||this.composing||!this.files.weights} @click=${(e:Event)=>act(e,current=>this.prepare(current))}>Review local adapter import</en-button>
   ${prepared?html`<en-card aria-label="Adapter registration review"><h3>Register immutable adapter version</h3><p>${prepared.fileName} · ${prepared.weights.blob.byteLength} bytes</p><p>Weights ${prepared.weights.blob.hash}</p><p>Declared family ${prepared.draft.family}; naming format ${prepared.draft.format}. Source: local import.</p><p>${prepared.config?'Config '+prepared.config.blob.hash:'Config not supplied; V4 compatibility not runtime verified'}</p>${prepared.provenance?html`<p>Provenance file ${prepared.provenance.blob.hash}</p>`:nothing}<p>${prepared.draft.provenanceText}</p><p>Registration performs safe structural inspection. Attachment requires a supported V4 compatibility profile. No provider call occurs.</p><en-button id="register-adapter-version" ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.register(prepared,current))}>Register these exact local files</en-button></en-card>`:nothing}
   <h3 id="adapter-library-results" tabindex="-1">Stored versions</h3>${text('adapter-search','Search adapter names',this.filters.search,v=>this.filterChanged('search',v))}
   ${text('adapter-family-filter','Filter by declared family',this.filters.family,v=>this.filterChanged('family',v))}${text('adapter-format-filter','Filter by naming format',this.filters.format,v=>this.filterChanged('format',v))}${filter('origin','Filter by origin',['import','training'])}${filter('status','Filter by validation status',['unverified','structurally-valid','runtime-verified','incompatible'])}
   <en-button id="search-adapter-library" ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.list(current,'first',true))}>Search local library</en-button>
   ${this.loaded?html`<p aria-live="polite" aria-atomic="true">Adapter library page ${this.pageIndex+1} · ${this.items.length} stored versions shown.</p>`:nothing}
   ${this.loaded&&!this.items.length?html`<p>No matching stored adapters. Import a V4 adapter or adjust the filters.</p>`:nothing}
   ${this.items.map(item=>html`<en-card><h4>${item.name}</h4><p>${item.versionId} · version ${item.version} · ${item.declaredFamily} · ${item.declaredFormat}</p><p>${adapterStatus(item)}. ${item.reason}</p>${this.runtimeEvidence(item)}<p>${item.weights.byteLength} bytes · ${item.weights.hash}</p><p>${item.config?'Config '+item.config.hash:'Config not supplied'}</p><en-button ?disabled=${unavailable||!item.available||!item.locallyEligible||!isSupportedAdapterProfile(item.profileId)||selected.length>=3||selected.some(a=>a.version===item.versionId)} @click=${(e:Event)=>act(e,()=>this.selectedChange(c,selected,attachAdapterVersion(selected,item)))}>Attach exact version ${item.version}</en-button><en-button ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.form({draft:{...this.draft,name:item.name,family:item.declaredFamily,format:item.declaredFormat,adapterId:item.adapterId,previousVersionId:item.versionId},files:{weights:null,config:null,provenance:null}});this.clearPrepared();this.message='Choose replacement local files. Registration creates a new version; existing drafts and jobs stay unchanged.';})}>Import a new version</en-button><en-button id=${'preview-adapter-deletion-'+item.versionId} ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.previewDeletion(item,current))}>Review deletion of version ${item.version}</en-button></en-card>`)}
   ${this.loaded?html`<nav aria-label="Adapter library pages"><en-button id="first-adapter-page" ?disabled=${unavailable||this.pageIndex===0} @click=${(e:Event)=>act(e,current=>this.list(current,'first',true))}>First adapter page</en-button><en-button id="previous-adapter-page" ?disabled=${unavailable||this.pageIndex===0} @click=${(e:Event)=>act(e,current=>this.list(current,'previous',true))}>Previous adapter page</en-button><en-button id="next-adapter-page" ?disabled=${unavailable||!this.next} @click=${(e:Event)=>act(e,current=>this.list(current,'next',true))}>Next adapter page</en-button></nav>`:nothing}
   ${deletion?html`<en-card aria-label="Adapter deletion review"><h3>Delete this library version?</h3><p>${deletion.versionId} · version ${deletion.version} · ${deletion.weights.hash}</p><p>${deletion.dependencyCount} retained dependencies. Original bytes remain stored. No disk space will be freed.</p>${deletion.dependencies.map(reason=>html`<p>${reason.kind}: ${reason.id} · ${reason.detail}</p>`)}${deletion.dependenciesTruncated?html`<p>Additional retained dependencies are omitted from this bounded view. Deletion remains blocked.</p>`:nothing}${!deletion.canDelete?html`<p>Deletion is blocked until all retained dependencies are resolved. Removing a current attachment does not remove prior history.</p>`:nothing}<en-button id="confirm-adapter-deletion" ?disabled=${unavailable||!this.deletionReady||!deletion.canDelete} @click=${(e:Event)=>act(e,current=>this.deleteVersion(deletion,current))}>Confirm deletion of this library version</en-button><en-button id="keep-adapter-version" ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.clearDeletion();this.message='Library version kept.';})}>Keep library version</en-button></en-card>`:nothing}
   <h3 id="request-adapter-scales" tabindex="-1">Ordered request attachments</h3>${countError?html`<p id="request-adapter-count-error" role="alert">Adapter operations require 1–3 attachments. ${selected.length?'Remove an attachment to meet that limit; every current attachment is retained until you remove it.':'Choose an eligible version from the local library.'}</p>`:nothing}${ackError?html`<p id="request-adapter-ack-error" role="alert">This request requires runtime uncertainty acknowledgement. Review the unchecked acknowledgements below; local eligibility is checked separately.</p>`:nothing}<p>Attach 1–3 distinct versions for an adapter operation. Scale 0 is retained. Provider mixing behavior is unqualified.</p><p>A recorded run can waive runtime uncertainty acknowledgement only when its endpoint, schema, route, current production profile and complete ordered weights/config/scale stack match this request.</p><en-button id="check-adapter-updates" ?disabled=${unavailable||!selected.length} @click=${(e:Event)=>act(e,current=>this.checkUpdates(current))}>Check attachment updates</en-button>
   ${replacement?html`<en-card id="adapter-replacement-review" tabindex="-1" aria-label="Adapter attachment replacement review"><h3>Replace this request attachment?</h3><p>Position ${replacement.index+1}; scale ${replacement.selection[replacement.index]!.scale} stays unchanged.</p><p>Current ${replacement.update.current.versionId} · version ${replacement.update.current.version} · weights ${replacement.update.current.weights.hash} · ${replacement.update.current.config?'config '+replacement.update.current.config.hash:'config not supplied'}.</p><p>Proposed ${replacement.update.latest!.versionId} · version ${replacement.update.latest!.version} · weights ${replacement.update.latest!.weights.hash} · ${replacement.update.latest!.config?'config '+replacement.update.latest!.config.hash:'config not supplied'}.</p><p>${adapterStatus(replacement.update.latest!)}. ${replacement.update.latest!.reason}</p><p>This changes one attachment in the current draft and invalidates its request review. The old version and accepted jobs remain unchanged. Runtime uncertainty acknowledgement resets for the new version.</p><en-button id="confirm-adapter-replacement" ?disabled=${unavailable} @click=${(event:Event)=>act(event,current=>this.confirmReplacement(replacement,c,current))}>Confirm replacement in this draft</en-button><en-button id="keep-adapter-attachment" ?disabled=${unavailable} @click=${(event:Event)=>act(event,()=>{this.clearReplacement();this.message='Current attachment kept.';})}>Keep current version</en-button></en-card>`:nothing}
   ${selected.map((item,index)=>html`<en-card><p>${index+1}. ${item.version} · ${item.hash}</p>${this.attachmentUpdate(item,index,c,unavailable)}${selected.slice(0,index).some(previous=>previous.version===item.version)?html`<p id=${'request-adapter-duplicate-'+index} role="alert">This exact version is already attached earlier in the list. Adapter operations require distinct versions; remove a repeated attachment.</p>`:nothing}<en-number-field label=${'Scale for adapter '+(index+1)} id=${'request-adapter-scale-'+index} .min=${0} .max=${4} .step=${0.1} .value=${item.scale} .error=${scaleError(item.scale)} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,value=>this.selectedChange(c,selected,selected.map((a,i)=>i===index?{...a,scale:scaleDraft(value)}:{...a})),item.scale)}></en-number-field><en-switch label=${'Acknowledge runtime uncertainty for adapter '+(index+1)} id=${'request-adapter-ack-'+index} .checked=${item.runtimeAcknowledged===true} ?disabled=${unavailable} @en-change=${(e:Event)=>{const host=e.currentTarget as HTMLElement&{checked:boolean};this.controls.settled(e,()=>host.checked,value=>{if(!this.owns(c)||this.busy||this.composing)return;try{this.selectedChange(c,selected,selected.map((a,i)=>i===index?{...a,runtimeAcknowledged:value}:{...a}));}catch(error){this.controls.write(host,'checked',item.runtimeAcknowledged===true);this.fail(error);}});}}></en-switch><en-button ?disabled=${unavailable||index===0} @click=${(e:Event)=>act(e,()=>{const next=selected.map(a=>({...a}));[next[index-1],next[index]]=[next[index]!,next[index-1]!];this.selectedChange(c,selected,next);})}>Move adapter ${index+1} earlier</en-button><en-button ?disabled=${unavailable||index===selected.length-1} @click=${(e:Event)=>act(e,()=>{const next=selected.map(a=>({...a}));[next[index+1],next[index]]=[next[index]!,next[index+1]!];this.selectedChange(c,selected,next);})}>Move adapter ${index+1} later</en-button><en-button id=${'request-adapter-remove-'+index} ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>this.selectedChange(c,selected,selected.filter((_,i)=>i!==index).map(a=>({...a}))))}>Remove adapter ${index+1}</en-button></en-card>`)}
   ${this.message?html`<p role="status">${this.message}</p>`:nothing}${this.error?html`<en-alert role="alert">${this.error}</en-alert>`:nothing}
  </section></en-accordion-item>`;
 }
}
