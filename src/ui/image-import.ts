import {html,nothing,type LitElement} from 'lit';
import type {EditorClient,RasterImportCancellationOwner} from '../state/editor-client.js';
import type {StagingCreateRequest,StagingRecord} from '../protocol/assets.js';
import type {Command,Document,DomainEvent} from '../protocol/store.js';
import type {CommandResult} from '../protocol/recovery.js';
import type {RasterReview} from '../protocol/raster.js';
import type {RasterImportInspection,RasterImportPlan,RasterImportOperation} from '../protocol/raster-import.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {modelPayloadBytes} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {createDisplayPreviewURL,withDisplaySource,revokeDisplayPreviewURL,validateDisplayImage} from '../observability/display-preview.js';
import {displayImage} from './display-image.js';
import {ControlAdapter} from './adapters.js';

type Target=Pick<Document,'id'|'revision'>;
type State='queued'|'preparing'|'needs-size'|'ready'|'failed'|'uncertain'|'applying'|'applied'|'cancelled';
type Prepared={assetId:string;width:number;height:number;review:RasterReview};
type Pending={id:string;step:string;cancelOwner?:RasterImportCancellationOwner};
type Item={id:string;name:string;file?:File;lease:AllocationLease;state:State;error:string;selected:boolean;loaded:boolean;url:string;stage?:StagingCreateRequest;resume?:StagingRecord;originalId?:string;inspection?:RasterImportInspection;size?:{width:number;height:number;x:number;y:number};plan?:RasterImportPlan;raster?:{id:string;width:number;height:number};prepared?:Prepared;approvedId?:string;created?:Target;importTarget?:Target;accepted?:Target;pending?:Pending;cancelRequested?:boolean;cancelOutcome?:'canceled'|'completed'|'rejected';cancellation?:{id:string;promise:Promise<void>}};
const LIMIT=32,CONTROL_BYTES=131072;
const mediaTypes=new Set(['image/png','image/jpeg','image/webp']);
const asset=(events:readonly DomainEvent[])=>{for(let index=events.length-1;index>=0;index--){const event=events[index]!;if(event.type==='AssetRegistered')return event.payload.asset;}throw Error('The retained image result is unavailable.');};
const failure=(error:unknown)=>(error instanceof Error?error.message:String(error)).slice(0,2048);

/** A serial review queue. Original uploads and conversion are durable before a
 * row becomes selectable; only the explicit selected subset is ever imported. */
