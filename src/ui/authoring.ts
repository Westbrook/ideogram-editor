import {displayImage} from './display-image.js';
import {createDisplayPreviewURL,withDisplaySource,withAssetDisplaySource,validateDisplayImage,revokeDisplayPreviewURL} from '../observability/display-preview.js';
import {retainedMask,r16Mask} from '../raster/mapping.js';
import type {BlobRef} from '../protocol/store.js';
import {html,nothing} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Document} from '../protocol/store.js';
import type {Asset} from '../protocol/assets.js';
import type {ImageLayer} from '../protocol/history.js';
import type {MaskPlan,MaskOperation,Shape,Point,Combine} from '../raster/mask.js';
import {validateMaskPlan,validateShape,maskDraftValue,resolveMaskPlan} from '../raster/mask.js';
import {ControlAdapter} from './adapters.js';
import {SHA256} from '../protocol/sha256.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {modelPayloadBytes,reserveModelBytes,type ModelPayload,type OwnedModel} from '../observability/model-memory.js';
import {measureControl,ControlAdmissionError} from '../state/control-memory.js';
import {PromptReaderCleanupError,readRetainedPrompt} from '../observability/prompt-memory.js';

type ValueControl=HTMLElement & {value:string};
type DraftLayer=Pick<ImageLayer,'id'|'version'|'name'>;
type MaskDraft={document:Document;layer:DraftLayer;id:string;plan:MaskPlan};
type MaskPreview={generation:number;mask:Pick<Asset,'id'>;after:{raster:{width:number;height:number}};url:string;views:Record<string,string>;loaded:boolean;support:string;supportRect:{x:number;y:number;width:number;height:number}|null;hard:number;effective:number};
type ImportReview={asset:Pick<Asset,'id'> & {raster:{width:number;height:number}};review:{reviewId:string;reviewHash:string};target:Pick<Document,'id'|'revision'>|null};
type MoveLayer=Pick<ImageLayer,'id'|'version'|'assetId'|'layerToDocument'|'opacity'|'visible'|'locked'|'mask'>;
type StrokeBrush={size:number;hardness:number;mode:'add'|'subtract'};
type Gesture={id:number;points:Point[];tool:string;document:Document;layer?:MoveLayer;transform?:number[];layers:MoveLayer[];inputDownMs:number;trustedDown:boolean;rejected:boolean;strokeBytes:number;brush:StrokeBrush|null;zoomClick?:{x:number;y:number;out:boolean}};
type Model<T>={value:T;payload:Pick<ModelPayload,'resize'|'release'|'pin'>};
type Work={signal:AbortSignal;current():void};
type OverlayPattern={canvas:HTMLCanvasElement|null;pattern:CanvasPattern|null;context:CanvasRenderingContext2D;color:string;lease:AllocationLease;usable:boolean};
type AuthoringForm={tool:string;shape:'rectangle'|'ellipse'|'polygon';combine:Combine;brush:'add'|'subtract';size:string;hardness:string;radius:string;color:string;polygon:string;x:string;y:string;width:string;height:string;sampleX:string;sampleY:string;sampleScope:string;sampleText:string;previewMode:string;importName:string;importX:string;importY:string};
const DEFAULT_FORM:Readonly<AuthoringForm>=Object.freeze({tool:'Pan',shape:'rectangle' as 'rectangle'|'ellipse'|'polygon',combine:'replace' as Combine,brush:'add' as 'add'|'subtract',size:'20',hardness:'1',radius:'0',color:'#c778ee',polygon:'',x:'0',y:'0',width:'100',height:'100',sampleX:'0',sampleY:'0',sampleScope:'merged',sampleText:'No color sampled.',previewMode:'result',importName:'',importX:'0',importY:'0'});
const PLAN_BYTES=48000;
const aborted=()=>new DOMException('Authoring operation was superseded.','AbortError');
export class Authoring {
  private form:typeof DEFAULT_FORM=DEFAULT_FORM;
  private models=new Map<string,Model<unknown>>();private allModels=new Set<Model<unknown>>();private retired=new Set<Model<unknown>>();private retirements=new Set<Promise<void>>();private failedRetirements=new Set<Model<unknown>>();
  private workEpoch=0;private actions=new Map<AbortController,Promise<unknown>>();private actionOwners=new Map<string,AbortController>();private releasing=false;private releaseTask?:Promise<void>;
  private cleanupFailures=new Set<PromptReaderCleanupError>();
  private pointerTask:{timer:ReturnType<typeof setTimeout>;release:()=>void}|null=null;
  private selectionValue:MaskOperation[]=[];
  get selection(){return this.selectionValue;}
  set selection(value:MaskOperation[]){if(!value.length){this.selectionValue=[];this.drop('selection');return;}this.selectionValue=this.replace('selection',value);}
  private attachedKey='';private attachedPlan:MaskPlan|null=null;private attachedReady=false;
  private previewRead:AbortController|null=null;
  private adapter=new ControlAdapter();private generation=0;private restoring='';private session='';
  private draft:MaskDraft|null=null;private preview:MaskPreview|null=null;
  private invertImport=false;
  private gestureEpoch=0;private gesture:Gesture|null=null;
  private movePending=false;
  private overlayPattern:OverlayPattern|null=null;
  private previewCleanup=new Set<string>();
  private pendingImport:ImportReview|null=null;
  constructor(private editor:EditorClient,private changed:()=>void,private draw:()=>void,private display:(asset:string|null)=>Promise<void>,private afterRender?:()=>Promise<unknown>,private zoomAt?:(point:Point,out:boolean)=>void){}
  // All dynamic form strings are owned together. Native input/DOM copies remain
  // outside this logical payload count; refused values never replace this model.
  private setForm<K extends keyof typeof DEFAULT_FORM>(key:K,value:(typeof DEFAULT_FORM)[K]){
    if(this.form[key]===value)return;
    const bytes=modelPayloadBytes(this.form)-this.form[key].length*2+value.length*2;
    const next=this.make(bytes,()=>({...this.form,[key]:value}));
    try{if(key==='color')this.clearOverlayPattern();}catch(error){next.payload.release();throw error;}
    this.form=this.commit('form',next);
  }
  get tool(){return this.form.tool;}
  set tool(value:string){this.setForm('tool',value);}
  get shape(){return this.form.shape;}
  set shape(value:'rectangle'|'ellipse'|'polygon'){this.setForm('shape',value);}
  get combine(){return this.form.combine;}
  set combine(value:Combine){this.setForm('combine',value);}
  get brush(){return this.form.brush;}
  set brush(value:'add'|'subtract'){this.setForm('brush',value);}
  get size(){return this.form.size;}
  set size(value:string){this.setForm('size',value);}
  get hardness(){return this.form.hardness;}
  set hardness(value:string){this.setForm('hardness',value);}
  get radius(){return this.form.radius;}
  set radius(value:string){this.setForm('radius',value);}
  get color(){return this.form.color;}
  set color(value:string){this.setForm('color',value);}
  get polygon(){return this.form.polygon;}
  set polygon(value:string){this.setForm('polygon',value);}
  get x(){return this.form.x;}
  set x(value:string){this.setForm('x',value);}
  get y(){return this.form.y;}
  set y(value:string){this.setForm('y',value);}
  get width(){return this.form.width;}
  set width(value:string){this.setForm('width',value);}
  get height(){return this.form.height;}
  set height(value:string){this.setForm('height',value);}
  get sampleX(){return this.form.sampleX;}
  set sampleX(value:string){this.setForm('sampleX',value);}
  get sampleY(){return this.form.sampleY;}
  set sampleY(value:string){this.setForm('sampleY',value);}
  get sampleScope(){return this.form.sampleScope;}
  set sampleScope(value:string){this.setForm('sampleScope',value);}
  get sampleText(){return this.form.sampleText;}
  set sampleText(value:string){this.setForm('sampleText',value);}
  get previewMode(){return this.form.previewMode;}
  set previewMode(value:string){this.setForm('previewMode',value);}
  get importName(){return this.form.importName;}
  set importName(value:string){this.setForm('importName',value);}
  get importX(){return this.form.importX;}
  set importX(value:string){this.setForm('importX',value);}
  get importY(){return this.form.importY;}
  set importY(value:string){this.setForm('importY',value);}
  private make<T>(bytes:number,create:()=>T):Model<T>{
    // Live snapshots and render-retired generations share one finite cap.
    if(this.allModels.size>=96)throw Error('AUTHORING_MODEL_CAPACITY');
    const reservation=reserveModelBytes('authoring-model',bytes);let model:Model<T>;
    try{const value=create(),actual=modelPayloadBytes(value);if(actual>bytes)throw Error('AUTHORING_MODEL_ALLOWANCE');reservation.resize(actual);let refs=1,live=true;
      const unref=()=>{if(!--refs)this.allModels.delete(model);};
      const payload:Model<T>['payload']={resize:(bytes,handles)=>reservation.resize(bytes,handles),release:()=>{if(live){live=false;reservation.release();unref();}},pin:()=>{const release=reservation.pin();refs++;let pinned=true;return ()=>{if(pinned){pinned=false;release();unref();}};}};
      model={value,payload};this.allModels.add(model);return model;
    }catch(error){reservation.release();throw error;}
  }
  private copy<T>(value:T){return this.make(modelPayloadBytes(value),()=>structuredClone(value));}
  private retire(model:Model<unknown>){
    // The hook is explicit in the real shell; absent means a headless controller
    // whose caller owns no Lit committed values. Never substitute a timer for a
    // supplied renderer's actual updateComplete boundary.
    if(!this.afterRender){model.payload.release();return;}
    if(this.retired.has(model))return;this.retired.add(model);this.scheduleRetirement(model);
  }
  private scheduleRetirement(model:Model<unknown>){
    const pending=Promise.resolve().then(()=>{this.changed();return this.afterRender!();}).then(()=>{model.payload.release();this.retired.delete(model);}).catch(()=>{this.failedRetirements.add(model);});
    this.retirements.add(pending);void pending.then(()=>this.retirements.delete(pending));
  }
  private async drainRetirements(){while(this.retirements.size)await Promise.all([...this.retirements]);for(const model of this.failedRetirements){this.failedRetirements.delete(model);this.scheduleRetirement(model);}while(this.retirements.size)await Promise.all([...this.retirements]);if(this.failedRetirements.size)throw Error('AUTHORING_RENDER_RELEASE_UNCONFIRMED');}
  private commit<T>(key:string,next:Model<T>):T{const old=this.models.get(key);this.models.set(key,next);if(old)this.retire(old);return next.value;}
  private replace<T>(key:string,value:T):T{return this.commit(key,this.copy(value));}
  private drop(key:string){const old=this.models.get(key);this.models.delete(key);if(old)this.retire(old);}
  private pin(value:unknown){for(const owner of this.models.values())if(owner.value===value)return owner.payload.pin();throw Error('AUTHORING_MODEL_RELEASED');}
  private rememberCleanup(error:unknown){if(error instanceof PromptReaderCleanupError)this.cleanupFailures.add(error);else if(error instanceof AggregateError)for(const cause of error.errors)this.rememberCleanup(cause);}
  private work<T>(run:(work:Work)=>Promise<T>,key?:string):Promise<T>{
    if(this.releasing)return Promise.reject(aborted());
    let lease:AllocationLease;try{lease=allocationLedger.reserve({owner:'authoring-action',kind:'control',handles:1});}catch(error){return Promise.reject(error);}const abort=new AbortController(),epoch=this.workEpoch;
    if(key){this.actionOwners.get(key)?.abort();this.actionOwners.set(key,abort);}
    const work:Work={signal:abort.signal,current:()=>{if(abort.signal.aborted||epoch!==this.workEpoch)throw aborted();}};
    const result=Promise.resolve().then(()=>{work.current();return run(work);}).catch(error=>{this.rememberCleanup(error);throw error;}).finally(()=>{this.actions.delete(abort);if(key&&this.actionOwners.get(key)===abort)this.actionOwners.delete(key);lease.release();});
    this.actions.set(abort,result);return result;
  }
  private async readJSON<T>(path:string,work:Work,maxBytes=65536):Promise<OwnedModel<T>>{work.current();try{return await this.editor.ownedJSON<T>(path,'authoring-control',{signal:work.signal},()=>!work.signal.aborted,maxBytes);}catch(error){this.rememberCleanup(error);throw error;}}
  private measured(value:unknown,max=PLAN_BYTES){try{return measureControl(value,max);}catch(error){if(error instanceof ControlAdmissionError&&error.reason==='size')throw Error('MASK_DRAFT_TOO_LARGE');throw error;}}
  private validation<T>(plan:MaskPlan,check:()=>T){const size=this.measured(plan).encodedBytes,lease=allocationLedger.reserve({owner:'authoring-mask-validation',kind:'copy',cpuBytes:size*3,handles:2});try{return check();}finally{lease.release();}}
  private validate(plan:MaskPlan){this.validation(plan,()=>validateMaskPlan(plan));}
  private serializeDraft(d:MaskDraft,radius=this.radius){
    const value={schema:d.plan.schemaVersion===2?'local-mask-2':'local-mask-1',layerVersion:d.layer.version,radius,plan:d.plan},size=this.measured(value,65536).encodedBytes;
    const lease=allocationLedger.reserve({owner:'authoring-draft-serialization',kind:'copy',cpuBytes:size*2,handles:1});
    try{const text=JSON.stringify(value);this.editor.changeDraft(d.id,'mask',text,d.layer.id,false);}finally{lease.release();}
  }
  private acceptDraft(next:Model<MaskDraft>,form?:Model<typeof DEFAULT_FORM>){try{this.validate(next.value.plan);this.serializeDraft(next.value,form?.value.radius??this.radius);}catch(error){next.payload.release();form?.payload.release();throw error;}this.draft=this.commit('draft',next);if(form)this.form=this.commit('form',form);this.invalidate();this.changed();this.draw();}
  private changeRadius(radius:string){if(!this.draft){this.radius=radius;return;}const form=this.make(modelPayloadBytes(this.form)-this.radius.length*2+radius.length*2,()=>({...this.form,radius}));let next:Model<MaskDraft>;try{next=this.copy(this.draft);}catch(error){form.payload.release();throw error;}this.acceptDraft(next,form);}
  private startFresh(){this.acceptDraft(this.freshDraft(true));}
  get drawing(){return !!this.gesture;}
  private readable(error:unknown){const messages:Record<string,string>={MASK_SHAPE:'Selection width and height must be positive, finite document coordinates.',MASK_POLYGON:'Enter at least three polygon points.',MASK_POINTS:'Enter finite x,y pairs for each point.',MASK_IMPORT:'Mask alignment must use whole document pixels at the imported native size.',MASK_STROKE:'Use a brush diameter above 0 and at most 8192 pixels, and hardness between 0 and 1.',MASK_DRAFT_TOO_LARGE:'This complete stroke or selection exceeds the local command size. Your previous draft is retained; use shorter strokes.'};return error instanceof Error&&messages[error.message]?Error(messages[error.message]):error;}
  private report(error:unknown){if(!(error instanceof DOMException&&error.name==='AbortError'))this.editor.fail(this.readable(error));}
  private run(label:string,work:()=>Promise<void>){void this.editor.run(label,async()=>{try{await work();}catch(error){if(error instanceof DOMException&&error.name==='AbortError')return;throw this.readable(error);}});}
  private button(e:Event,label:string,work:()=>Promise<void>){this.adapter.action(e,()=>this.run(label,work));}
  private mutate(e:Event,work:()=>void){this.adapter.action(e,()=>{try{work();this.changed();this.draw();}catch(error){this.report(error);}});}
  private value(e:Event,set:(v:string)=>void,accepted:()=>string){const h=e.currentTarget as ValueControl;this.adapter.settled(e,()=>h.value,v=>{try{set(v);this.changed();}catch(error){this.adapter.write(h,'value',accepted());this.report(error);}});}
  private number(value:string,label:string){if(!value.trim()||!Number.isFinite(Number(value)))throw Error('Enter a finite '+label+'.');return Number(value);}
  private field(label:string,key:keyof AuthoringForm,set:(v:string)=>void=value=>this.setForm(key,value)){const epoch=this.workEpoch;return html`<en-number-field label=${label} .value=${this.form[key]} @en-change=${(e:Event)=>{if(epoch===this.workEpoch)this.value(e,set,()=>this.form[key]);}}></en-number-field>`;}
  private select(label:string,key:keyof AuthoringForm,items:string[],set:(v:string)=>void){const epoch=this.workEpoch;return html`<en-segmented-control label=${label} .value=${this.form[key]} .items=${items.map(value=>({value,label:value}))} @en-change=${(e:Event)=>{if(epoch===this.workEpoch)this.value(e,set,()=>this.form[key]);}}></en-segmented-control>`;}
  choose(tool:string){this.tool=tool;this.cancelGesture();this.changed();this.draw();}
  private current(){const document=this.editor.view.document,layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);if(!document||!layer)throw Error('Select a layer for the local mask.');if(layer.locked)throw Error('Unlock the layer before changing its mask.');return {document,layer};}
  private stale(){return !!this.draft&&(this.editor.view.document?.id!==this.draft.document.id||this.editor.view.document?.revision!==this.draft.document.revision);}
  private invalidate(){
    this.generation++;if(this.preview)for(const url of Object.values(this.preview.views))this.previewCleanup.add(url);this.preview=null;this.drop('preview');
    const errors:unknown[]=[];
    try{this.previewRead?.abort();this.previewRead=null;}catch(error){errors.push(error);}
    try{this.clearOverlayPattern();}catch(error){errors.push(error);}
    for(const url of this.previewCleanup)try{revokeDisplayPreviewURL(url);this.previewCleanup.delete(url);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'AUTHORING_PREVIEW_CLEANUP');
  }
  private save(){const d=this.draft;if(d)this.acceptDraft(this.copy(d));}
  private freshDraft(fresh=false):Model<MaskDraft>{
    const {document,layer}=this.current(),radius=this.number(this.radius,'feather radius');if(radius<0||radius>64)throw Error('Feather radius must be between 0 and 64 document pixels.');if(!fresh&&layer.mask&&!this.attachedReady)throw Error('The attached mask is still loading. Try again when its geometry is available.');
    const baseline=!fresh?this.attachedPlan:null,thin={id:layer.id,version:layer.version,name:layer.name},id=this.draft?.document.id===document.id&&this.draft.layer.id===layer.id?this.draft.id:crypto.randomUUID();
    const value={document,layer:thin,id,plan:{...(baseline?.schemaVersion===2?{schemaVersion:2 as const}:{}),width:document.width,height:document.height,feather:baseline?.feather??radius,operations:baseline?.operations??[]}};
    return this.copy(value);
  }
  private begin(fresh=false){const next=this.freshDraft(fresh);try{this.validate(next.value.plan);}catch(error){next.payload.release();throw error;}this.draft=this.commit('draft',next);this.invalidate();}
  private push(op:MaskOperation,fresh=false){
    const initial=fresh||!this.draft?this.freshDraft(fresh):null,d=initial?.value??this.draft!;
    try{if(!fresh&&this.stale())throw Error('Mask draft is stale. Start a fresh mask to bind the current layer revision.');const before=this.measured(d.plan),extra=this.measured(op);if(before.encodedBytes+extra.encodedBytes+(d.plan.operations.length?1:0)>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');
      const next=this.make(modelPayloadBytes(d)+extra.logicalBytes,()=>{const copy=structuredClone(d);copy.plan.operations.push(structuredClone(op));return copy;});let form:Model<typeof DEFAULT_FORM>|undefined;try{if(initial&&!fresh&&this.attachedPlan){const radius=String(next.value.plan.feather);form=this.make(modelPayloadBytes(this.form)-this.radius.length*2+radius.length*2,()=>({...this.form,radius}));}}catch(error){next.payload.release();throw error;}this.acceptDraft(next,form);
    }finally{initial?.payload.release();}
  }
  private numericShape():Shape {
    if(this.shape!=='polygon'){const shape={kind:this.shape,x:this.number(this.x,'selection X'),y:this.number(this.y,'selection Y'),width:this.number(this.width,'selection width'),height:this.number(this.height,'selection height')};validateShape(shape);return this.replace('numeric-shape',shape);}
    // Bound before trim/split/map. Each token needs at least one source unit;
    // at most 2N UTF-16 units each for the trimmed string and token strings,
    // 4N bytes for numeric values and 4N for point coordinates: <=12N bytes.
    // The fixed 64 bytes cover shape keys/kind and the empty-input token.
    if(this.polygon.length>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');
    const scratch=allocationLedger.reserve({owner:'authoring-polygon-parse',kind:'copy',cpuBytes:this.polygon.length*12+64,handles:3});
    try{const tokens=this.polygon.trim().split(/[\s,;]+/),values=tokens.map(Number);if(values.length%2||values.some(n=>!Number.isFinite(n)))throw Error('Enter polygon points as x,y pairs.');const shape:Shape={kind:'polygon',points:Array.from({length:values.length/2},(_,i)=>[values[i*2],values[i*2+1]])};validateShape(shape);this.measured(shape);return this.commit('numeric-shape',this.make(modelPayloadBytes(shape),()=>shape));}finally{scratch.release();}
  }
  private selectShape(shape:Shape){
    validateShape(shape);const next={kind:'shape' as const,shape,mode:this.combine},extra=this.measured(next),document=this.editor.view.document;if(!document)throw Error('Open a document to select.');
    const replace=this.combine==='replace',before=this.measured({width:document.width,height:document.height,feather:0,operations:replace?[]:this.selection});if(before.encodedBytes+extra.encodedBytes+(!replace&&this.selection.length?1:0)>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');
    const owned=this.make((replace?0:modelPayloadBytes(this.selection))+extra.logicalBytes,()=>replace?[structuredClone(next)]:[...structuredClone(this.selection),structuredClone(next)]);
    let form:Model<typeof DEFAULT_FORM>|undefined;try{if(shape.kind!=='polygon'){const next={...this.form,x:String(shape.x),y:String(shape.y),width:String(shape.width),height:String(shape.height)};form=this.copy(next);}}catch(error){owned.payload.release();throw error;}this.selectionValue=this.commit('selection',owned);if(form)this.form=this.commit('form',form);if(this.models.get('numeric-shape')?.value===shape)this.drop('numeric-shape');this.changed();this.draw();
  }
  private applySelection(){const shape=this.numericShape();try{this.selectShape(shape);}finally{if(this.models.get('numeric-shape')?.value===shape)this.drop('numeric-shape');}}
  private clearSelection(){const form=this.make(modelPayloadBytes(this.form)-this.polygon.length*2,()=>({...this.form,polygon:''}));this.form=this.commit('form',form);this.selectionValue=[];this.drop('selection');this.drop('numeric-shape');}
  private useSelection(){if(!this.selection.length)throw Error('Create a selection first.');const next=this.freshDraft(true);try{this.validate({width:next.value.document.width,height:next.value.document.height,feather:this.number(this.radius,'feather radius'),operations:this.selection});const bytes=modelPayloadBytes(next.value)+modelPayloadBytes(this.selection);next.payload.resize(bytes);next.value.plan.operations=structuredClone(this.selection);}catch(error){next.payload.release();throw error;}this.acceptDraft(next);}
  private async savedText(id:string,work:Work){
    const owner=this.editor.draftOwner;if(!owner)throw Error('DRAFT_OWNER_DISPOSED');let retained:Awaited<ReturnType<typeof readRetainedPrompt>>|undefined;
    try{await owner.restoreDraft(id,async assetId=>{work.current();const admitted=allocationLedger.reserve({owner:'authoring-saved-mask-response',kind:'control',handles:1});let response:Response;
      try{response=await this.editor.session.transport('/api/v1/assets/'+assetId+'/content',{signal:work.signal});}catch(error){admitted.release();throw error;}
      const raw=response.headers.get('content-length'),length=raw!==null&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):NaN;
      retained=await readRetainedPrompt(response,Number.isSafeInteger(length)&&length<=65536?length:NaN,()=>!work.signal.aborted&&this.editor.draftOwner===owner,work.signal,admitted);if(!response.ok)throw Error('DRAFT_UNAVAILABLE');return retained.text;
    });work.current();if(this.editor.draftOwner!==owner)throw aborted();const text=owner.drafts.get(id)?.text??'';
      const payload=reserveModelBytes('authoring-restored-draft-text',text.length*2);return {text,release:()=>payload.release()};
    }finally{retained?.lease.release();}
  }
  async sync(){
    if(!this.editor.view.ready||this.releasing)return;
    const current=this.editor.view.document,layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]),attachedKey=(current?.id??'')+':'+(layer?.id??'')+':'+(layer?.version??'');
    if(attachedKey!==this.attachedKey){this.actionOwners.get('attached')?.abort();this.attachedKey=attachedKey;this.attachedPlan=null;this.drop('attached');this.attachedReady=!layer?.mask;
      if(layer?.mask){const source=this.copy({key:attachedKey,width:current!.width,height:current!.height,mask:layer.mask});void this.work(async work=>{try{const s=source.value,response=await this.readJSON<{plan:{authoring?:MaskPlan;hard?:BlobRef}}>('/api/v1/assets/'+s.mask.assetId+'/raster',work);try{work.current();if(s.key!==this.attachedKey)return;const m=response.value,mask=s.mask;
        const plan:MaskPlan=retainedMask(mask)?{schemaVersion:2,width:s.width,height:s.height,feather:m.plan.authoring?.feather??0,operations:[{kind:'retained-hard-v1',mask,hard:r16Mask(mask)?m.plan.hard!:null}]}:mask.mapping==='document-r16-v1'&&m.plan.authoring?m.plan.authoring:{width:s.width,height:s.height,feather:0,operations:[{kind:'import',assetId:mask.assetId,x:0,y:0,width:s.width,height:s.height,inverted:mask.inverted}]};
        const extra=mask.mapping==='document-r16-v1'&&!!m.plan.authoring&&mask.inverted?{kind:'invert' as const}:null,before=this.measured(plan);if(extra&&before.encodedBytes+this.measured(extra).encodedBytes+(plan.operations.length?1:0)>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');
        const owned=this.make(modelPayloadBytes(plan)+(extra?modelPayloadBytes(extra):0),()=>{const copy=structuredClone(plan);if(extra)copy.operations.push(extra);return copy;});try{this.validate(owned.value);}catch(error){owned.payload.release();throw error;}this.attachedPlan=this.commit('attached',owned);this.attachedReady=true;this.changed();
      }finally{response.release();}}finally{source.payload.release();}},'attached').catch(error=>{source.payload.release();this.report(error);});}
    }
    const key=this.editor.sessionId+':'+(this.editor.view.document?.id??'');if(key===this.session)return;this.actionOwners.get('restore')?.abort();this.session=key;this.cancelGesture();this.invalidate();this.draft=null;this.drop('draft');this.selectionValue=[];this.drop('selection');this.pendingImport=null;this.drop('import');
    if(!this.editor.view.ready||!this.editor.view.document)return;this.restoring=key;
    const saved=this.editor.ui?.drafts.find(d=>d.kind==='mask'&&d.documentId===this.editor.view.document!.id&&d.status==='saved-unapplied');if(!saved)return;
    const savedCopy=this.copy(saved);
    return this.work(async work=>{try{const retained=await this.savedText(savedCopy.value.id,work);let parsed:Model<any>|undefined;try{const text=retained.text;work.current();if(this.restoring!==key||this.session!==key||this.draft)return;if(text.length>65536)throw Error('MASK_DRAFT_TOO_LARGE');parsed=this.make(text.length*4+8,()=>JSON.parse(text));this.measured(parsed.value,65536);this.validation(parsed.value.plan,()=>maskDraftValue(parsed!.value));
        const restored=this.editor.view.image?.layers.find(l=>l.id===savedCopy.value.targetLayerId);if(!restored)return;
        const value=parsed.value,source={document:{...this.editor.view.document!,revision:savedCopy.value.expectedDocumentRevision},layer:{id:restored.id,version:value.layerVersion,name:restored.name},id:savedCopy.value.id,plan:value.plan};
        // maskBindings builds identifier arrays/sets before resolveMaskPlan's
        // clone. The plan and binding payload bound those repeated identifiers.
        const namespace=allocationLedger.reserve({owner:'authoring-mask-bindings',kind:'copy',cpuBytes:2*(modelPayloadBytes(value.plan)+modelPayloadBytes(savedCopy.value.maskBindings)),handles:3});let next:Model<MaskDraft>;
        try{next=this.make(modelPayloadBytes(source),()=>({document:structuredClone(source.document),layer:{...source.layer},id:source.id,plan:resolveMaskPlan(value.plan,savedCopy.value.maskBindings!)}));}finally{namespace.release();}
        try{this.radius=value.radius;}catch(error){next.payload.release();throw error;}this.draft=this.commit('draft',next);this.changed();
      }finally{parsed?.payload.release();retained.release();}
    }finally{savedCopy.payload.release();}},'restore').catch(error=>{savedCopy.payload.release();this.report(error);});
  }
  private layerProjection(selected:string,maskId:string){
    const layers=this.editor.view.image!.layers,project=(l:ImageLayer)=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.id===selected?{assetId:maskId,mapping:'document-r16-v1' as const,inverted:false}:l.mask});
    let bytes=0;for(const layer of layers)if(layer.visible)bytes+=modelPayloadBytes(project(layer));
    return this.make(bytes,()=>{const values:ReturnType<typeof project>[]=[];for(const layer of layers)if(layer.visible)values.push(structuredClone(project(layer)));return values;});
  }
  private prepare(){return this.work(async work=>{
    let d=this.draft;if(!d)throw Error('Create a mask draft first.');if(this.stale())throw Error('Mask draft is stale. Start a fresh mask for the current revision.');
    const radius=this.number(this.radius,'feather radius');if(radius<0||radius>64)throw Error('Feather radius must be between 0 and 64 document pixels.');if(radius!==d.plan.feather){const next=this.copy(d);next.value.plan.feather=radius;this.acceptDraft(next);d=this.draft!;}
    this.validate(d.plan);const generation=this.generation,plan=this.copy(d.plan),urls:Record<string,string>={};let release=()=>{};let output:Model<{mask:Asset;after:Asset;hard?:Asset}>|undefined;
    const owns=()=>!work.signal.aborted&&this.draft===d&&generation===this.generation&&!this.stale();
    try{release=this.pin(d);await this.editor.flushDrafts();work.current();if(!owns())throw aborted();
      output=await this.editor.withCommandEvents({type:'PrepareMask',plan:plan.value},events=>{work.current();const event=events.find(e=>e.type==='AssetRegistered');if(event?.type!=='AssetRegistered')throw Error('Mask preview is unavailable.');return this.copy({mask:event.payload.asset,after:event.payload.asset});},null);if(!owns())throw aborted();
      const layers=this.layerProjection(d.layer.id,output.value.mask.id);
      try{const mask=output.value.mask,revised=await this.editor.withCommandEvents({type:'ComposeRaster',width:plan.value.width,height:plan.value.height,layers:layers.value},events=>{work.current();const event=events.find(e=>e.type==='AssetRegistered');if(event?.type!=='AssetRegistered')throw Error('Mask result preview is unavailable.');return this.copy({mask,after:event.payload.asset});},null);output.payload.release();output=revised;}finally{layers.payload.release();}if(!owns())throw aborted();
      const response=await this.readJSON<{plan:{statistics:{support:{x:number;y:number;width:number;height:number}|null;hardPixels:number;effectivePixels:number}}}>('/api/v1/assets/'+output.value.mask.id+'/raster',work);let stats:Model<{support:{x:number;y:number;width:number;height:number}|null;hardPixels:number;effectivePixels:number}>;try{stats=this.copy(response.value.plan.statistics);}finally{response.release();}
      try{work.current();if(!owns())throw aborted();const abort=new AbortController();this.previewRead=abort;const abortPreview=()=>abort.abort();work.signal.addEventListener('abort',abortPreview,{once:true});
        try{const transport=this.editor.session.transport.bind(this.editor.session);urls.result=await withAssetDisplaySource(output.value.after,'pixels',source=>createDisplayPreviewURL(transport,source,{owner:'authoring-result-preview',edge:1024,signal:abort.signal,owns}));work.current();if(!owns())throw aborted();
          const hardCopy=await this.editor.withCommandEvents({type:'PrepareMask',plan:{...plan.value,feather:0}},events=>{work.current();const hard=events.find(e=>e.type==='AssetRegistered');if(hard?.type!=='AssetRegistered')throw Error('Hard mask preview is unavailable.');return this.copy(hard.payload.asset);},null);
          try{for(const [key,id]of [['hard',hardCopy.value.id],['effective',output.value.mask.id],['original',d.document.image?.compositeAssetId]]as const){if(!id)continue;work.current();if(!owns())throw aborted();const preview=(source:Parameters<typeof createDisplayPreviewURL>[1])=>createDisplayPreviewURL(transport,source,{owner:'authoring-mask-preview',edge:1024,signal:abort.signal,owns});urls[key]=key==='original'?await withDisplaySource(transport,id,{owner:'authoring-mask-descriptor',signal:abort.signal,owns},preview):await withAssetDisplaySource(key==='hard'?hardCopy.value:output.value.mask,'pixels',preview);}}
          finally{hardCopy.payload.release();}
        }finally{work.signal.removeEventListener('abort',abortPreview);if(this.previewRead===abort)this.previewRead=null;}
        work.current();if(!owns())throw aborted();const s=stats.value.support;
        const preview=this.copy({mask:{id:output.value.mask.id},after:{raster:{width:output.value.after.raster!.width,height:output.value.after.raster!.height}},generation,url:urls.result,views:urls,loaded:false,support:s?`X ${s.x}, Y ${s.y}, width ${s.width}, height ${s.height}`:'empty',supportRect:s,hard:stats.value.hardPixels,effective:stats.value.effectivePixels});
        try{this.previewMode='result';if(this.preview)for(const url of Object.values(this.preview.views)){this.previewCleanup.add(url);revokeDisplayPreviewURL(url);this.previewCleanup.delete(url);}}catch(error){preview.payload.release();throw error;}this.preview=this.commit('preview',preview);this.changed();this.draw();
      }finally{stats.payload.release();}
    }catch(error){for(const url of Object.values(urls)){this.previewCleanup.add(url);try{revokeDisplayPreviewURL(url);this.previewCleanup.delete(url);}catch(cleanup){this.rememberCleanup(cleanup);}}throw error;}
    finally{output?.payload.release();plan.payload.release();release();}
  });}
  private apply(){return this.work(async work=>{const d=this.draft,p=this.preview;if(!d||!p||!p.loaded||p.generation!==this.generation||this.stale())throw Error('Prepare and inspect a current mask preview before Apply.');const releaseDraft=this.pin(d),releasePreview=this.pin(p);try{await this.editor.flushDrafts();work.current();if(this.draft!==d||this.preview!==p||this.stale())throw Error('Mask draft changed.');const saved=this.editor.draftOwner?.drafts.get(d.id);if(!saved||saved.savedGeneration!==saved.generation)throw Error('Save the current mask draft before Apply.');await this.editor.withCommandEvents({type:'SetLayerProperties',layerId:d.layer.id,layerVersion:d.layer.version,properties:{mask:{assetId:p.mask.id,mapping:'document-r16-v1',inverted:false}},draft:{sessionId:this.editor.sessionId,draftId:d.id,generation:saved.generation}},()=>undefined,d.document);work.current();if(this.draft!==d||this.preview!==p)throw aborted();this.invalidate();this.draft=null;this.drop('draft');this.changed();this.draw();}finally{releasePreview();releaseDraft();}});}
  private cancel(){return this.work(async work=>{const d=this.draft,release=d?this.pin(d):()=>{};try{if(d){await this.editor.flushDrafts();work.current();await this.editor.clearDraft(d.id);work.current();}if(this.draft!==d)throw aborted();this.invalidate();this.draft=null;this.drop('draft');this.editor.patch({message:'Mask draft canceled. Accepted layer unchanged.'});this.changed();this.draw();}finally{release();}});}
  private importPNG(file:File){return this.work(async work=>{if(file.type!=='image/png')throw Error('Choose a static PNG mask.');const before=this.editor.view.document?.id;await this.editor.importImage(file);work.current();const r=this.editor.view.review;if(r?.kind!=='image')throw Error('Mask conversion preview is unavailable.');if(before!==this.editor.view.document?.id)throw Error('Document changed; choose the mask again.');
    const next=this.copy({asset:{id:r.asset.id,raster:{width:r.asset.raster!.width,height:r.asset.raster!.height}},review:{reviewId:r.review.reviewId,reviewHash:r.review.reviewHash},target:r.target?{id:r.target.id,revision:r.target.revision}:null});
    try{this.importName=file.name;this.editor.patch({review:null});}catch(error){next.payload.release();throw error;}this.pendingImport=this.commit('import',next);this.invalidate();this.changed();
  });}
  private importInput(r:ImportReview){const {document}=this.current(),value={width:document.width,height:document.height,op:{kind:'import' as const,assetId:r.asset.id,x:this.number(this.importX,'mask X'),y:this.number(this.importY,'mask Y'),width:r.asset.raster.width,height:r.asset.raster.height,inverted:this.invertImport}};this.validate({width:value.width,height:value.height,feather:this.number(this.radius,'feather radius'),operations:[value.op]});return this.copy(value);}
  private useImport(){return this.work(async work=>{const r=this.pendingImport;if(!r)throw Error('Choose a PNG mask first.');const release=this.pin(r);let input:ReturnType<Authoring['importInput']>|undefined;
    try{if(r.target?.id!==this.editor.view.document?.id||r.target?.revision!==this.editor.view.document?.revision)throw Error('Mask import is stale; choose the PNG again.');input=this.importInput(r);
      const approved=await this.editor.withCommandEvents({type:'ApproveRaster',assetId:r.asset.id,reviewId:r.review.reviewId,reviewHash:r.review.reviewHash},events=>{work.current();if(this.pendingImport!==r)throw aborted();const a=events.find(e=>e.type==='AssetRegistered');if(a?.type!=='AssetRegistered')throw Error('Mask conversion was not approved.');return a.payload.asset.id;},null);work.current();if(this.pendingImport!==r)throw aborted();
      input.payload.resize(modelPayloadBytes(input.value)-input.value.op.assetId.length*2+approved.length*2);input.value.op.assetId=approved;this.push(input.value.op,true);this.pendingImport=null;this.drop('import');input.payload.release();input=undefined;await this.prepare();
    }finally{input?.payload.release();release();}
  });}
  private sampleTarget(x:number,y:number){const current=this.editor.view.document;if(!current)throw Error('Open a document to sample.');if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<0||y<0||x>=current.width||y>=current.height)throw Error('Sample coordinates must be integer pixels inside the document.');return this.copy({id:current.id,revision:current.revision,width:current.width,height:current.height,assetId:current.image?.compositeAssetId,selected:this.editor.view.selected[0],scope:this.sampleScope});}
  private target(){const {document,layer}=this.current();return this.copy({document,layer:{id:layer.id,version:layer.version}});}
  private detach(){return this.work(async work=>{const target=this.target();try{const {document,layer}=target.value;await this.editor.withCommandEvents({type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:null},draft:null},()=>undefined,document);work.current();}finally{target.payload.release();}});}
  sample(x:number,y:number){return this.work(async work=>{const document=this.sampleTarget(x,y),generation=++this.sampleGeneration,selected=document.value.selected,scope=document.value.scope;let assetId=document.value.assetId;
    try{if(scope==='active'){const l=this.editor.view.image?.layers.find(l=>l.id===selected);if(!l)throw Error('Select an active layer to sample.');const input=this.copy({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask});try{assetId=await this.editor.withCommandEvents({type:'ComposeRaster',width:document.value.width,height:document.value.height,layers:[input.value]},events=>{work.current();const a=events.find(e=>e.type==='AssetRegistered');if(a?.type!=='AssetRegistered')throw Error('Sample is unavailable.');return a.payload.asset.id;},null);}finally{input.payload.release();}}
      if(!assetId)throw Error('There is no retained raster to sample.');const response=await this.readJSON<{rgba:number[]}>('/api/v1/assets/'+assetId+'/sample?x='+x+'&y='+y,work);try{work.current();if(generation!==this.sampleGeneration||scope!==this.sampleScope||scope==='active'&&selected!==this.editor.view.selected[0]||this.editor.view.document?.revision!==document.value.revision||this.editor.view.document?.id!==document.value.id)return;const rgba=response.value.rgba;if(!Array.isArray(rgba)||rgba.length!==4||rgba.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Sample is unavailable.');/* Finite number strings use at most 24 units each; four byte channels and labels keep derived strings/temporary channel text below 256 UTF-16 units. Admit before formatting. */const form=this.make(modelPayloadBytes(this.form)+512,()=>({...this.form,sampleX:String(x),sampleY:String(y),sampleText:`X ${x}, Y ${y} · sRGB RGBA (${rgba.join(', ')}) · alpha ${rgba[3]}/255`,color:'#'+rgba.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('')}));try{this.clearOverlayPattern();}catch(error){form.payload.release();throw error;}this.form=this.commit('form',form);this.changed();this.draw();}finally{response.release();}
    }finally{document.payload.release();}
  },'sample');}
  private sampleGeneration=0;
  pointerDown(e:PointerEvent,p:Point){
    if(this.tool==='Zoom'&&e.button===0&&(this.editor.view.busy||!this.editor.view.document||this.releasing))return true;
    if(!['Select','Mask','Move','Sample','Zoom'].includes(this.tool)||e.button!==0||this.editor.view.busy||!this.editor.view.document||this.releasing)return false;
    if(this.pointerTask){this.report(Error('The previous pointer action is still finishing.'));return true;}
    if(this.tool==='Sample'){this.run('Sample canonical color',()=>this.sample(Math.floor(p[0]),Math.floor(p[1])));return true;}
    const layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);if(this.tool==='Move'&&(!layer||layer.locked))return true;
    let next:Model<Gesture>|undefined;
    try{if(this.tool==='Select'&&this.shape==='polygon'){const suffix=(this.polygon?'\n':'')+p.map(n=>Math.round(n*100)/100).join(', ');if(this.polygon.length+suffix.length>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');const form=this.make(modelPayloadBytes(this.form)+suffix.length*2,()=>({...this.form,polygon:this.polygon+suffix}));this.form=this.commit('form',form);this.changed();return true;}
      const move=(l:ImageLayer):MoveLayer=>({id:l.id,version:l.version,assetId:l.assetId,layerToDocument:l.layerToDocument,opacity:l.opacity,visible:l.visible,locked:l.locked,mask:l.mask}),moving=this.tool==='Move',brush=this.tool==='Mask'?{size:this.number(this.size,'brush size'),hardness:this.number(this.hardness,'brush hardness'),mode:this.brush}:null;
      const zoomClick=this.tool==='Zoom'?{x:e.clientX,y:e.clientY,out:e.altKey}:undefined;
      const shell={id:e.pointerId,points:[p],tool:this.tool,document:this.editor.view.document,layer:moving&&layer?move(layer):undefined,transform:moving&&layer?layer.layerToDocument:undefined,layers:[] as MoveLayer[],inputDownMs:e.timeStamp,trustedDown:e.isTrusted,rejected:false,strokeBytes:0,brush,zoomClick};
      const layers=moving?this.editor.view.image?.layers??[]:[];let bytes=modelPayloadBytes(shell);for(const layer of layers)bytes+=modelPayloadBytes(move(layer));
      next=this.make(bytes,()=>({...structuredClone(shell),layers:layers.map(layer=>structuredClone(move(layer)))} as Gesture));
      if(brush){const stroke={kind:'stroke' as const,points:next.value.points,...brush};next.value.strokeBytes=this.measured(stroke).encodedBytes;this.validate({width:next.value.document.width,height:next.value.document.height,feather:0,operations:[stroke]});}
      this.gestureEpoch++;this.gesture=this.commit('gesture',next);next=undefined;(e.target as HTMLElement).setPointerCapture(e.pointerId);return true;
    }catch(error){next?.payload.release();this.report(error);return true;}
  }

  private strokeBase(g:Gesture){const plan=this.draft?.plan??{...((this.attachedPlan?.schemaVersion===2)?{schemaVersion:2 as const}:{}),width:g.document.width,height:g.document.height,feather:this.attachedPlan?.feather??this.number(this.radius,'feather radius'),operations:this.attachedPlan?.operations??[]};return this.measured(plan).encodedBytes+(plan.operations.length?1:0);}
  private strokePoint(g:Gesture,p:Point){const encoded=this.measured(p).encodedBytes,before=this.strokeBase(g);if(before+g.strokeBytes+encoded+2>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');const owned=this.models.get('gesture');if(owned?.value!==g)throw Error('AUTHORING_MODEL_RELEASED');owned.payload.resize(modelPayloadBytes(g)+16);g.points.push([p[0],p[1]]);g.strokeBytes+=encoded+1;}
  pointerMove(e:PointerEvent,p:Point){const g=this.gesture;if(!g||g.id!==e.pointerId)return false;if(g.rejected)return true;
    try{if(g.tool==='Zoom'){if(Math.hypot(e.clientX-g.zoomClick!.x,e.clientY-g.zoomClick!.y)>4)g.rejected=true;return true;}if(g.tool==='Mask')this.strokePoint(g,p);else{const owned=this.models.get('gesture')!;owned.payload.resize(modelPayloadBytes(g)+(g.points.length===1?16:0));g.points=[g.points[0],[p[0],p[1]]];}this.draw();if(g.tool==='Move')void this.previewMove(g,e).catch(error=>this.report(error));}
    catch(error){g.rejected=true;g.points=[];this.models.get('gesture')?.payload.resize(modelPayloadBytes(g));this.report(error);this.draw();}return true;
  }
  private moveInput(g:Gesture,point:Point){
    const scratch=allocationLedger.reserve({owner:'authoring-move-matrix',kind:'copy',cpuBytes:6*8,handles:1});try{
    const transform=[...g.transform!] as [number,number,number,number,number,number];transform[4]+=point[0]-g.points[0][0];transform[5]+=point[1]-g.points[0][1];
    const base={type:'ComposeRaster' as const,width:g.document.width,height:g.document.height,layers:[] as {assetId:string;transform:ImageLayer['layerToDocument'];opacity:number;mask:ImageLayer['mask']}[]},project=(l:MoveLayer)=>({assetId:l.assetId,transform:l.id===g.layer!.id?transform:l.layerToDocument,opacity:l.opacity,mask:l.mask});let bytes=modelPayloadBytes(base);for(const layer of g.layers)if(layer.visible)bytes+=modelPayloadBytes(project(layer));
    return this.make(bytes,()=>{for(const layer of g.layers)if(layer.visible)base.layers.push(structuredClone(project(layer)));return base;});
    }finally{scratch.release();}
  }
  private previewMove(g:Gesture,event?:PointerEvent){if(this.movePending||!g.layer||!g.transform||this.gesture!==g)return Promise.resolve();const release=this.pin(g);this.movePending=true;return this.work(async work=>{if(event?.defaultPrevented)return;const point=g.points.at(-1)!,epoch=this.gestureEpoch;try{const input=this.moveInput(g,point);try{await this.editor.withCommandEvents(input.value,async events=>{work.current();const asset=events.find(e=>e.type==='AssetRegistered');if(this.gesture===g&&epoch===this.gestureEpoch&&g.document.revision===this.editor.view.document?.revision&&g.document.id===this.editor.view.document?.id&&point===g.points.at(-1)&&asset?.type==='AssetRegistered')await this.display(asset.payload.asset.id);},null);}finally{input.payload.release();}}
      finally{this.movePending=false;if(!work.signal.aborted&&this.gesture===g&&point!==g.points.at(-1))void this.previewMove(g).catch(error=>this.report(error));}
    }).finally(()=>{release();this.movePending=false;});}
  pointerUp(e:PointerEvent,p:Point){const g=this.gesture;if(!g||g.id!==e.pointerId)return false;const release=this.pin(g);this.gesture=null;this.drop('gesture');if(g.tool!=='Zoom')void this.display(null).catch(error=>this.report(error));if(g.zoomClick&&Math.hypot(e.clientX-g.zoomClick.x,e.clientY-g.zoomClick.y)>4)g.rejected=true;const epoch=this.gestureEpoch;
    const timer=setTimeout(()=>{this.pointerTask=null;if(e.defaultPrevented||epoch!==this.gestureEpoch||g.rejected){release();return;}
      void this.work(async work=>{try{if(g.document.id!==this.editor.view.document?.id||g.document.revision!==this.editor.view.document?.revision)throw Error('Gesture became stale; no change applied.');const start=g.points[0];
        if(g.tool==='Zoom')this.zoomAt?.(start,g.zoomClick!.out);
        else if(g.tool==='Select')this.selectShape({kind:this.shape==='ellipse'?'ellipse':'rectangle',x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),width:Math.abs(p[0]-start[0]),height:Math.abs(p[1]-start[1])});
        else if(g.tool==='Mask'){const extra=this.measured(p).encodedBytes;if(g.strokeBytes+extra+1+this.strokeBase(g)>PLAN_BYTES)throw Error('MASK_DRAFT_TOO_LARGE');const proposal={kind:'stroke' as const,points:g.points,size:g.brush!.size,hardness:g.brush!.hardness,mode:g.brush!.mode},stroke=this.make(modelPayloadBytes(proposal)+16,()=>({...proposal,points:[...g.points,[p[0],p[1]] as Point]}));try{this.push(stroke.value);this.recordStroke(g,stroke.value.points,epoch,e.timeStamp,e.isTrusted);}finally{stroke.payload.release();}}
        else if(g.tool==='Move'&&g.layer&&g.transform){const input=this.make(modelPayloadBytes({type:'ApplyTransform',layerId:g.layer.id,layerVersion:g.layer.version,transform:g.transform,draft:null}),()=>{const transform=[...g.transform!] as [number,number,number,number,number,number];transform[4]+=p[0]-start[0];transform[5]+=p[1]-start[1];return {type:'ApplyTransform' as const,layerId:g.layer!.id,layerVersion:g.layer!.version,transform,draft:null};});try{if(input.value.transform[4]!==g.layer.layerToDocument[4]||input.value.transform[5]!==g.layer.layerToDocument[5])await this.editor.run('Move layer',async()=>{work.current();await this.editor.withCommandEvents(input.value,()=>undefined,g.document);});work.current();}finally{input.payload.release();}}
      }finally{this.changed();this.draw();}}).catch(error=>this.report(error)).finally(release);
    },0);this.pointerTask={timer,release};return true;
  }
  private recordStroke(g:Gesture,points:Point[],epoch:number,inputUpMs:number,trustedUp:boolean){let scratch:AllocationLease|undefined;try{const d=this.draft;if(!d)return;const bytes=this.measured(points).encodedBytes;/* Per-point JSON/UTF8 plus 32-byte hash state, 64-byte block, 256-byte schedule, numeric work array and hexadecimal digest strings. */scratch=allocationLedger.reserve({owner:'authoring-stroke-observation',kind:'copy',cpuBytes:bytes*3+768,handles:2});const hash=new SHA256(),encode=new TextEncoder();hash.update(encode.encode('['));for(let i=0;i<points.length;i++)hash.update(encode.encode((i?',':'')+JSON.stringify(points[i])));hash.update(encode.encode(']'));performance.clearMarks('ie.mask.stroke.recorded');performance.mark('ie.mask.stroke.recorded',{detail:{schemaVersion:1,gestureOrdinal:epoch,pointerId:g.id,inputDownMs:g.inputDownMs,inputUpMs,trusted:g.trustedDown&&trustedUp,documentId:d.document.id,revision:d.document.revision,draftId:d.id,targetLayerId:d.layer.id,targetLayerVersion:d.layer.version,selectedLayerId:this.editor.view.selected[0]??null,sampleCount:points.length,operationCount:d.plan.operations.length,geometrySha256:hash.digest(),brushDiameter:g.brush?.size??Number(this.size)}});}catch{/* Telemetry never changes an accepted stroke. */}finally{scratch?.release();}}
  undoStroke(){if(!this.draft?.plan.operations.length)return false;const next=this.copy(this.draft);next.value.plan.operations.pop();next.payload.resize(modelPayloadBytes(next.value));this.acceptDraft(next);return true;}
  cancelGesture(){this.gestureEpoch++;const gesture=this.gesture;this.gesture=null;this.drop('gesture');if(this.pointerTask){clearTimeout(this.pointerTask.timer);this.pointerTask.release();this.pointerTask=null;}if(gesture&&gesture.tool!=='Zoom')void this.display(null).catch(error=>this.report(error));this.draw();}
  private clearOverlayPattern(){
    const owned=this.overlayPattern;if(!owned)return;owned.usable=false;
    try{if(owned.canvas){owned.canvas.width=0;owned.canvas.height=0;}}
    catch(error){owned.lease.markUnused();throw error;}
    owned.pattern=null;owned.canvas=null;this.overlayPattern=null;owned.lease.release();
  }
  private pattern(ctx:CanvasRenderingContext2D):CanvasPattern{
    const current=this.overlayPattern;
    if(current?.usable&&current.context===ctx&&current.color===this.color)return current.pattern!;
    this.clearOverlayPattern();
    // Admit the default canvas extent before construction. The settled allowance
    // covers both the 8×8 source and a possible native pattern copy; these are
    // conservative owned bookings, not physical Canvas2D memory measurements.
    const lease=allocationLedger.reserve({owner:'authoring-overlay',kind:'canvas',cpuBytes:300*150*4+this.color.length*2,gpuBytes:300*150*4,handles:2});
    const owned:OverlayPattern={canvas:null,pattern:null,context:ctx,color:this.color,lease,usable:false};this.overlayPattern=owned;
    try{
      const canvas=document.createElement('canvas');owned.canvas=canvas;canvas.width=8;canvas.height=8;
      const tile=canvas.getContext('2d');if(!tile)throw Error('AUTHORING_PATTERN_CONTEXT');
      tile.strokeStyle=this.color;tile.beginPath();tile.moveTo(0,8);tile.lineTo(8,0);tile.stroke();
      const pattern=ctx.createPattern(canvas,'repeat');if(!pattern)throw Error('AUTHORING_PATTERN_CONTEXT');owned.pattern=pattern;
      lease.resize({cpuBytes:2*8*8*4+owned.color.length*2,gpuBytes:2*8*8*4});owned.usable=true;return pattern;
    }catch(error){try{this.clearOverlayPattern();}catch(cleanup){throw new AggregateError([error,cleanup],'AUTHORING_PATTERN_CLEANUP');}throw error;}
  }
  overlay(ctx:CanvasRenderingContext2D){
    ctx.save();try{ctx.strokeStyle=this.color;ctx.fillStyle=this.color;ctx.lineWidth=1;ctx.setLineDash([4,3]);
    const draw=(shape:Shape)=>{ctx.beginPath();if(shape.kind==='polygon'){shape.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();}else if(shape.kind==='ellipse')ctx.ellipse(shape.x+shape.width/2,shape.y+shape.height/2,shape.width/2,shape.height/2,0,0,Math.PI*2);else ctx.rect(shape.x,shape.y,shape.width,shape.height);ctx.stroke();};
    for(const op of this.selection)if(op.kind==='shape')draw(op.shape);
    const bounds=this.preview?.supportRect;if(bounds){ctx.save();try{ctx.setLineDash([1,3]);ctx.strokeStyle='#fff';ctx.strokeRect(bounds.x,bounds.y,bounds.width,bounds.height);ctx.fillStyle=this.pattern(ctx);ctx.globalAlpha=.25;ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);}finally{ctx.restore();}}
    const g=this.gesture;if(g){if(g.tool==='Mask'){ctx.setLineDash([]);ctx.globalAlpha=.45;ctx.lineWidth=Number(this.size)||1;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();g.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();}else if(g.tool!=='Zoom'&&g.points.length>1){const a=g.points[0],b=g.points.at(-1)!;draw({kind:this.shape==='ellipse'&&g.tool==='Select'?'ellipse':'rectangle',x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),width:Math.abs(a[0]-b[0]),height:Math.abs(a[1]-b[1])});}}
    }finally{ctx.restore();}
  }
  render(){if(!this.editor.view.document)return nothing;const view=this.editor.view,d=this.draft,p=this.preview,previewGeneration=p?.generation,epoch=this.workEpoch,disabled=view.busy||!view.ready||!view.document;
    const mutate=(event:Event,work:()=>void)=>{if(epoch===this.workEpoch)this.mutate(event,work);},button=(event:Event,label:string,work:()=>Promise<void>)=>{if(epoch===this.workEpoch)this.button(event,label,work);};
    return html`<en-accordion multiple .value=${['Select','Mask','Sample','Move'].includes(this.tool)?['authoring']:[]}><en-accordion-item value="authoring" label="Selection, masks and color"><en-stack gap="small">
      <p>Pointer Move previews the canonical layer result as local computation completes; release makes one history edit. Escape restores the accepted view.</p>
      <en-badge>${d?(this.stale()?'Stale mask draft':'Unapplied mask draft'):'Local authoring'}</en-badge>
      ${this.select('Selection shape','shape',['rectangle','ellipse','polygon'],v=>{this.shape=v as typeof this.shape;})}
      ${this.select('Selection combination','combine',['replace','add','subtract','intersect'],v=>{this.combine=v as Combine;})}
      <en-stack direction="horizontal" wrap gap="small">${this.field('Selection X','x')}${this.field('Selection Y','y')}${this.field('Selection width','width')}${this.field('Selection height','height')}</en-stack>
      ${this.shape==='polygon'?html`<en-textarea label="Polygon points (x,y pairs)" .value=${this.polygon} @en-input=${(e:CustomEvent<{value:string}>)=>{if(epoch===this.workEpoch&&e.composedPath()[0]===e.currentTarget)try{this.polygon=e.detail.value;}catch(error){this.adapter.write(e.currentTarget as ValueControl,'value',this.polygon);this.report(error);}}}></en-textarea>`:nothing}
      <en-toolbar label="Selection actions" keyboard-navigation="tab"><en-button ?disabled=${disabled} @click=${(e:Event)=>mutate(e,()=>this.applySelection())}>Apply selection</en-button><en-button ?disabled=${disabled||!this.selection.length} @click=${(e:Event)=>mutate(e,()=>this.useSelection())}>Use selection as mask</en-button><en-button variant="ghost" @click=${(e:Event)=>mutate(e,()=>this.clearSelection())}>Clear selection</en-button></en-toolbar>
      <p>Dashed edges show authored selection shapes. Dotted hatched bounds show prepared effective support extents; inspect Hard and Effective views for exact coverage. No request crop or safe interior is approved.</p><p>Selection uses document pixels and does not select layers or attach provider inputs. Polygon clicks add points; Apply selection closes the polygon.</p>
      ${this.select('Brush action','brush',['add','subtract'],v=>this.brush=v as typeof this.brush)}
      ${this.field('Brush diameter (document px)','size')}${this.field('Brush hardness (0–1)','hardness')}
      ${this.field('Feather radius (document px)','radius',v=>this.changeRadius(v))}
      <en-toolbar label="Mask draft actions" keyboard-navigation="tab">${(['fill','clear','invert'] as const).map(kind=>html`<en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>mutate(e,()=>this.push({kind}))}>${kind==='fill'?'Fill all':kind==='clear'?'Clear mask':'Invert mask'}</en-button>`)}<en-button variant="secondary" ?disabled=${!d?.plan.operations.length||disabled} @click=${(e:Event)=>mutate(e,()=>{this.undoStroke();})}>Undo mask stroke</en-button><en-button variant="ghost" ?disabled=${disabled} @click=${(e:Event)=>mutate(e,()=>this.startFresh())}>Start fresh mask</en-button></en-toolbar>
      ${d?.plan.schemaVersion===2?html`<en-alert announcement="none">This new draft starts from the retained mask at its saved origin: original hard coverage for authored masks, or original brightness and opacity for PNG masks. Preview and Apply will use the selected feather on the current document. Cancel preserves the attached effective mask.</en-alert>`:nothing}<en-alert announcement="none">Hard coverage is retained separately from effective feather. Radius ≤1 is identity; the finite triangle fades at document edges. White keeps a layer visible; black hides it. For a future edit mask, white means regenerate. No provider input is attached.</en-alert>
      <en-file-upload label="Import PNG mask" accept="image/png" ?disabled=${disabled} @en-change=${(e:Event)=>{if(epoch!==this.workEpoch)return;const h=e.currentTarget as HTMLElement&{files:File[]};this.adapter.settled(e,()=>h.files,files=>{if(files[0])this.run('Inspect mask PNG',()=>this.importPNG(files[0]));});}}></en-file-upload>
      ${this.pendingImport?html`<en-card><p>${this.importName} · ${this.pendingImport.asset.raster!.width} × ${this.pendingImport.asset.raster!.height}. Linear sRGB luminance × alpha; transparent pixels are zero before inversion. Place at native size; alignment outside document is explicitly clipped by the document boundary.</p>${this.field('Imported mask X','importX')}${this.field('Imported mask Y','importY')}<en-switch label="Invert imported coverage" .checked=${this.invertImport} @en-change=${(e:Event)=>{if(epoch!==this.workEpoch)return;const h=e.currentTarget as HTMLElement&{checked:boolean};this.adapter.settled(e,()=>h.checked,v=>{this.invertImport=v;});}}></en-switch><en-button ?disabled=${disabled} @click=${(e:Event)=>button(e,'Review aligned mask',()=>this.useImport())}>Review aligned mask</en-button><en-button variant="ghost" @click=${(e:Event)=>mutate(e,()=>{this.pendingImport=null;this.drop('import');})}>Cancel mask import</en-button></en-card>`:nothing}
      <en-toolbar label="Mask review actions" keyboard-navigation="tab"><en-button ?disabled=${disabled||!d||this.stale()} @click=${(e:Event)=>button(e,'Prepare local mask preview',()=>this.prepare())}>Preview mask</en-button><en-button variant="ghost" ?disabled=${!d||disabled} @click=${(e:Event)=>button(e,'Cancel mask draft',()=>this.cancel())}>Cancel mask draft</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>button(e,'Detach layer mask',()=>this.detach())}>Detach layer mask</en-button></en-toolbar>
      ${d?html`<p>Bound to ${d.layer.name}, revision ${d.document.revision}. ${d.plan.operations.length} draft operations. ${p?'Current local preview':'Preview pending; draft is not an attached mask.'}</p>`:nothing}
      ${p?html`<en-card><p>Hard support: ${p.hard} pixels. Effective support: ${p.effective} pixels · ${p.support}.</p><en-alert variant="warning" announcement="none">${p.effective===d!.plan.width*d!.plan.height?'Coverage reaches the whole document. ':p.effective===0?'Coverage is empty; an edit request would be blocked. ':''}No request crop or reconstruction halo has been approved. Request-domain review is required before any future provider use.</en-alert>${this.select('Mask preview view','previewMode',Object.keys(p.views),v=>{this.previewMode=v;})}<p>Scaled preview · original ${p.after.raster!.width} × ${p.after.raster!.height}.</p><img class="review-image" src=${displayImage(p.views[this.previewMode])} alt=${this.previewMode==='result'?'Prepared full document with layer mask':this.previewMode+' mask view'} @load=${(e:Event)=>{const current=this.preview;if(current&&current.generation===previewGeneration&&this.previewMode==='result'&&(e.currentTarget as HTMLImageElement).currentSrc===current.views.result){try{validateDisplayImage(e.currentTarget as HTMLImageElement,current.views.result);current.loaded=true;this.changed();}catch(error){current.loaded=false;this.editor.fail(error);}}}}><en-button ?disabled=${disabled||!p.loaded||this.stale()} @click=${(e:Event)=>button(e,'Apply layer mask',()=>this.apply())}>Apply layer mask</en-button></en-card>`:nothing}
      <h2>Color sample</h2>${this.select('Sample source','sampleScope',['merged','active'],v=>{this.sampleScope=v;this.sampleGeneration++;})}<p>Active includes the selected layer even when hidden; its transform, mask and opacity are included.</p>${this.field('Sample X','sampleX')}${this.field('Sample Y','sampleY')}<en-button ?disabled=${disabled} @click=${(e:Event)=>button(e,'Sample canonical color',()=>this.sample(this.number(this.sampleX,'sample X'),this.number(this.sampleY,'sample Y')))}>Sample color</en-button><en-alert announcement="polite">${this.sampleText}</en-alert><en-color-field label="Selection display color (sRGB)" .value=${this.color} @en-change=${(e:Event)=>{if(epoch===this.workEpoch)this.value(e,v=>{this.color=v;this.draw();},()=>this.color);}}></en-color-field>
    </en-stack></en-accordion-item></en-accordion>`;
  }
  releaseDocument(){
    if(this.releaseTask)return this.releaseTask;
    this.workEpoch++;this.sampleGeneration++;this.releasing=true;
    const errors:unknown[]=[];for(const abort of this.actions.keys())try{abort.abort();}catch(error){errors.push(error);}
    try{this.cancelGesture();}catch(error){errors.push(error);}
    this.draft=null;this.selectionValue=[];this.attachedPlan=null;this.attachedKey='';this.attachedReady=false;this.pendingImport=null;this.session='';this.restoring='';this.form=DEFAULT_FORM;
    for(const key of [...this.models.keys()])if(key!=='preview')this.drop(key);
    try{this.invalidate();}catch(error){errors.push(error);}try{this.adapter.invalidate();}catch(error){errors.push(error);}
    const pending=[...this.actions.values()];
    this.releaseTask=(async()=>{try{await Promise.allSettled(pending);for(const url of this.previewCleanup)try{revokeDisplayPreviewURL(url);this.previewCleanup.delete(url);}catch(error){errors.push(error);}try{await this.drainRetirements();}catch(error){errors.push(error);}for(const failure of this.cleanupFailures)try{await failure.retry();this.cleanupFailures.delete(failure);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'AUTHORING_DOCUMENT_CLEANUP');}finally{this.releasing=false;this.releaseTask=undefined;}})();return this.releaseTask;
  }
  get lifecycle(){return {drafts:this.draft?1:0,objectURLs:(this.preview?Object.keys(this.preview.views).length:0)+this.previewCleanup.size,selectionOperations:this.selection.length,gestures:this.gesture?1:0,overlayCanvases:this.overlayPattern?.canvas?1:0,overlayPatterns:this.overlayPattern?.pattern?1:0,models:this.models.size,liveModels:this.allModels.size,retiredModels:this.retired.size,renderRetirements:this.retirements.size,failedRetirements:this.failedRetirements.size,actions:this.actions.size,pendingPointer:this.pointerTask?1:0,cleanupFailures:this.cleanupFailures.size};}
  dispose(){return this.releaseDocument();}
}
