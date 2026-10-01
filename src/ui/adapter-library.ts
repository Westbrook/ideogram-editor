import {html,nothing} from 'lit';
import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Adapter,Eligibility} from '../request/core.js';
import type {Asset} from '../protocol/assets.js';
import type {DomainEvent} from '../protocol/store.js';
import type {AdapterDeletionPlan,AdapterLibraryEntry,AdapterLibraryPage as Page} from '../protocol/adapters.js';
import {isSupportedAdapterProfile} from '../adapters/profile.js';
import {ControlAdapter} from './adapters.js';

type Filters={search:string;family:string;format:string;origin:string;status:string};
type Files={weights:File|null;config:File|null;provenance:File|null};
type ImportDraft={name:string;family:string;format:string;provenanceText:string;adapterId:string|null;previousVersionId:string|null};
type Prepared={draft:ImportDraft;weights:Asset;config:Asset|null;provenance:Asset|null;fileName:string};
type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;draftOwner:EditorClient['draftOwner'];documentId:string|undefined;revision:string|undefined;epoch:number};

export function attachAdapterVersion(selected:readonly Adapter[],entry:AdapterLibraryEntry):Adapter[]{
 if(!entry.available||!entry.locallyEligible||!isSupportedAdapterProfile(entry.profileId))throw Error('This version is stored, but cannot attach until its bytes and V4 compatibility profile are verified.');
 if(selected.some(a=>a.version===entry.versionId))throw Error('This exact adapter version is already attached.');
 if(selected.length>=3)throw Error('A request can attach at most three distinct adapter versions.');
 return [...selected.map(a=>({...a})),{version:entry.versionId,hash:entry.weights.hash,scale:'1'}];
}
export function adapterScale(value:string):string{
 if(!value.trim()||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>4)throw Error('Adapter scale must be a number from 0 to 4.');
 return value;
}
export function adapterImportProvenance(files:Files,text:string):string{
 const value='Local filenames: '+JSON.stringify({weights:files.weights?.name??null,config:files.config?.name??null,provenance:files.provenance?.name??null})+'\nUser provenance: '+text;
 if(value.length>4096)throw Error('Import provenance plus the original filenames exceeds 4096 characters. Shorten your provenance text; originals remain selected.');
 return value;
}
export function adapterStatus(entry:AdapterLibraryEntry):string{
 if(!entry.available)return 'Missing artifact';
 if(entry.qualification==='incompatible')return 'Incompatible';
 if(!entry.locallyEligible)return entry.qualification==='unverified'?'Validation required':'Stored — compatibility unverified';
 return entry.runtimeVerified?'Runtime verified for recorded endpoint':'Not runtime verified';
}

