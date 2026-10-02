import {html,nothing,type LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {StagingRecord} from '../protocol/assets.js';
import type {BlobRef} from '../protocol/store.js';
import {STORAGE_CLEAR_SCOPE,validateStorageSummary,validateStorageAssetPage,validateStorageDependencyPage,validateStorageCacheClearResult,type StorageSummary,type StorageAssetPage,type StorageAsset,type StorageCategory,type StorageDependencyPage,type StorageDependency,type StorageCacheClearResult} from '../protocol/storage.js';
import {storageRepairReview,storageRepairRequest,storageRepairResult,type StorageRepairReview,type StorageRepairRequest,type StorageRepairResult} from '../protocol/storage-repair.js';
import {ControlAdapter} from './adapters.js';
import {UIModelOwner} from './model-owner.js';
import type {OwnedModel} from '../observability/model-memory.js';

type Owner={session:EditorClient['session'];identity:string|null;sessionId:string;documentEpoch:number;lifetime:number;generation:number};
type Options={onRestoreCopy?:()=>void|Promise<void>;onImport?:()=>void|Promise<void>};
type ExpectedObject=Extract<StorageDependency,{kind:'object'}>;
type PreparedRepair={review:StorageRepairReview;file:File;stage:StagingRecord;request:StorageRepairRequest};
const sameRef=(a:BlobRef,b:BlobRef)=>a.hash===b.hash&&a.byteLength===b.byteLength&&a.mediaType===b.mediaType;
const sameAsset=(a:StorageAsset,b:StorageAsset)=>a.id===b.id&&a.version===b.version&&sameRef(a.blob,b.blob);
const cancelled=()=>new DOMException('The storage view changed.','AbortError');
const bytes=(value:string)=>BigInt(value).toLocaleString()+' bytes';

/** One page per inventory is retained. Old render values retire after Lit commits,
 * and all reads, uploads and owned response callbacks drain before Close. */
export class StorageLibrary {
 private controls=new ControlAdapter();private models:UIModelOwner;private aborts=new Set<AbortController>();
 private owner:Owner|null=null;private lifetime=0;private generation=0;private disposed=false;private active:object|null=null;private busy=false;
 private summary:StorageSummary|null=null;private assets:StorageAssetPage|null=null;private dependencies:StorageDependencyPage|null=null;
 private review:StorageRepairReview|null=null;private file:File|null=null;private shownFiles:readonly File[]=[];private prepared:PreparedRepair|null=null;private repairResult:StorageRepairResult|null=null;
 private cacheResult:StorageCacheClearResult|null=null;private message='';private error='';private handoff:object|null=null;
 constructor(private host:LitElement,private editor:EditorClient,private options:Options={}){this.models=new UIModelOwner(host,editor,'storage-library-model');}
 get lifecycle(){return this.models.lifecycle;}
 private changed(){this.host.requestUpdate();}
 private capture():Owner{const session=this.editor.session;return {session,identity:session.identity(),sessionId:this.editor.sessionId,documentEpoch:this.editor.documentEpoch,lifetime:this.lifetime,generation:this.generation};}
 private sameWorkspace(c:Owner){return c.session===this.editor.session&&c.identity!==null&&c.identity===c.session.identity()&&c.sessionId===this.editor.sessionId&&c.documentEpoch===this.editor.documentEpoch;}
 private owns(c:Owner){return !this.disposed&&!this.models.releasing&&this.editor.view.ready&&c.lifetime===this.lifetime&&this.sameWorkspace(c);}
 private available(c:Owner){return this.owns(c)&&c.generation===this.generation;}
 private fail(error:unknown){const text=error instanceof Error?error.message:String(error);try{const model=this.models.model(text,65536);this.models.replace('error',model);this.error=text;}catch{this.error='Storage details could not be retained. Refresh to retry.';this.models.clear('error');}this.changed();}
 private clearError(){this.error='';this.models.clear('error');}
 private clearRepair(){this.review=null;this.file=null;this.shownFiles=[];this.prepared=null;this.models.clear('repair');this.models.clear('file');this.models.clear('repair-upload');}
 private clearDependencies(){this.dependencies=null;this.models.clear('dependencies');this.clearRepair();}
 releaseDocument(){
  this.lifetime++;this.controls.invalidate();for(const abort of this.aborts)abort.abort();this.active=null;this.handoff=null;this.owner=null;this.busy=false;
  this.summary=null;this.assets=null;this.dependencies=null;this.review=null;this.file=null;this.shownFiles=[];this.prepared=null;this.repairResult=null;this.cacheResult=null;this.message='';this.error='';this.changed();
  return this.models.release();
 }
 dispose(){this.disposed=true;return this.releaseDocument();}
 async open(){
  if(this.disposed)throw cancelled();if(this.owner&&!this.owns(this.owner)||this.models.releasing)await this.releaseDocument();
  const c=this.capture();if(!this.owns(c))throw cancelled();this.owner=c;
  if(this.busy)return;this.message='Reading local storage inventory…';this.changed();
  await this.run(c,current=>this.refresh(current));
 }
 private async run(c:Owner,work:(current:()=>boolean)=>void|Promise<void>){
  if(!this.owns(c)||this.busy)return;this.owner=c;const token={};this.generation++;this.active=token;this.busy=true;this.clearError();this.changed();
  const current=()=>this.active===token&&this.owns(c);
  try{await this.models.run(async()=>{if(current())await work(current);});}
  catch(error){if(current())this.fail(error);}
  finally{if(this.active===token){this.active=null;this.busy=false;this.changed();}}
 }
 private action(event:Event,c:Owner,work:(current:()=>boolean)=>void|Promise<void>,mutation=false){
  if(!this.available(c)||this.busy||this.handoff||mutation&&this.editor.view.busy)return;
  let unpin:()=>void;try{unpin=this.models.hold();}catch(error){this.fail(error);return;}let settled=false;
  this.controls.action(event,()=>{settled=true;if(!this.available(c)||this.busy||this.handoff||mutation&&this.editor.view.busy){unpin();return;}void this.run(c,current=>work(()=>current()&&(!mutation||!this.editor.view.busy))).finally(unpin);});
  setTimeout(()=>{if(!settled)unpin();},0);
 }
 private async get<T>(path:string,current:()=>boolean,validate:(value:unknown)=>T){
  const model=await this.models.read<unknown>(path,current,65536);try{validate(model.value);return model as OwnedModel<T>;}catch(error){model.release();throw error;}
 }
 private epoch(value:{epoch:string}){if(!this.summary||value.epoch!==this.summary.epoch)throw Error('The storage root changed. Refresh the inventory before continuing.');}
 private async refresh(current:()=>boolean){
  const model=await this.get('/api/v1/storage',current,validateStorageSummary);let installed=false;
  try{if(!current())return;this.models.replace('summary',model);installed=true;this.summary=model.value;this.assets=null;this.models.clear('assets');this.clearDependencies();this.message='Storage inventory refreshed. Choose a category to inspect its assets.';this.changed();}finally{if(!installed)model.release();}
 }
 private async assetPage(category:StorageCategory,cursor:string|null,current:()=>boolean){
  const prior=this.assets,model=await this.get('/api/v1/storage/assets?category='+encodeURIComponent(category)+(cursor?'&cursor='+encodeURIComponent(cursor):''),current,validateStorageAssetPage);let installed=false;
  try{if(!current())return;this.epoch(model.value);if(model.value.category!==category||cursor&&(!prior||prior.category!==category||model.value.highWater!==prior.highWater))throw Error('The asset page changed. Return to the first page or refresh.');
   this.models.replace('assets',model);installed=true;this.assets=model.value;this.clearDependencies();this.message='Asset page loaded.';this.changed();
  }finally{if(!installed)model.release();}
 }
 private async dependencyPage(asset:StorageAsset,cursor:string|null,current:()=>boolean){
  const prior=this.dependencies,model=await this.get('/api/v1/storage/assets/'+encodeURIComponent(asset.id)+'/dependencies'+(cursor?'?cursor='+encodeURIComponent(cursor):''),current,validateStorageDependencyPage);let installed=false;
  try{if(!current())return;this.epoch(model.value);if(!sameAsset(model.value.asset,asset)||cursor&&(!prior||model.value.highWater!==prior.highWater))throw Error('The asset identity or dependency page changed. Refresh its inspection.');
   this.models.replace('dependencies',model);installed=true;this.dependencies=model.value;this.clearRepair();this.message='Dependency page loaded. Listed roots explain retention; they are not deletion approvals.';this.changed();
  }finally{if(!installed)model.release();}
 }
 private async clearCache(current:()=>boolean){
  const abort=new AbortController();this.aborts.add(abort);let result:OwnedModel<unknown>|undefined,installed=false;
  try{result=await this.editor.ownedJSON('/api/v1/storage/preview-cache/clear','storage-cache-clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,scope:STORAGE_CLEAR_SCOPE}),signal:abort.signal},current,65536);
   if(!current())return;const value=validateStorageCacheClearResult(result.value);this.epoch(value);this.models.replace('cache-result',result);installed=true;this.cacheResult=value;
   this.message='Preview-cache operation finished. Refreshing the observed inventory…';this.changed();await this.refresh(current);
  }finally{if(!installed)result?.release();this.aborts.delete(abort);}
 }
 private async prepareRepair(asset:StorageAsset,missing:ExpectedObject,current:()=>boolean){
  if(missing.id!==missing.ref.hash)throw Error('The expected object identity changed. Refresh its dependency inspection.');
  const model=await this.get('/api/v1/storage/assets/'+encodeURIComponent(asset.id)+'/relink/'+missing.ref.hash.slice(7),current,(value)=>{storageRepairReview(value);return value;});let installed=false;
  try{if(!current())return;const review=model.value;if(review.assetId!==asset.id||review.assetVersion!==asset.version||!sameRef(review.ref,missing.ref)||Date.parse(review.expiresAt)<=Date.now())throw Error('The exact-file review changed or expired. Inspect the dependency again.');
   this.clearRepair();this.models.replace('repair',model);installed=true;this.review=review;this.message=review.condition==='available'?'The exact bytes are already available and their hash and length were verified. No repair is needed.':'Choose the exact file. Its length and hash must match before repair is submitted.';this.changed();
  }finally{if(!installed)model.release();}
 }
 private selectFile(event:Event,c:Owner,review:StorageRepairReview){
  const host=event.currentTarget as HTMLElement&{files:readonly File[]},restore=()=>{if(this.owns(c)&&this.review===review&&host.isConnected&&this.host.querySelector('[data-storage-repair-file]')===host)this.controls.write(host,'files',this.shownFiles);};if(!host.isConnected||this.host.querySelector('[data-storage-repair-file]')!==host)return;if(!this.available(c)||this.busy||this.editor.view.busy||this.review!==review){restore();return;}
  let unpin:()=>void;try{unpin=this.models.hold();}catch(error){restore();this.fail(error);return;}
  this.controls.settled(event,()=>host.files,files=>{
   if(!this.available(c)||this.busy||this.editor.view.busy||this.review!==review){restore();return;}
   try{if(files.length>1)throw Error('Choose one exact original file.');const file=files[0]??null;
    const model=this.models.model(file,65536,file?{name:file.name,size:file.size,type:file.type,lastModified:file.lastModified}:null,file?2:1);this.models.replace('file',model);this.prepared=null;this.models.clear('repair-upload');this.generation++;this.file=file;this.shownFiles=file?[file]:[];this.clearError();
    if(file&&String(file.size)!==review.ref.byteLength)this.fail(Error('The selected file has a different length. The existing asset is unchanged. Import it separately as a new asset if intended.'));this.changed();
   }catch(error){restore();this.fail(error);}
  });queueMicrotask(unpin);
 }
 private async relink(review:StorageRepairReview,file:File,current:()=>boolean){
  const exact=()=>current()&&this.review===review&&this.file===file;
  if(!exact())throw cancelled();if(review.condition==='available')throw Error('The reviewed bytes are already available. Refresh the inventory.');
  if(String(file.size)!==review.ref.byteLength)throw Error('The selected file has a different length. The existing asset is unchanged.');
  let prepared=this.prepared;
  if(!prepared){
   if(Date.parse(review.expiresAt)<=Date.now())throw Error('This repair review expired. Inspect the dependency again.');
   const abort=new AbortController();this.aborts.add(abort);let uploaded:Awaited<ReturnType<EditorClient['ownedUpload']>>|undefined,stage:OwnedModel<StagingRecord>|undefined;
   try{this.message='Hashing and transferring the selected exact file…';this.changed();uploaded=await this.editor.ownedUpload(file,review.staging.purpose,review.staging.mediaType,undefined,exact,abort.signal);
    if(!exact())return;const request=uploaded.value;
    if(request.protocolVersion!==1||!/^[-A-Za-z0-9_]{1,128}$/.test(request.stagingId)||request.purpose!==review.staging.purpose||request.mediaType!==review.staging.mediaType||request.sha256!==review.ref.hash||request.expectedBytes!==review.ref.byteLength)throw Error('The selected file has a different hash or length. The existing asset is unchanged. Import it separately as a new asset if intended.');
    stage=await this.models.read<StagingRecord>('/api/v1/assets/staging/'+request.stagingId,exact,65536);if(!exact())return;const value=stage.value;
    if(value.protocolVersion!==1||value.stagingId!==request.stagingId||value.ownerClientId!==this.editor.session.identity()||value.purpose!==request.purpose||value.mediaType!==request.mediaType||value.sha256!==request.sha256||value.expectedBytes!==request.expectedBytes||value.committedOffset!==request.expectedBytes||value.state!=='complete'||typeof value.version!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(value.version))throw Error('The completed staged file changed. No repair was submitted.');
    if(!exact())return;
    const post:StorageRepairRequest={protocolVersion:1,operationId:crypto.randomUUID(),reviewId:review.reviewId,reviewHash:review.reviewHash,stagingId:value.stagingId,expectedStagingVersion:value.version};storageRepairRequest(post);
    prepared={review,file,stage:value,request:post};
    const model=this.models.model(prepared,65536,{review,stage:value,request:post,file:{name:file.name,size:file.size,type:file.type,lastModified:file.lastModified}},2);this.models.replace('repair-upload',model);this.prepared=prepared;
   }finally{stage?.release();uploaded?.release();this.aborts.delete(abort);}
  }
  if(!exact()||prepared.review!==review||prepared.file!==file)return;
  const abort=new AbortController();this.aborts.add(abort);let result:OwnedModel<unknown>|undefined,installed=false;
  try{
   this.message='Restoring the reviewed exact bytes. A failed response can be checked by retrying this same operation.';this.changed();
   result=await this.editor.ownedJSON('/api/v1/storage/assets/'+encodeURIComponent(review.assetId)+'/relink','storage-exact-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(prepared.request),signal:abort.signal},exact,65536);
   if(!exact())return;storageRepairResult(result.value);const value=result.value;
   if(value.operationId!==prepared.request.operationId||value.assetId!==review.assetId||value.assetVersion!==review.assetVersion||!sameRef(value.ref,review.ref)||(value.status==='restored'?value.previousCondition!==review.condition:value.previousCondition!=='available'))throw Error('The physical repair result does not match this exact operation and immutable asset. Refresh before continuing.');
   this.models.replace('repair-result',result);installed=true;this.repairResult=value;this.clearRepair();await this.refresh(current);
   if(current())this.message=value.status==='restored'?'The exact bytes were restored. Asset identity, version and history are unchanged.':'The exact bytes are already available. Asset identity, version and history are unchanged.';
  }finally{if(!installed)result?.release();this.aborts.delete(abort);}
 }
 private handoffAction(event:Event,c:Owner,callback:Options['onImport']){
  if(!callback||!this.available(c)||this.busy||this.editor.view.busy||this.handoff)return;
  // This callback must run outside models.run: the shell also drains this owner.
  this.controls.action(event,()=>{if(!this.available(c)||this.busy||this.editor.view.busy||this.handoff)return;const token={};const release=this.releaseDocument();this.handoff=token;
   void release.then(async()=>{if(this.handoff!==token||this.disposed||!this.sameWorkspace(c)||!this.editor.view.ready||this.editor.view.busy)return;await callback();}).catch(error=>{if(this.handoff===token&&this.sameWorkspace(c))this.fail(error);}).finally(()=>{if(this.handoff===token){this.handoff=null;this.changed();}});
  });
 }
 render(){
  if(this.owner&&!this.owns(this.owner)){void this.releaseDocument().catch(error=>this.editor.fail(error));}
  const c=this.capture(),summary=this.summary,assets=this.assets,dependencies=this.dependencies,review=this.review,file=this.file,unavailable=!this.owns(c)||this.busy||!!this.handoff,mutation=unavailable||this.editor.view.busy;
  return html`<section class="storage-library" aria-labelledby="storage-library-heading" aria-busy=${String(this.busy)}><h2 id="storage-library-heading">Local storage inventory</h2>
   <p>Known logical content lengths are shown below. Categories can overlap; adding them does not give app disk usage. Filesystem free space includes other applications. Physical app disk usage is not measured.</p>
   <en-button ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.refresh(current))}>Refresh storage</en-button>
   ${this.message?html`<p role="status">${this.message}</p>`:nothing}${this.error?html`<en-alert variant="warning"><p role="alert">${this.error}</p></en-alert>`:nothing}
   ${summary?html`<p>Storage epoch ${summary.epoch} · observed sequence ${summary.highWater}. Filesystem available: ${bytes(summary.filesystem.availableBytes)} of ${bytes(summary.filesystem.totalBytes)}.</p>
    <p>Registered objects: ${summary.registeredObjects.count}; ${bytes(summary.registeredObjects.knownBytes)} known${summary.registeredObjects.complete?'':' (incomplete accounting)'}.</p>
    <div class="storage-library-table" tabindex="0" role="region" aria-label="Known content by category"><table><caption>Known content by category</caption><thead><tr><th scope="col">Category</th><th scope="col">Assets</th><th scope="col">Objects</th><th scope="col">Known length</th><th scope="col">Accounting</th><th scope="col">Inspection</th></tr></thead><tbody>${summary.categories.map(row=>html`<tr><th scope="row">${row.label}</th><td>${row.assetCount}</td><td>${row.objectCount}</td><td>${bytes(row.knownBytes)}</td><td>${row.complete?'Complete':'Incomplete'} · ${row.unknownCount===null?'unknown count unavailable':row.unknownCount+' unknown'}</td><td>${row.assetRows?html`<en-button variant="secondary" ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.assetPage(row.id,null,current))}>Inspect ${row.label}</en-button>`:html`<span>No asset rows; category accounting only.</span>`}</td></tr>`)}</tbody></table></div>
    <h3>Recomputable display previews</h3><p>${summary.previewCache.entries} registered entries; ${bytes(summary.previewCache.knownBytes)} known. ${summary.previewCache.pinnedEntries} pinned; ${summary.previewCache.activeBuilds} active builds. Observed clearable: ${summary.previewCache.clearableEntries} entries / ${bytes(summary.previewCache.clearableBytes)}.</p>
    <p>Clearing removes only registered, unpinned server display derivatives after identity checks. Originals, canonical content, masks, history, adapters, staged transfers, browser cache and untracked files are retained.</p>
    <en-button variant="secondary" ?disabled=${mutation||summary.previewCache.clearableEntries===0} @click=${(e:Event)=>this.action(e,c,current=>this.clearCache(current),true)}>Clear unpinned previews</en-button>`:nothing}
   ${this.cacheResult?html`<p role="status">Preview clearing ${this.cacheResult.outcome}: removed ${this.cacheResult.removedEntries} entries, ${bytes(this.cacheResult.freedLogicalBytes)} logical length. Examined ${this.cacheResult.examinedEntries}; unexamined ${this.cacheResult.unexaminedEntries}. Retained ${this.cacheResult.retainedEntries}; pinned ${this.cacheResult.pinnedEntries}; active builds ${this.cacheResult.activeBuilds}. Untracked files were retained and not enumerated.</p>${this.cacheResult.failures.length?html`<ul>${this.cacheResult.failures.map(failure=>html`<li>${failure.key}: ${failure.reason}</li>`)}</ul>`:nothing}`:nothing}
   ${assets?html`<section aria-label="Storage asset page"><h3>${assets.category} assets</h3><p>Observed sequence ${assets.highWater}; ${assets.complete?'no known scan omissions':'incomplete inventory accounting'}.</p>${assets.items.length?html`<ul>${assets.items.map(asset=>html`<li>${asset.id} · version ${asset.version} · ${asset.qualification} · current primary object: ${asset.availability} · recorded metadata: ${asset.recordedAvailability} · ${bytes(asset.knownBytes)}<en-button variant="secondary" ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.dependencyPage(asset,null,current))}>Inspect dependencies for ${asset.id}</en-button></li>`)}</ul>`:html`<p>No assets in this page.</p>`}<en-button variant="secondary" ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.assetPage(assets.category,null,current))}>First asset page</en-button>${assets.nextCursor?html`<en-button ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.assetPage(assets.category,assets.nextCursor,current))}>Next asset page</en-button>`:nothing}</section>`:nothing}
   ${dependencies?html`<section aria-label="Asset dependencies"><h3>Dependencies for ${dependencies.asset.id}, version ${dependencies.asset.version}</h3><p>Observed sequence ${dependencies.highWater}. Presence does not verify a content hash. Shared dependency roots can retain the same bytes without directly referencing this asset.</p><ul>${dependencies.items.map(item=>html`<li>${item.label} · ${item.relation} · ${item.id}${item.kind==='object'?html` · ${item.availability} · ${bytes(item.ref.byteLength)} · ${item.ref.mediaType}${html`<en-button variant="secondary" ?disabled=${mutation} @click=${(e:Event)=>this.action(e,c,current=>this.prepareRepair(dependencies.asset,item,current),true)}>Review exact repair ${item.ref.hash}</en-button>`}`:nothing}</li>`)}</ul><en-button variant="secondary" ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.dependencyPage(dependencies.asset,null,current))}>First dependency page</en-button>${dependencies.nextCursor?html`<en-button ?disabled=${unavailable} @click=${(e:Event)=>this.action(e,c,current=>this.dependencyPage(dependencies.asset,dependencies.nextCursor,current))}>Next dependency page</en-button>`:nothing}</section>`:nothing}
   ${review?html`<section aria-label="Exact file repair"><h3>Exact file repair: ${review.condition}</h3><p>Asset ${review.assetId}, version ${review.assetVersion}; ${review.ref.hash}; ${bytes(review.ref.byteLength)}; ${review.ref.mediaType}. Retained owner: ${review.owner}. Review expires ${review.expiresAt}.</p><p>The selected file must match this exact length and hash. Repair preserves the existing asset identity, version, history and references. A different file must be imported separately.</p>${review.condition==='available'?html`<p>Already available: the exact content hash and length were verified. No repair is needed.</p>`:html`<en-file-upload data-storage-repair-file label="Exact repair file" choose-label="Choose exact file" .files=${this.shownFiles} ?disabled=${mutation} @en-change=${(e:Event)=>this.selectFile(e,c,review)}></en-file-upload><en-button ?disabled=${mutation||!file||String(file.size)!==review.ref.byteLength} @click=${(e:Event)=>{if(file)this.action(e,c,current=>this.relink(review,file,current),true);}}>Relink exact file</en-button>${this.prepared?html`<p>The exact staged file and operation identity are retained for a manual retry. Retry submits the same physical repair request; it does not upload another copy.</p>`:nothing}`}</section>`:nothing}
   ${this.repairResult?html`<p role="status">${this.repairResult.status==='restored'?'Restored':'Already available'}: ${this.repairResult.assetId}, version ${this.repairResult.assetVersion}; ${this.repairResult.ref.hash}. Verified exact bytes; no new asset version or history edit.</p>`:nothing}
   <p class="storage-reload-guidance">The storage inventory refreshes after repair. The current canvas is not reloaded automatically. Close Library, choose Close document, then Open the retained document to reload its projection. Repairing one reference does not verify the other dependencies.</p>
   <h3>Recovery alternatives</h3><p>Restore copy opens a validated portable project as a new local identity. It does not repair missing references in the existing project. Unsafe or unsupported content requires a suitable complete copy. Exact registered font repair restores only the bytes authorized by the server review; it adds no font trust and makes no substitution or text reflow. To choose a different font, use Import as substitution draft in the text editor and preview before Apply. After exact font repair, prepare a fresh native text preview before further layout edits.</p><details><summary>Restore-copy recovery details</summary><p>Restore copy creates a new document identity in this same local root. It cannot replace an existing corrupt object in that root. Use exact repair when the matching original files are available. Otherwise retain the portable archive, start a separate unused private root that you own, then use Open portable project there. This does not repair the previous document.</p><p>In the existing pinned Node/npm launcher environment, replace the placeholder path below with that separate unused private root:</p><code>IDEOGRAM_PROVIDER_MODE=disabled npm start -- --root /absolute/path/to/new-private-root</code><p>This command is guidance only; the editor does not run it. Pair with the new launcher and open the retained portable project there. Keep the original root and archive.</p></details>${this.options.onRestoreCopy?html`<en-button variant="secondary" ?disabled=${mutation} @click=${(e:Event)=>this.handoffAction(e,c,this.options.onRestoreCopy)}>Restore copy as a new project</en-button>`:nothing}${this.options.onImport?html`<en-button variant="secondary" ?disabled=${mutation} @click=${(e:Event)=>this.handoffAction(e,c,this.options.onImport)}>Import as a new asset</en-button>`:nothing}
  </section>`;
 }
}