export class ImageImportControls {
 private rows:Item[]=[];private retired:Item[]=[];private adapter=new ControlAdapter();private epoch=0;private signal=new AbortController();private task?:Promise<void>;private closing?:Promise<void>;private readTasks=new Set<Promise<unknown>>();
 private owner?:{session:string;client:string|null;documentEpoch:number};private destination:'current'|'new'='new';private target?:Target;private targetLease?:AllocationLease;private destinationChoice?:{value:'current'|'new';owner:NonNullable<ImageImportControls['owner']>};
 private stopped=false;private message='Choose images to prepare their conversion reviews.';private error='';private cleanups=new Set<PromptReaderCleanupError>();
 constructor(private host:LitElement,private editor:EditorClient){}
 inspect(){const retained=[...this.rows,...this.retired];return {files:retained.filter(row=>row.file).length,items:retained.length,previewURLs:retained.filter(row=>row.url).length,pendingOperations:(this.task?1:0)+this.readTasks.size,cleanupFailures:this.cleanups.size+this.retired.length};}
 private changed(){this.host.requestUpdate();}
 private row(id:string){return this.rows.find(row=>row.id===id);}
 private current(epoch=this.epoch){return epoch===this.epoch&&!this.stopped&&!this.signal.signal.aborted&&!!this.owner&&this.editor.view.ready&&this.editor.sessionId===this.owner.session&&this.editor.session.identity()===this.owner.client&&this.editor.documentEpoch===this.owner.documentEpoch;}
 private check(epoch:number){if(!this.current(epoch))throw Error('The import owner changed or this batch was stopped. Retained originals and accepted results remain local.');}
 private ownsRow(row:Item,epoch:number){return this.current(epoch)&&!row.cancelRequested;}
 private checkRow(row:Item,epoch:number){this.check(epoch);if(row.cancelRequested)throw Error('Image preparation was stopped. The retained original and its command outcome remain local.');}
 private targetCurrent(target=this.target){if(!target||this.editor.view.document?.id!==target.id||this.editor.view.document.revision!==target.revision)throw Error('The destination changed. Choose the current document again and review before importing.');}
 private remember(error:unknown){if(error instanceof PromptReaderCleanupError)this.cleanups.add(error);}
 private captureOwner(){return {session:this.editor.sessionId,client:this.editor.session.identity(),documentEpoch:this.editor.documentEpoch};}
 private sameOwner(owner:NonNullable<ImageImportControls['owner']>){return this.editor.view.ready&&owner.session===this.editor.sessionId&&owner.client===this.editor.session.identity()&&owner.documentEpoch===this.editor.documentEpoch;}
 begin(){if(this.rows.length){if(!this.owner||!this.sameOwner(this.owner))throw Error('The prior import belongs to another document owner. Close Import to release it before starting again.');return;}const destination=this.editor.view.document?'current':'new';this.captureTarget(destination);this.destination=destination;this.changed();}
 private captureTarget(destination=this.destination){const d=this.editor.view.document;let lease:AllocationLease|undefined,target:Target|undefined;
  if(destination==='current'){if(!d)throw Error('Open a document or choose a new document for each image.');lease=allocationLedger.reserve({owner:'image-import-target',kind:'control',cpuBytes:1024,handles:1});target={id:d.id,revision:d.revision};}
  this.targetLease?.release();this.targetLease=lease;this.target=target;
 }
 chooseDestination(value:string){if(this.task||this.closing||this.editor.view.busy||this.rows.some(row=>row.pending||row.created&&!row.accepted)||!['current','new'].includes(value))return;const destination=value as 'current'|'new';this.captureTarget(destination);this.destination=destination;this.destinationChoice={value:destination,owner:this.captureOwner()};this.error='';this.changed();}
 private available(){if(this.task||this.closing||this.editor.view.busy||!this.editor.view.ready)throw Error('Wait for the current image operation to settle and connect locally.');if(this.rows.some(row=>row.pending))throw Error('Resolve the original pending deliveries before replacing this batch.');}
 private createRows(files:readonly File[],existing?:StagingRecord){
  if(existing&&(files.length!==1||existing.purpose!=='image'||existing.ownerClientId!==this.editor.session.identity()||modelPayloadBytes(existing)>16384))throw Error('The original image transfer belongs to another owner or exceeds its local allowance.');
  if(files.length>LIMIT)throw Error('Choose up to '+LIMIT+' images in one batch.');const incoming:Item[]=[];
  try{for(const file of files){if(file.name.length>4096)throw Error('An image filename exceeds the local import allowance.');const lease=allocationLedger.reserve({owner:'image-import-item',kind:'control',cpuBytes:CONTROL_BYTES,handles:2});try{incoming.push({id:crypto.randomUUID(),name:file.name,file,lease,state:'queued',error:'',selected:false,loaded:false,url:'',...(existing?{resume:structuredClone(existing)}:{})});}catch(error){lease.release();throw error;}}return incoming;}
  catch(error){for(const row of incoming)row.lease.release();throw error;}
 }
 private activate(owner:NonNullable<ImageImportControls['owner']>,choice?:'current'|'new'){if(!this.sameOwner(owner))throw Error('The image import owner changed. Choose the images again in the current document.');this.stopped=false;this.signal=new AbortController();this.owner=owner;const destination=choice??(this.editor.view.document?'current':'new');this.captureTarget(destination);this.destination=destination;this.destinationChoice=choice?{value:choice,owner}:undefined;}
 private prepareRows(epoch:number){return (async()=>{for(const row of this.rows){if(!this.current(epoch)){if(row.state==='queued'){row.state='cancelled';row.error='Not prepared because the batch owner changed or the batch was stopped.';}continue;}if(row.state==='queued')await this.prepare(row,epoch);}})();}
 async select(files:readonly File[],existing?:StagingRecord){
  this.available();if(!files.length)return;const requested=this.captureOwner(),choice=this.destinationChoice&&this.sameOwner(this.destinationChoice.owner)?this.destinationChoice.value:undefined,incoming=this.createRows(files,existing);
  try{await this.releaseDocument();this.activate(requested,choice);}catch(error){for(const row of incoming)row.lease.release();throw error;}
  this.rows=incoming;this.message='Preparing '+this.rows.length+' image'+(this.rows.length===1?'':'s')+'. Originals are retained before conversion.';this.changed();
  await this.run('Prepare images',epoch=>this.prepareRows(epoch));
 }
 // Remove is a distinct public FileUpload transaction. Empty chooser selections
 // remain no-ops; removing a row must not reprepare or deselect its neighbours.
 private async removeFiles(files:readonly File[],previous:readonly File[]|undefined,proposed:readonly File[]|undefined){
  this.available();if(!Array.isArray(previous)||!Array.isArray(proposed))throw Error('The image removal proposal is unavailable.');const owner=this.owner,epoch=this.epoch,current=this.rows.flatMap(row=>row.file?[row.file]:[]);
  if(!owner||!this.sameOwner(owner))throw Error('The image import owner changed. Reopen Import before removing an image.');
  if(previous.length!==current.length||previous.some((file,index)=>file!==current[index])||files.length!==current.length-1||proposed.length!==files.length||proposed.some((file,index)=>file!==files[index]))throw Error('The image selection changed. Review the current files before removing an image.');
  const removed=this.rows.filter(row=>row.file&&!files.includes(row.file)),kept=current.filter(file=>files.includes(file));
  if(removed.length!==1||kept.length!==files.length||kept.some((file,index)=>file!==files[index]))throw Error('The image selection changed. Review the current files before removing an image.');
  const row=removed[0]!;
  if(row.cancellation||row.approvedId||row.created||row.accepted)throw Error('Resolve the original confirmed image import before removing this image.');
  return this.run('Remove image',async()=>{
   if(this.closing||epoch!==this.epoch||owner!==this.owner||!this.sameOwner(owner))throw Error('The image import owner changed before removal.');
   if(row.url)revokeDisplayPreviewURL(row.url);row.url='';
   this.rows=this.rows.filter(item=>item!==row);this.retired.push(row);
   this.message=this.rows.length?'Image removed. Other image reviews and selections are unchanged.':'Choose images to prepare their conversion reviews.';
   // The uploader and prior Lit render may still hold this exact File. Keep its
   // lease through commit; a failed commit remains tracked for Close to retry.
   this.changed();await this.host.updateComplete;
   row.file=undefined;row.prepared=undefined;row.resume=undefined;row.inspection=undefined;row.lease.release();this.retired=this.retired.filter(item=>item!==row);
  });
 }
 private fileChange(event:Event,epoch:number){
  const control=event.currentTarget as EventTarget&{files:File[]},detail=(event as CustomEvent<{reason?:string;previous?:readonly File[];proposed?:readonly File[]}>).detail;
  const removal=detail?.reason==='remove',previous=detail?.previous,proposed=detail?.proposed;
  this.adapter.settled(event,()=>control.files,files=>{
   if(epoch!==this.epoch)return;
   const work=removal?this.removeFiles(files,previous,proposed):this.select(files);
   void work.catch(error=>{if(removal){if(epoch!==this.epoch)return;this.adapter.write(control,'files',this.rows.flatMap(row=>row.file?[row.file]:[]));}this.error=failure(error);this.changed();});
  });
 }
 async resumeTransfer(file:File,id:string){
  this.available();const requested=this.captureOwner();
  // The selected File has its own admitted row before any async hand-off. The
  // complete resume read stays in the tracked task until its model is released.
  const incoming=this.createRows([file]);
  try{await this.releaseDocument();this.activate(requested);}catch(error){incoming[0]!.lease.release();throw error;}
  this.rows=incoming;this.message='Reading the original image transfer.';this.changed();
  await this.run('Resume image transfer',async epoch=>{
   try{const record=await this.editor.ownedJSON<StagingRecord>('/api/v1/assets/staging/'+encodeURIComponent(id),'image-import-resume',{signal:this.signal.signal},()=>this.current(epoch),CONTROL_BYTES);
   try{this.check(epoch);if(record.value.stagingId!==id||record.value.purpose!=='image'||record.value.ownerClientId!==this.editor.session.identity()||modelPayloadBytes(record.value)>16384)throw Error('The original image transfer belongs to another owner or exceeds its local allowance.');incoming[0]!.resume=structuredClone(record.value);}finally{record.release();}
   await this.prepareRows(epoch);
   }catch(error){incoming[0]!.state=this.current(epoch)?'failed':'cancelled';incoming[0]!.error=failure(error);throw error;}
  });
 }
 private run(label:string,work:(epoch:number)=>Promise<void>){
  if(this.task)return this.task;const epoch=this.epoch;this.error='';
  const task=Promise.resolve().then(()=>this.editor.run(label,async()=>{try{await work(epoch);}catch(error){this.remember(error);this.error=failure(error);}finally{this.changed();}})).finally(()=>{if(this.task===task)this.task=undefined;this.changed();});this.task=task;this.changed();return task;
 }
 // Consumers finish every use or copy into the preadmitted row before release.
 // In particular, receipt proofs remain live through their asynchronous reads.
 private async command(row:Item,step:string,body:Command['body'],consume:(events:readonly DomainEvent[])=>void|Promise<void>,target:Target|null=null,newId?:string){
  if(row.pending&&row.pending.step!==step)throw Error('Resolve the original '+row.pending.step+' delivery before continuing this image.');
  const cancelOwner=body.type==='InspectRasterOriginal'||body.type==='PrepareRaster'?{session:this.editor.session,identity:this.editor.session.identity()}:undefined;
  try{const response=row.pending?await this.editor.ownedRetry(row.pending.id):await this.editor.ownedCommand(body,target,newId,id=>{row.pending={id,step,...(cancelOwner?{cancelOwner}:{})};if(cancelOwner&&(this.stopped||row.cancelRequested)){row.cancelRequested=true;void this.cancelPending(row);}this.changed();});
   try{const events=response.value;
    const expected=step==='inspect original'?'RasterImportInspectionPrepared':step==='review conversion'?'RasterReviewPrepared':step==='create document'?'DocumentCreated':step==='import layer'?'ImageEdited':'AssetRegistered';
    if(!events.some(event=>event.type===expected&&(expected!=='ImageEdited'||event.documentId===target?.id&&!!event.resultingDocumentRevision)))throw Error('The original command outcome needs reconciliation before continuing.');
    row.pending=undefined;await consume(events);
   }finally{response.release();}}
  catch(error){
   // A transport error is not evidence that an admitted command was rejected.
   // Only its original durable rejected receipt permits a new preparation.
   if(row.pending)try{const result=await this.editor.ownedJSON<CommandResult>('/api/v1/commands/'+row.pending.id,'image-import-receipt',{signal:this.signal.signal},undefined,CONTROL_BYTES);try{if(result.value.kind==='receipt'&&result.value.receipt.status==='rejected'){row.pending=undefined;if(step==='import layer')row.importTarget=undefined;if(step==='approve conversion'){row.prepared=undefined;row.loaded=false;}if(step==='prepare conversion')this.invalidateConversion(row,true);}}finally{result.release();}}catch(readError){this.remember(readError);}
   throw error;
  }
 }
 private cancelPending(row:Item):Promise<void>{
  const pending=row.pending;if(!pending?.cancelOwner)return Promise.resolve();
  if(row.cancellation?.id===pending.id)return row.cancellation.promise;
  const task=Promise.resolve().then(async()=>{
   try{
    const response=await this.editor.ownedCancelRasterImport(pending.id,pending.cancelOwner);try{const result=response.value;
    row.cancelOutcome=result.status==='canceled'?'canceled':result.receipt.status==='rejected'?'rejected':'completed';
    // The original delivery may have settled while cancellation was in flight.
    // Never overwrite a later step or an accepted import with its old response.
    if(row.pending?.id!==pending.id){if(row.cancelOutcome==='completed'&&row.cancelRequested)row.error='Preparation completed before cancellation. Its retained result was not imported.';return;}
    if(result.status==='canceled'||result.receipt.status==='rejected'){
     row.pending=undefined;this.invalidateConversion(row,true);row.state='cancelled';
     row.error=result.status==='canceled'?'Image preparation canceled. The original remains retained. Retry to prepare a fresh review.':'The original preparation was rejected before cancellation. Retry to prepare a fresh review.';
    }else{row.state='uncertain';row.error='Preparation completed before cancellation. Resolve its original delivery before continuing.';}
    }finally{response.release();}
   }catch(error){this.remember(error);if(row.pending?.id===pending.id){row.state='uncertain';row.error='Cancellation is unconfirmed. Resolve the original delivery before continuing. '+failure(error);}}
   finally{if(row.cancellation?.promise===task)row.cancellation=undefined;this.readTasks.delete(task);try{this.changed();}catch(error){this.remember(error);this.error=failure(error);}}
  });
  row.cancellation={id:pending.id,promise:task};this.readTasks.add(task);return task;
 }
 private async prepare(row:Item,epoch:number){
  row.state='preparing';row.error='';row.selected=false;row.loaded=false;this.changed();
  try{
   this.checkRow(row,epoch);if(!row.originalId){if(!row.file)throw Error('Reselect the original file to prepare this image.');if(!mediaTypes.has(row.file.type))throw Error('Choose a static PNG, JPEG or WebP image.');
    if(!row.stage){const response=await this.editor.ownedUpload(row.file,'image',row.file.type,row.resume,()=>this.ownsRow(row,epoch),this.signal.signal);try{if(modelPayloadBytes(response.value)>16384)throw Error('The original image transfer exceeds its local allowance.');row.stage=structuredClone(response.value);}finally{response.release();}}this.checkRow(row,epoch);
    await this.command(row,'retain original',{type:'FinalizeStaging',stagingId:row.stage.stagingId,expectedSha256:row.stage.sha256},events=>{row.originalId=asset(events).id;});
   }
   this.checkRow(row,epoch);const originalId=row.originalId;if(!originalId)throw Error('The retained image result is unavailable.');
   if(!row.inspection){await this.command(row,'inspect original',{type:'InspectRasterOriginal',assetId:originalId},async events=>{const event=events.find(event=>event.type==='RasterImportInspectionPrepared');if(!event||event.type!=='RasterImportInspectionPrepared')throw Error('Original image inspection is unavailable.');
    this.checkRow(row,epoch);const model=await this.editor.ownedJSON<RasterImportInspection>('/api/v1/assets/raster-import-inspections/'+event.payload.inspectionId,'image-import-inspection',{signal:this.signal.signal},()=>this.ownsRow(row,epoch),CONTROL_BYTES);
    try{this.checkRow(row,epoch);const value=model.value;if(value.inspectionId!==event.payload.inspectionId||value.inspectionHash!==event.payload.inspectionHash||value.assetId!==originalId||value.samplesValidated!==false||modelPayloadBytes(value)>16384)throw Error('The retained original inspection changed.');row.inspection=structuredClone(value);}finally{model.release();}
   });}
   const inspection=row.inspection;if(!inspection)throw Error('Original image inspection is unavailable.');const [width,height]=this.oriented(inspection),oversized=width>8192||height>8192||width*height>25000000;
   if(oversized&&!row.plan){const scale=Math.min(1,4096/width,4096/height);row.size??={width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale)),x:0,y:0};row.state='needs-size';row.error='The original exceeds the working image envelope. Choose an available resize or crop and review its actual pixels.';this.changed();return;}
   if(!row.raster){await this.command(row,'prepare conversion',{type:'PrepareRaster',assetId:originalId,...row.plan?{importPlan:row.plan}:{}},events=>{const value=asset(events);if(!value.raster)throw Error('The converted image has no retained pixels.');if(row.plan&&(value.raster.width!==row.plan.operation.width||value.raster.height!==row.plan.operation.height))throw Error('The derived image dimensions differ from the reviewed operation.');row.raster={id:value.id,width:value.raster.width,height:value.raster.height};});}
   this.checkRow(row,epoch);const raster=row.raster;if(!raster)throw Error('The converted image has no retained pixels.');
   if(!row.prepared){await this.command(row,'review conversion',{type:'ReviewRaster',assetId:raster.id},async events=>{const event=events.find(event=>event.type==='RasterReviewPrepared');if(!event||event.type!=='RasterReviewPrepared')throw Error('The conversion review is unavailable.');
    this.checkRow(row,epoch);const model=await this.editor.ownedJSON<RasterReview>('/api/v1/assets/raster-reviews/'+event.payload.reviewId,'image-import-review',{signal:this.signal.signal},()=>this.ownsRow(row,epoch),CONTROL_BYTES);
    try{this.checkRow(row,epoch);const review=model.value;if(review.reviewId!==event.payload.reviewId||review.reviewHash!==event.payload.reviewHash||review.assetId!==raster.id)throw Error('The retained conversion review changed.');if(modelPayloadBytes(review)>32768)throw Error('The conversion review exceeds its local allowance.');row.prepared={assetId:raster.id,width:raster.width,height:raster.height,review:structuredClone(review)};}finally{model.release();}
   });}
   const prepared=row.prepared;if(!prepared)throw Error('The conversion review is unavailable.');if(row.url){revokeDisplayPreviewURL(row.url);row.url='';}
   const transport=this.editor.session.transport.bind(this.editor.session),url=await withDisplaySource(transport,prepared.review.previewAssetId,{owner:'image-import-preview-descriptor',signal:this.signal.signal,owns:()=>this.ownsRow(row,epoch)},source=>createDisplayPreviewURL(transport,source,{owner:'image-import-preview',edge:256,signal:this.signal.signal,owns:()=>this.ownsRow(row,epoch)}));
   if(!this.ownsRow(row,epoch)){revokeDisplayPreviewURL(url);this.checkRow(row,epoch);}row.url=url;row.state='ready';row.error='';
  }catch(error){this.remember(error);row.state=row.pending?'uncertain':this.ownsRow(row,epoch)?'failed':'cancelled';row.error=row.cancelOutcome==='completed'?'Preparation completed before cancellation. Its retained result was not imported.':failure(error);}
  if(row.cancelRequested&&row.cancellation)await row.cancellation.promise;
  if(!this.stopped)this.message='Select the images whose previews you want to import. Failed items can be retried individually.';this.changed();
 }
 private oriented(inspection:RasterImportInspection):[number,number]{return inspection.orientation>=5?[inspection.encoded.height,inspection.encoded.width]:[inspection.encoded.width,inspection.encoded.height];}
 private invalidateConversion(row:Item,inspection=false){row.loaded=false;row.selected=false;row.prepared=undefined;row.raster=undefined;row.plan=undefined;if(inspection)row.inspection=undefined;if(row.url)revokeDisplayPreviewURL(row.url);row.url='';}
 refreshInspection(id:string){const row=this.row(id);if(!row||this.task||this.editor.view.busy||row.pending||row.approvedId||row.accepted)return Promise.resolve();this.check(this.epoch);this.invalidateConversion(row,true);return this.run('Refresh original inspection',epoch=>this.prepare(row,epoch));}
 private changeSize(id:string,field:'width'|'height'|'x'|'y',value:number){const row=this.row(id);if(!row?.size||this.task||this.editor.view.busy||row.pending||row.approvedId||row.accepted)return;if(row.url)revokeDisplayPreviewURL(row.url);row.url='';row.loaded=false;row.selected=false;row.prepared=undefined;row.raster=undefined;row.plan=undefined;row.size={...row.size,[field]:value};row.state='needs-size';row.error='Prepare and review the changed dimensions before importing.';this.changed();}
 prepareSize(id:string,kind:RasterImportOperation['kind']){const row=this.row(id);if(!row?.inspection||!row.size||this.task||this.editor.view.busy||row.pending||row.approvedId||row.accepted)return Promise.resolve();if(Date.now()>=Date.parse(row.inspection.expiresAt))return this.refreshInspection(id);if(!row.inspection.capabilities[kind])throw Error(row.inspection.capabilities.unavailableReason??'This original cannot be safely prepared with the selected operation.');
  const size=row.size,[width,height]=this.oriented(row.inspection);if(![size.width,size.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=8192)||size.width*size.height>25000000)throw Error('Choose working dimensions up to 8192 pixels per side and 25 million pixels.');
  if(kind==='crop'&&(![size.x,size.y].every(value=>Number.isSafeInteger(value)&&value>=0)||size.x+size.width>width||size.y+size.height>height))throw Error('Keep the crop inside the oriented original image.');
  const operation:RasterImportOperation=kind==='resize'?{kind,width:size.width,height:size.height}:{kind,x:size.x,y:size.y,width:size.width,height:size.height};row.plan={inspectionId:row.inspection.inspectionId,inspectionHash:row.inspection.inspectionHash,operation};row.raster=undefined;row.prepared=undefined;row.loaded=false;row.selected=false;return this.run('Prepare resized or cropped image',epoch=>this.prepare(row,epoch));
 }
 private sizeField(id:string,label:string,field:'width'|'height'|'x'|'y',value:number){return html`<en-number-field label=${label} .value=${String(value)} ?disabled=${!!this.task} @en-change=${(event:Event)=>{const input=event.currentTarget as unknown as {value:string};this.adapter.settled(event,()=>input.value,value=>{try{this.changeSize(id,field,Number(value));}catch(error){this.error=failure(error);this.changed();}});}}></en-number-field>`;}
 retry(id:string){const row=this.row(id);if(!row||this.task||row.cancellation||this.editor.view.busy||!['failed','uncertain','cancelled'].includes(row.state))return Promise.resolve();
  if(!this.owner||this.editor.sessionId!==this.owner.session||this.editor.session.identity()!==this.owner.client||this.editor.documentEpoch!==this.owner.documentEpoch)throw Error('Reopen Import in the original local session before retrying.');
  this.stopped=false;row.cancelRequested=false;row.cancelOutcome=undefined;this.signal=new AbortController();return this.run('Retry image',epoch=>row.approvedId||row.created||row.pending&&['approve conversion','create document','import layer'].includes(row.pending.step)?this.applyOne(row,epoch):this.prepare(row,epoch));
 }
 private loaded(id:string,event:Event){const row=this.row(id);if(!row?.url||row.state!=='ready')return;try{validateDisplayImage(event.currentTarget as HTMLImageElement,row.url);row.loaded=true;row.error='';}catch(error){row.loaded=false;row.error=failure(error);}this.changed();}
 selectItem(id:string,selected:boolean){const row=this.row(id);if(!row||this.task||row.state!=='ready'||!row.loaded)return;row.selected=selected;this.changed();}
 async apply(){
  if(this.task||this.editor.view.busy)return;const chosen=this.rows.filter(row=>row.selected&&row.state==='ready'&&row.loaded);if(!chosen.length)throw Error('Select at least one reviewed image.');
  if(this.destination==='current')this.targetCurrent();this.check(this.epoch);
  return this.run('Import selected images',async epoch=>{for(const row of chosen){if(!this.current(epoch))break;await this.applyOne(row,epoch);if(row.state!=='applied')break;}const applied=this.rows.filter(row=>row.state==='applied').length;this.message=applied+' of '+this.rows.length+' images imported. Other images remain unaccepted.';});
 }
 private async applyOne(row:Item,epoch:number){
  if(!row.prepared)return;row.state='applying';row.error='';this.changed();
  try{
   this.check(epoch);if(this.destination==='current'&&row.pending?.step!=='import layer')this.targetCurrent();
   if(!row.approvedId){await this.command(row,'approve conversion',{type:'ApproveRaster',assetId:row.prepared.assetId,reviewId:row.prepared.review.reviewId,reviewHash:row.prepared.review.reviewHash},events=>{row.approvedId=asset(events).id;});}
   this.check(epoch);let target:Target;
   if(row.pending?.step==='import layer'&&row.importTarget)target={...row.importTarget};
   else if(this.destination==='current'){this.targetCurrent();target={...this.target!};}
   else{if(!row.created){const id=crypto.randomUUID();await this.command(row,'create document',{type:'NewDocument',width:row.prepared.width,height:row.prepared.height,color:'sRGB',depth:8},events=>{const event=events.find(event=>event.type==='DocumentCreated');if(!event||event.type!=='DocumentCreated')throw Error('The new document receipt is unavailable.');row.created={id:event.payload.document.id,revision:event.payload.document.revision};},null,id);}if(!row.created)throw Error('The new document receipt is unavailable.');target={...row.created};}
   this.check(epoch);row.importTarget={...target};
   const approvedId=row.approvedId;if(!approvedId)throw Error('The retained image result is unavailable.');await this.command(row,'import layer',{type:'ImportAsset',assetId:approvedId,layerId:crypto.randomUUID(),name:row.name,draft:null},events=>{const accepted=events.find(event=>event.type==='ImageEdited'&&event.documentId===target.id);
   if(!accepted?.resultingDocumentRevision)throw Error('The imported layer receipt is unavailable.');
   // This receipt remains true even if Stop was pressed while the admitted
   // command completed. It must never be relabelled as a cancelled edit.
   row.accepted={id:target.id,revision:accepted.resultingDocumentRevision};row.state='applied';row.selected=false;row.file=undefined;
   if(this.destination==='current'&&this.target?.id===target.id)this.target={...row.accepted};},target);
  }catch(error){this.remember(error);row.state=row.pending?'uncertain':this.current(epoch)?'failed':'cancelled';row.error=failure(error);}
  this.changed();
 }
 cancelItem(id:string){const row=this.row(id);if(!row||row.approvedId||row.created||row.accepted)return;if(row.pending?.cancelOwner){row.cancelRequested=true;row.selected=false;this.changed();return this.cancelPending(row);}if(this.task||row.pending)return;if(row.url)revokeDisplayPreviewURL(row.url);row.url='';row.loaded=false;row.selected=false;row.cancelRequested=true;row.state='cancelled';row.error=row.originalId?'Not imported. The original remains retained. Retry this image to prepare a fresh review.':'Not imported. Retry this image to resume.';row.prepared=undefined;this.changed();}
 resume(){if(this.task)return;const owner=this.owner;if(!owner||owner.session!==this.editor.sessionId||owner.client!==this.editor.session.identity()||owner.documentEpoch!==this.editor.documentEpoch)throw Error('The original import owner is unavailable.');this.stopped=false;this.signal=new AbortController();this.message='Continue reviewing ready images or retry unfinished items.';this.changed();}
 stop(){this.stopped=true;this.signal.abort();for(const row of this.rows){if(row.state==='queued'){row.state='cancelled';row.error='Not prepared. Retry this image to continue.';}if(row.pending?.cancelOwner){row.cancelRequested=true;void this.cancelPending(row);}}this.message='Stopping the batch and requesting cancellation of any active image preparation. Accepted images and uncertain original deliveries remain local.';this.changed();}
 releaseDocument(){if(this.closing)return this.closing;this.stop();this.adapter.invalidate();this.epoch++;
  this.closing=Promise.resolve().then(async()=>{await this.task;await Promise.allSettled([...this.readTasks]);const failures:unknown[]=[],retained:Item[]=[];
   for(const row of this.rows){try{if(row.url)revokeDisplayPreviewURL(row.url);row.url='';this.retired.push(row);}catch(error){retained.push(row);failures.push(error);}}
   this.rows=retained;this.target=undefined;this.targetLease?.release();this.targetLease=undefined;this.owner=undefined;this.destinationChoice=undefined;
   for(const error of this.cleanups)try{await error.retry();this.cleanups.delete(error);}catch(failure){failures.push(failure);}
   // FileUpload.files and previous render values may retain rows through the
   // replacement commit. Keep both actual values and their leases until it ends.
   this.changed();await this.host.updateComplete;
   for(const row of this.retired){row.file=undefined;row.prepared=undefined;row.resume=undefined;row.inspection=undefined;row.lease.release();}this.retired=[];
   if(failures.length)throw new AggregateError(failures,'IMAGE_IMPORT_RELEASE_FAILED');
  }).finally(()=>{this.closing=undefined;});return this.closing;
 }
 private action(event:Event,work:()=>void|Promise<void>){this.adapter.action(event,()=>{try{void Promise.resolve(work()).catch(error=>{this.error=failure(error);this.changed();});}catch(error){this.error=failure(error);this.changed();}});}
 private renderRow(row:Item){const id=row.id;
  return html`<li><h3>${row.name}</h3><p>${row.state==='ready'?'Ready to review':row.state}${row.originalId?' · original retained':''}</p>
   ${row.url?html`<img class="review-image" src=${displayImage(row.url)} alt=${'Conversion preview: '+row.name} @load=${(event:Event)=>this.loaded(id,event)}>`:nothing}
   ${row.inspection?html`<p>Original ${row.inspection.encoded.width} × ${row.inspection.encoded.height} encoded pixels · orientation ${row.inspection.orientation} · ${row.inspection.profile}. Header inspection does not validate image samples.</p>`:nothing}
   ${row.inspection&&!row.approvedId&&!row.accepted?html`<en-button variant="secondary" ?disabled=${!!this.task||!!row.pending} @click=${(event:Event)=>this.action(event,()=>this.refreshInspection(id))}>Refresh original inspection</en-button>`:nothing}
   ${row.size&&!row.approvedId&&!row.accepted?html`<p>Resize or crop a derived image; the original bytes remain retained.</p>${this.sizeField(id,'Import width (px)','width',row.size.width)}${this.sizeField(id,'Import height (px)','height',row.size.height)}${this.sizeField(id,'Crop X (px)','x',row.size.x)}${this.sizeField(id,'Crop Y (px)','y',row.size.y)}<en-button ?disabled=${!!this.task||!row.inspection?.capabilities.resize} @click=${(event:Event)=>this.action(event,()=>this.prepareSize(id,'resize'))}>Preview resized image</en-button><en-button ?disabled=${!!this.task||!row.inspection?.capabilities.crop} @click=${(event:Event)=>this.action(event,()=>this.prepareSize(id,'crop'))}>Preview cropped image</en-button>${row.inspection?.capabilities.unavailableReason?html`<en-alert>${row.inspection.capabilities.unavailableReason}</en-alert>`:nothing}`:nothing}
   ${row.prepared?html`<p>${row.prepared.width} × ${row.prepared.height} pixels · ${row.plan?row.inspection?.profile:row.prepared.review.conversion?.profile??'sRGB'} → sRGB · ${(row.plan?row.inspection?.orientation!==1:row.prepared.review.conversion?.orientationChanged)?'orientation normalized':'orientation unchanged'} · ${(row.plan?row.inspection?.profile==='p3':row.prepared.review.conversion?.colorChanged)?'color converted':'color unchanged'} · ${row.plan?row.plan.operation.kind==='resize'?'explicit resize':'explicit crop':'no resize'} · alpha retained</p>`:nothing}
   ${row.state==='ready'?html`<en-switch label=${'Import '+row.name} .checked=${row.selected} ?disabled=${!!this.task||!row.loaded} @en-change=${(event:Event)=>{const control=event.currentTarget as unknown as {checked:boolean};this.adapter.settled(event,()=>control.checked,value=>this.selectItem(id,value));}}></en-switch>`:nothing}
   ${row.error?html`<en-alert variant="warning">${row.error}</en-alert>`:nothing}
   ${['failed','uncertain','cancelled'].includes(row.state)?html`<en-button variant="secondary" ?disabled=${!!this.task} @click=${(event:Event)=>this.action(event,()=>this.retry(id))}>${row.pending?'Resolve original delivery':row.approvedId||row.created?'Continue confirmed import':'Retry image'}</en-button>`:nothing}
   ${!row.accepted&&!row.approvedId&&!row.created&&(!row.pending||row.pending.cancelOwner)?html`<en-button variant="secondary" ?disabled=${!!row.cancellation||!!this.task&&!row.pending?.cancelOwner} @click=${(event:Event)=>this.action(event,()=>this.cancelItem(id))}>${row.pending?'Cancel preparation':'Cancel this image'}</en-button>`:nothing}
   ${row.created&&!row.accepted?html`<p>A new empty document was saved as ${row.created.id}. Continue the original import to add its image.</p>`:nothing}
   ${row.accepted?html`<p>Saved in ${row.accepted.id} at revision ${row.accepted.revision}.</p><en-button variant="secondary" ?disabled=${!!this.task} @click=${(event:Event)=>this.action(event,async()=>{const target=this.row(id)?.accepted;if(target)await this.editor.run('Open imported document',()=>this.editor.open(target.id));})}>Open imported document</en-button>`:nothing}
  </li>`;
 }
 render(){const epoch=this.epoch,selected=this.rows.filter(row=>row.selected&&row.state==='ready'&&row.loaded).length;return html`<p>Choose PNG, JPEG or static WebP files. Review every valid image, then select the subset to import. Each accepted image is one Undo step.</p>
  <en-file-upload label="Image file" choose-label="Choose images" accept="image/png,image/jpeg,image/webp" multiple .files=${this.rows.flatMap(row=>row.file?[row.file]:[])} ?disabled=${!!this.task||this.editor.view.busy} @en-change=${(event:Event)=>this.fileChange(event,epoch)}></en-file-upload>
  <en-select label="Import destination" .value=${this.destination} ?disabled=${!!this.task||this.editor.view.busy||this.rows.some(row=>row.created&&!row.accepted||row.pending)} @en-change=${(event:Event)=>{const control=event.currentTarget as unknown as {value:string};this.adapter.settled(event,()=>control.value,value=>{try{if(epoch===this.epoch)this.chooseDestination(value);}catch(error){this.error=failure(error);this.changed();}});}}><en-select-option value="current" ?disabled=${!this.editor.view.document}>New layers in the current document</en-select-option><en-select-option value="new">One new document per image</en-select-option></en-select>
  ${this.destination==='current'&&this.target?html`<p>Destination ${this.target.id}, revision ${this.target.revision}. Imported images retain their native size.</p>`:html`<p>Each selected image creates a separate document at its reviewed dimensions.</p>`}
  <en-alert announcement="polite">${this.message}</en-alert>${this.error?html`<en-alert variant="warning">${this.error}</en-alert>`:nothing}<ol>${this.rows.map(row=>this.renderRow(row))}</ol>
  <en-button ?disabled=${!!this.task||!selected||!this.current()} @click=${(event:Event)=>this.action(event,()=>this.apply())}>Import selected images (${selected})</en-button>${this.stopped&&this.rows.length&&!this.task?html`<en-button variant="secondary" @click=${(event:Event)=>this.action(event,()=>this.resume())}>Resume review</en-button>`:nothing}<en-button variant="secondary" ?disabled=${!this.task} @click=${(event:Event)=>this.action(event,()=>this.stop())}>Stop batch</en-button>`;}
}