/** Local imports require a second, explicit registration action after hash review. */
export class AdapterLibraryEditing{
 private controls=new ControlAdapter();private epoch=0;private owner:Owner|null=null;private active:object|null=null;private disposed=false;
 private files:Files={weights:null,config:null,provenance:null};private draft:ImportDraft={name:'',family:'ideogram-v4',format:'fal',provenanceText:'',adapterId:null,previousVersionId:null};
 private shownFiles:Record<keyof Files,readonly File[]>={weights:[],config:[],provenance:[]};
 private prepared:Prepared|null=null;private items:AdapterLibraryEntry[]=[];private next:string|null=null;private loaded=false;private busy=false;private message='';private error='';private composing=false;
 private pageCursors:string[]=[''];private pageIndex=0;
 private deletion:AdapterDeletionPlan|null=null;
 private filters:Filters={search:'',family:'',format:'',origin:'',status:''};private selected:readonly Adapter[]=[];private change:((value:Adapter[])=>void)|null=null;
 constructor(private host:LitElement,private editor:EditorClient){}
 async eligibility(uses:readonly Adapter[]=this.selected):Promise<Eligibility>{
  const c=this.capture(),selected=this.selected;const adapters=new Map<string,{hash:string;available:boolean;profile:'v4-safe-1';runtimeVerified:boolean}>();
  for(const attachment of uses.slice(0,16)){
   if(!this.owns(c)||selected!==this.selected)throw Error('Adapter selection changed. Review the current request again.');
   const entry=await this.editor.json<AdapterLibraryEntry>('/api/v1/adapters/'+encodeURIComponent(attachment.version));
   if(!this.owns(c)||selected!==this.selected)throw Error('Adapter selection changed. Review the current request again.');
   if(entry.versionId===attachment.version&&entry.locallyEligible&&isSupportedAdapterProfile(entry.profileId)&&entry.available)adapters.set(entry.versionId,{hash:entry.weights.hash,available:true,profile:'v4-safe-1',runtimeVerified:entry.runtimeVerified});
  }
  return {adapters};
 }
 releaseDocument(){
  this.epoch++;this.controls.invalidate();this.active=null;this.owner=null;this.busy=false;this.composing=false;
  this.files={weights:null,config:null,provenance:null};this.shownFiles={weights:[],config:[],provenance:[]};
  this.prepared=null;this.deletion=null;this.items=[];this.next=null;this.loaded=false;this.pageCursors=[''];this.pageIndex=0;
  this.selected=[];this.change=null;this.message='';this.error='';this.filters={search:'',family:'',format:'',origin:'',status:''};
  this.draft={name:'',family:'ideogram-v4',format:'fal',provenanceText:'',adapterId:null,previousVersionId:null};
 }
 dispose(){this.releaseDocument();this.disposed=true;}
 private changed(){this.host.requestUpdate();}
 private fileList(kind:keyof Files){const file=this.files[kind],shown=this.shownFiles[kind];if(shown[0]!==file&&!(shown.length===0&&file===null))this.shownFiles[kind]=file?[file]:[];return this.shownFiles[kind];}
 private capture():Owner{const session=this.editor.session,d=this.editor.view.document;return {session,identity:session.identity(),sessionId:this.editor.sessionId,draftOwner:this.editor.draftOwner,documentId:d?.id,revision:d?.revision,epoch:this.epoch};}
 private owns(c:Owner){const d=this.editor.view.document;return !this.disposed&&c.epoch===this.epoch&&c.session===this.editor.session&&c.identity===c.session.identity()&&c.sessionId===this.editor.sessionId&&c.draftOwner===this.editor.draftOwner&&c.documentId===d?.id&&c.revision===d?.revision;}
 private syncOwner(){if(this.owner&&!this.owns(this.owner))this.releaseDocument();this.owner=this.capture();}
 private fail(error:unknown){this.error=error instanceof Error?error.message:String(error);this.changed();}
 private edit(event:Event,c:Owner,read:()=>string,set:(value:string)=>void,restore?:string){const host=event.currentTarget as HTMLElement&{value:string};this.controls.settled(event,read,value=>{if(!this.owns(c)||this.busy)return;try{set(value);this.prepared=null;this.error='';this.changed();}catch(e){if(restore!==undefined)this.controls.write(host,'value',restore);this.fail(e);}});}
 private action(event:Event,c:Owner,work:(current:()=>boolean)=>Promise<void>|void){this.controls.action(event,()=>{if(!this.owns(c)||this.busy||this.composing||!this.editor.view.ready)return;const token={};this.active=token;this.busy=true;this.error='';this.changed();const current=()=>this.active===token&&this.owns(c);void Promise.resolve().then(()=>{if(current())return work(current);}).catch(e=>{if(current())this.fail(e);}).finally(()=>{if(this.active===token){this.active=null;this.busy=false;this.changed();}});});}
 private selectFile(event:Event,c:Owner,kind:keyof Files){const host=event.currentTarget as HTMLElement&{files:File[]};this.controls.settled(event,()=>host.files,files=>{if(!this.owns(c)||this.busy)return;this.files={...this.files,[kind]:files[0]??null};this.prepared=null;this.error='';if(kind==='weights'&&files[0]&&!this.draft.name)this.draft.name=files[0].name.replace(/\.safetensors$/i,'').slice(0,120);this.changed();});}
 private original(events:DomainEvent[]):Asset{const event=events.find(e=>e.type==='AssetRegistered');if(!event||event.type!=='AssetRegistered')throw Error('Original file registration acknowledgement is unavailable.');return event.payload.asset;}
 private async stage(file:File,purpose:'adapter'|'caption',current:()=>boolean):Promise<Asset|null>{
  if(!current())return null;const staged=await this.editor.upload(file,purpose,purpose==='adapter'?'application/octet-stream':'text/plain',undefined,current);if(!current())return null;
  const events=await this.editor.command({type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256},null);if(!current())return null;return this.original(events);
 }
 private async prepare(current:()=>boolean){
  const files={...this.files},draft={...this.draft};if(!files.weights)throw Error('Choose a local .safetensors weights file.');
  if(!/\.safetensors$/i.test(files.weights.name)||files.weights.size===0)throw Error('Choose a nonempty .safetensors file. The backend checks its actual format.');
  if(!draft.name.trim()||draft.name.length>120||!draft.family.trim()||draft.family.length>120||!draft.format.trim()||draft.format.length>120)throw Error('Enter a name, family and format of at most 120 characters.');
  draft.provenanceText=adapterImportProvenance(files,draft.provenanceText);
  this.message='Hashing and transferring local originals. Structural inspection follows explicit registration.';this.changed();
  const weights=await this.stage(files.weights,'adapter',current);if(!current()||!weights)return;
  const config=files.config?await this.stage(files.config,'caption',current):null;if(!current())return;
  const provenance=files.provenance?await this.stage(files.provenance,'caption',current):null;if(!current())return;
  this.prepared={draft,weights,config,provenance,fileName:files.weights.name};this.message='Original bytes are retained locally. Review their identities, then register this immutable version.';
 }
 private async register(prepared:Prepared,current:()=>boolean){
  if(this.prepared!==prepared||!current())return;
  await this.editor.command({type:'RegisterAdapterVersion',adapterId:prepared.draft.adapterId,previousVersionId:prepared.draft.previousVersionId,weightsAssetId:prepared.weights.id,configAssetId:prepared.config?.id??null,provenanceAssetId:prepared.provenance?.id??null,name:prepared.draft.name,declaredFamily:prepared.draft.family,declaredFormat:prepared.draft.format,provenanceText:prepared.draft.provenanceText},null);
  if(!current())return;this.prepared=null;this.files={weights:null,config:null,provenance:null};this.draft={...this.draft,adapterId:null,previousVersionId:null};await this.list(current);if(current())this.message='Immutable adapter version registered. Inspect its compatibility status before attachment.';
 }
 private filterChanged(key:keyof Filters,value:string){this.filters={...this.filters,[key]:value};this.items=[];this.next=null;this.loaded=false;this.pageCursors=[''];this.pageIndex=0;}
 private async list(current:()=>boolean,direction:'first'|'previous'|'next'='first',focus=false){
  let cursors=direction==='first'?['']:[...this.pageCursors],index=direction==='first'?0:this.pageIndex;
  if(direction==='previous'){if(index===0)return;index--;}
  if(direction==='next'){if(!this.next)return;cursors=[...cursors.slice(0,index+1),this.next];index++;}
  const after=cursors[index]!;
  const query=new URLSearchParams();for(const [key,value] of Object.entries(this.filters))if(value)query.set(key,value);if(after)query.set('after',after);
  const page=await this.editor.json<Page>('/api/v1/adapters'+(query.size?'?'+query:''));if(!current())return;
  if(page.protocolVersion!==1||!Array.isArray(page.items))throw Error('Adapter library metadata is unavailable.');this.items=page.items;this.next=page.nextAfter;this.loaded=true;this.pageCursors=cursors;this.pageIndex=index;
  if(focus){this.changed();await this.host.updateComplete;if(current())this.host.querySelector<HTMLElement>('#adapter-library-results')?.focus();}
 }
 private async saveDependencies(current:()=>boolean){
  const owner=this.editor.draftOwner;if(!owner)throw Error('The current draft owner is unavailable. Reconnect before deletion review.');
  const unsaved=()=>[...owner.drafts.values()].some(d=>d.pending||d.composing||d.savedGeneration!==d.generation);
  await this.editor.flushDrafts();if(!current())return;
  if(unsaved()){await this.editor.flushDrafts();if(!current())return;}
  if(unsaved())throw Error('Save or finish composing the current drafts before reviewing adapter deletion.');
 }
 private async previewDeletion(entry:AdapterLibraryEntry,current:()=>boolean){
  this.deletion=null;await this.saveDependencies(current);if(!current())return;
  const asset=this.original(await this.editor.command({type:'PreviewAdapterDeletion',versionId:entry.versionId},null));if(!current())return;
  const record=asset.adapterDeletion;if(record?.kind!=='preview'||record.versionId!==entry.versionId)throw Error('Adapter deletion preview acknowledgement is unavailable.');
  const plan=await this.editor.json<AdapterDeletionPlan>('/api/v1/adapters/deletion-reviews/'+encodeURIComponent(record.planId));if(!current())return;
  if(plan.kind!=='adapter-deletion-plan-1'||plan.id!==record.planId||plan.versionId!==entry.versionId||plan.token!==record.token)throw Error('Adapter deletion review changed. Prepare a fresh preview.');
  this.deletion=plan;this.message=plan.canDelete?'Review removal of this library version. Original bytes will be retained.':'This library version is still referenced. Resolve the listed dependencies before preparing a fresh deletion review.';
 }
 private async deleteVersion(plan:AdapterDeletionPlan,current:()=>boolean){
  if(this.deletion!==plan||!plan.canDelete||!current())return;
  await this.saveDependencies(current);if(!current()||this.deletion!==plan)return;
  const asset=this.original(await this.editor.command({type:'DeleteAdapterVersion',versionId:plan.versionId,planId:plan.id,token:plan.token},null));if(!current())return;
  const record=asset.adapterDeletion;if(record?.kind!=='deleted'||record.versionId!==plan.versionId||record.planId!==plan.id)throw Error('Adapter deletion acknowledgement is unavailable. Inspect a fresh library page before trying again.');
  this.deletion=null;await this.list(current);if(current())this.message='Library version deleted. Original bytes and retained provenance remain; no disk space was freed.';
 }
 private selectedChange(c:Owner,selected:readonly Adapter[],next:Adapter[]){if(!this.owns(c)||this.selected!==selected||!this.change)return;this.selected=next;this.change(next);this.error='';this.changed();}
 render(selected:readonly Adapter[],change:(next:Adapter[])=>void){
  if(this.disposed)return nothing;
  this.syncOwner();this.selected=selected;this.change=change;const c=this.capture(),prepared=this.prepared,deletion=this.deletion,unavailable=this.busy||!this.editor.view.ready,act=(e:Event,work:(current:()=>boolean)=>Promise<void>|void)=>this.action(e,c,work),field=(e:Event,set:(value:string)=>void,restore?:string)=>{const host=e.currentTarget as HTMLElement&{value:string};this.edit(e,c,()=>host.value,set,restore);};
  const text=(id:string,label:string,value:string,set:(v:string)=>void)=>html`<en-text-field id=${id} label=${label} .value=${value} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,set)}></en-text-field>`;
  const filter=(key:keyof Filters,label:string,values:string[])=>html`<en-select label=${label} .value=${this.filters[key]} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,v=>this.filterChanged(key,v))}><en-select-option value="">All</en-select-option>${values.map(v=>html`<en-select-option value=${v}>${v}</en-select-option>`)}</en-select>`;
  return html`<en-accordion-item id="request-adapters" tabindex="-1" label="Adapter library"><section aria-label="Local adapter library" aria-busy=${String(this.busy)} @compositionstart=${()=>{if(this.owns(c))this.composing=true;}} @compositionend=${()=>{if(this.owns(c))this.composing=false;}}>
   ${!this.editor.view.ready?html`<p>Reconnect to the local editor before importing or changing library entries.</p>`:nothing}
   <p>Import local V4 .safetensors weights and optional config/provenance. Source links are retained as text. Structural validation alone does not establish provider compatibility.</p>
   <en-file-upload label="Adapter weights" accept=".safetensors" .files=${this.fileList('weights')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'weights')}></en-file-upload><en-file-upload label="Optional adapter config" accept=".json,.txt" .files=${this.fileList('config')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'config')}></en-file-upload><en-file-upload label="Optional adapter provenance" accept=".json,.txt" .files=${this.fileList('provenance')} ?disabled=${unavailable} @en-change=${(e:Event)=>this.selectFile(e,c,'provenance')}></en-file-upload>
   ${this.files.weights?html`<p>${this.files.weights.name} · ${this.files.weights.size} bytes · local file</p>`:nothing}
   ${text('adapter-name','Adapter name',this.draft.name,v=>this.draft.name=v)}${text('adapter-family','Declared model family',this.draft.family,v=>this.draft.family=v)}${text('adapter-format','Declared naming format',this.draft.format,v=>this.draft.format=v)}
   <en-textarea label="Import provenance (text only)" .value=${this.draft.provenanceText} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,v=>this.draft.provenanceText=v)}></en-textarea><p>Provenance and the recorded original filenames must fit 4096 characters. The complete retained text appears in registration review.</p>
   ${this.draft.previousVersionId?html`<p>New version of ${this.draft.adapterId}; previous ${this.draft.previousVersionId}. Existing requests keep their exact versions.</p><en-button ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.draft={...this.draft,adapterId:null,previousVersionId:null};this.prepared=null;})}>Import as a separate adapter</en-button>`:nothing}
   <en-button id="prepare-adapter-import" ?disabled=${unavailable||this.composing||!this.files.weights} @click=${(e:Event)=>act(e,current=>this.prepare(current))}>Review local adapter import</en-button>
   ${prepared?html`<en-card aria-label="Adapter registration review"><h3>Register immutable adapter version</h3><p>${prepared.fileName} · ${prepared.weights.blob.byteLength} bytes</p><p>Weights ${prepared.weights.blob.hash}</p><p>Declared family ${prepared.draft.family}; naming format ${prepared.draft.format}. Source: local import.</p><p>${prepared.config?'Config '+prepared.config.blob.hash:'Config not supplied; V4 compatibility not runtime verified'}</p>${prepared.provenance?html`<p>Provenance file ${prepared.provenance.blob.hash}</p>`:nothing}<p>${prepared.draft.provenanceText}</p><p>Registration performs safe structural inspection. Attachment requires a supported V4 compatibility profile. No provider call occurs.</p><en-button id="register-adapter-version" ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.register(prepared,current))}>Register these exact local files</en-button></en-card>`:nothing}
   <h3 id="adapter-library-results" tabindex="-1">Stored versions</h3>${text('adapter-search','Search adapter names',this.filters.search,v=>this.filterChanged('search',v))}
   ${text('adapter-family-filter','Filter by declared family',this.filters.family,v=>this.filterChanged('family',v))}${text('adapter-format-filter','Filter by naming format',this.filters.format,v=>this.filterChanged('format',v))}${filter('origin','Filter by origin',['import','training'])}${filter('status','Filter by validation status',['unverified','structurally-valid','runtime-verified','incompatible'])}
   <en-button id="search-adapter-library" ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.list(current,'first',true))}>Search local library</en-button>
   ${this.loaded?html`<p aria-live="polite" aria-atomic="true">Adapter library page ${this.pageIndex+1} · ${this.items.length} stored versions shown.</p>`:nothing}
   ${this.loaded&&!this.items.length?html`<p>No matching stored adapters. Import a V4 adapter or adjust the filters.</p>`:nothing}
   ${this.items.map(item=>html`<en-card><h4>${item.name}</h4><p>${item.versionId} · version ${item.version} · ${item.declaredFamily} · ${item.declaredFormat}</p><p>${adapterStatus(item)}. ${item.reason}</p><p>${item.weights.byteLength} bytes · ${item.weights.hash}</p><p>${item.config?'Config '+item.config.hash:'Config not supplied; V4 compatibility not runtime verified'}</p><en-button ?disabled=${unavailable||!item.available||!item.locallyEligible||!isSupportedAdapterProfile(item.profileId)||selected.length>=3||selected.some(a=>a.version===item.versionId)} @click=${(e:Event)=>act(e,()=>this.selectedChange(c,selected,attachAdapterVersion(selected,item)))}>Attach exact version ${item.version}</en-button><en-button ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.draft={...this.draft,name:item.name,family:item.declaredFamily,format:item.declaredFormat,adapterId:item.adapterId,previousVersionId:item.versionId};this.files={weights:null,config:null,provenance:null};this.prepared=null;this.message='Choose replacement local files. Registration creates a new version; existing drafts and jobs stay unchanged.';})}>Import a new version</en-button><en-button id=${'preview-adapter-deletion-'+item.versionId} ?disabled=${unavailable} @click=${(e:Event)=>act(e,current=>this.previewDeletion(item,current))}>Review deletion of version ${item.version}</en-button></en-card>`)}
   ${this.loaded?html`<nav aria-label="Adapter library pages"><en-button id="first-adapter-page" ?disabled=${unavailable||this.pageIndex===0} @click=${(e:Event)=>act(e,current=>this.list(current,'first',true))}>First adapter page</en-button><en-button id="previous-adapter-page" ?disabled=${unavailable||this.pageIndex===0} @click=${(e:Event)=>act(e,current=>this.list(current,'previous',true))}>Previous adapter page</en-button><en-button id="next-adapter-page" ?disabled=${unavailable||!this.next} @click=${(e:Event)=>act(e,current=>this.list(current,'next',true))}>Next adapter page</en-button></nav>`:nothing}
   ${deletion?html`<en-card aria-label="Adapter deletion review"><h3>Delete this library version?</h3><p>${deletion.versionId} · version ${deletion.version} · ${deletion.weights.hash}</p><p>${deletion.dependencyCount} retained dependencies. Original bytes remain stored. No disk space will be freed.</p>${deletion.dependencies.map(reason=>html`<p>${reason.kind}: ${reason.id} · ${reason.detail}</p>`)}${deletion.dependenciesTruncated?html`<p>Additional retained dependencies are omitted from this bounded view. Deletion remains blocked.</p>`:nothing}${!deletion.canDelete?html`<p>Deletion is blocked until all retained dependencies are resolved. Removing a current attachment does not remove prior history.</p>`:nothing}<en-button id="confirm-adapter-deletion" ?disabled=${unavailable||!deletion.canDelete} @click=${(e:Event)=>act(e,current=>this.deleteVersion(deletion,current))}>Confirm deletion of this library version</en-button><en-button id="keep-adapter-version" ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>{this.deletion=null;this.message='Library version kept.';})}>Keep library version</en-button></en-card>`:nothing}
   <h3>Ordered request attachments</h3><p>Attach 1–3 distinct versions for an adapter operation. Scale 0 is retained. Provider mixing behavior is unqualified.</p>
   ${selected.map((item,index)=>html`<en-card><p>${index+1}. ${item.version} · ${item.hash}</p><en-number-field label=${'Scale for adapter '+(index+1)} .min=${0} .max=${4} .step=${0.1} .value=${item.scale} ?disabled=${unavailable} @en-change=${(e:Event)=>field(e,value=>this.selectedChange(c,selected,selected.map((a,i)=>i===index?{...a,scale:adapterScale(value)}:{...a})),item.scale)}></en-number-field><en-switch label=${'Acknowledge adapter '+(index+1)+' is not runtime verified'} .checked=${item.runtimeAcknowledged===true} ?disabled=${unavailable} @en-change=${(e:Event)=>{const host=e.currentTarget as HTMLElement&{checked:boolean};this.controls.settled(e,()=>host.checked,value=>{if(!this.owns(c)||this.busy||this.composing)return;this.selectedChange(c,selected,selected.map((a,i)=>i===index?{...a,runtimeAcknowledged:value}:{...a}));});}}></en-switch><en-button ?disabled=${unavailable||index===0} @click=${(e:Event)=>act(e,()=>{const next=selected.map(a=>({...a}));[next[index-1],next[index]]=[next[index]!,next[index-1]!];this.selectedChange(c,selected,next);})}>Move adapter ${index+1} earlier</en-button><en-button ?disabled=${unavailable||index===selected.length-1} @click=${(e:Event)=>act(e,()=>{const next=selected.map(a=>({...a}));[next[index+1],next[index]]=[next[index]!,next[index+1]!];this.selectedChange(c,selected,next);})}>Move adapter ${index+1} later</en-button><en-button ?disabled=${unavailable} @click=${(e:Event)=>act(e,()=>this.selectedChange(c,selected,selected.filter((_,i)=>i!==index).map(a=>({...a}))))}>Remove adapter ${index+1}</en-button></en-card>`)}
   ${this.message?html`<p role="status">${this.message}</p>`:nothing}${this.error?html`<en-alert role="alert">${this.error}</en-alert>`:nothing}
  </section></en-accordion-item>`;
 }
}
