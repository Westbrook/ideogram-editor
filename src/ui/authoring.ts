import {retainedMask,r16Mask} from '../raster/mapping.js';
import type {BlobRef} from '../protocol/store.js';
import {html,nothing} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import type {Document} from '../protocol/store.js';
import type {Asset} from '../protocol/assets.js';
import type {ImageLayer} from '../protocol/history.js';
import type {MaskPlan,MaskOperation,Shape,Point,Combine} from '../raster/mask.js';
import {validateMaskPlan,validateShape,maskDraftValue,maskBindings,resolveMaskPlan} from '../raster/mask.js';
import {ControlAdapter} from './adapters.js';

type ValueControl=HTMLElement & {value:string};
type MaskDraft={document:Document;layer:ImageLayer;id:string;plan:MaskPlan};
type MaskPreview={generation:number;mask:Asset;after:Asset;url:string;views:Record<string,string>;loaded:boolean;support:string;supportRect:{x:number;y:number;width:number;height:number}|null;hard:number;effective:number};
export class Authoring {
  tool='Pan';shape:'rectangle'|'ellipse'|'polygon'='rectangle';combine:Combine='replace';brush:'add'|'subtract'='add';
  size='20';hardness='1';radius='0';color='#c778ee';selection:MaskOperation[]=[];
  polygon='';x='0';y='0';width='100';height='100';sampleX='0';sampleY='0';sampleScope='merged';sampleText='No color sampled.';
  private attachedKey='';private attachedPlan:MaskPlan|null=null;private attachedReady=false;
  private previewMode='result';
  private adapter=new ControlAdapter();private generation=0;private restoring='';private session='';
  private draft:MaskDraft|null=null;private preview:MaskPreview|null=null;private importAsset:Asset|null=null;
  private importName='';private importX='0';private importY='0';private invertImport=false;
  private gestureEpoch=0;private gesture:{id:number;points:Point[];tool:string;document:Document;layer?:ImageLayer;transform?:number[];layers:ImageLayer[]}|null=null;
  private movePending=false;
  constructor(private editor:EditorClient,private changed:()=>void,private draw:()=>void,private display:(asset:string|null)=>Promise<void>){}
  get drawing(){return !!this.gesture;}
  private readable(error:unknown){const messages:Record<string,string>={MASK_SHAPE:'Selection width and height must be positive, finite document coordinates.',MASK_POLYGON:'Enter at least three polygon points.',MASK_POINTS:'Enter finite x,y pairs for each point.',MASK_IMPORT:'Mask alignment must use whole document pixels at the imported native size.',MASK_STROKE:'Use a brush diameter above 0 and at most 8192 pixels, and hardness between 0 and 1.',MASK_DRAFT_TOO_LARGE:'This stroke exceeds the local command size. Your previous draft is retained; use shorter strokes.'};return error instanceof Error&&messages[error.message]?Error(messages[error.message]):error;}
  private run(label:string,work:()=>Promise<void>){void this.editor.run(label,async()=>{try{await work();}catch(error){throw this.readable(error);}});}
  private button(e:Event,label:string,work:()=>Promise<void>){this.adapter.action(e,()=>this.run(label,work));}
  private mutate(e:Event,work:()=>void){this.adapter.action(e,()=>{try{work();this.changed();this.draw();}catch(error){this.editor.fail(this.readable(error));}});}
  private value(e:Event,set:(v:string)=>void){const h=e.currentTarget as ValueControl;this.adapter.settled(e,()=>h.value,v=>{set(v);this.changed();});}
  private number(value:string,label:string){if(!value.trim()||!Number.isFinite(Number(value)))throw Error('Enter a finite '+label+'.');return Number(value);}
  private field(label:string,value:string,set:(v:string)=>void){return html`<en-number-field label=${label} .value=${value} @en-change=${(e:Event)=>this.value(e,set)}></en-number-field>`;}
  private select(label:string,value:string,items:string[],set:(v:string)=>void){return html`<en-segmented-control label=${label} .value=${value} .items=${items.map(value=>({value,label:value}))} @en-change=${(e:Event)=>this.value(e,set)}></en-segmented-control>`;}
  choose(tool:string){this.cancelGesture();this.tool=tool;this.changed();this.draw();}
  private current(){const document=this.editor.view.document,layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);if(!document||!layer)throw Error('Select a layer for the local mask.');if(layer.locked)throw Error('Unlock the layer before changing its mask.');return {document,layer};}
  private stale(){return !!this.draft&&(this.editor.view.document?.id!==this.draft.document.id||this.editor.view.document?.revision!==this.draft.document.revision);}
  private invalidate(){this.generation++;if(this.preview)for(const url of Object.values(this.preview.views))URL.revokeObjectURL(url);this.preview=null;}
  private save(){const d=this.draft;if(!d)return;validateMaskPlan(d.plan);this.invalidate();this.editor.changeDraft(d.id,'mask',JSON.stringify({schema:d.plan.schemaVersion===2?'local-mask-2':'local-mask-1',layerVersion:d.layer.version,radius:this.radius,plan:d.plan}),d.layer.id,false);this.changed();this.draw();}

  private begin(fresh=false){const {document,layer}=this.current();const radius=this.number(this.radius,'feather radius');if(radius<0||radius>64)throw Error('Feather radius must be between 0 and 64 document pixels.');if(!fresh&&layer.mask&&!this.attachedReady)throw Error('The attached mask is still loading. Try again when its geometry is available.');this.invalidate();this.draft={document,layer,id:this.draft?.document.id===document.id&&this.draft.layer.id===layer.id?this.draft.id:crypto.randomUUID(),plan:{...(!fresh&&this.attachedPlan?.schemaVersion===2?{schemaVersion:2 as const}:{}),width:document.width,height:document.height,feather:radius,operations:!fresh&&this.attachedPlan?structuredClone(this.attachedPlan.operations):[]}};if(!fresh&&this.attachedPlan){this.draft.plan.feather=this.attachedPlan.feather;this.radius=String(this.attachedPlan.feather);}}
  private push(op:MaskOperation){if(!this.draft)this.begin();const d=this.draft!;if(this.stale())throw Error('Mask draft is stale. Start a fresh mask to bind the current layer revision.');const plan={...d.plan,operations:[...d.plan.operations,op]};validateMaskPlan(plan);d.plan=plan;this.save();}
  private numericShape():Shape {let shape:Shape;if(this.shape==='polygon'){const values=this.polygon.trim().split(/[\s,;]+/).map(Number);if(values.length%2||values.some(n=>!Number.isFinite(n)))throw Error('Enter polygon points as x,y pairs.');shape={kind:'polygon',points:Array.from({length:values.length/2},(_,i)=>[values[i*2],values[i*2+1]])};}else shape={kind:this.shape,x:this.number(this.x,'selection X'),y:this.number(this.y,'selection Y'),width:this.number(this.width,'selection width'),height:this.number(this.height,'selection height')};validateShape(shape);return shape;}
  private selectShape(shape:Shape){validateShape(shape);const next={kind:'shape' as const,shape,mode:this.combine};this.selection=this.combine==='replace'?[next]:[...this.selection,next];if(shape.kind!=='polygon'){this.x=String(shape.x);this.y=String(shape.y);this.width=String(shape.width);this.height=String(shape.height);}this.changed();this.draw();}
  private useSelection(){if(!this.selection.length)throw Error('Create a selection first.');const {document}=this.current();validateMaskPlan({width:document.width,height:document.height,feather:this.number(this.radius,'feather radius'),operations:this.selection});this.begin(true);this.draft!.plan.operations=structuredClone(this.selection);this.save();}
  async sync(){
    if(!this.editor.view.ready)return;
    const current=this.editor.view.document,layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);
    const attachedKey=(current?.id??'')+':'+(layer?.id??'')+':'+(layer?.version??'');
    if(attachedKey!==this.attachedKey){this.attachedKey=attachedKey;this.attachedPlan=null;this.attachedReady=!layer?.mask;
      if(layer?.mask){const key=attachedKey,mask=layer.mask;void this.editor.json<{plan:{authoring?:MaskPlan;hard?:BlobRef}}>('/api/v1/assets/'+mask.assetId+'/raster').then(m=>{if(key!==this.attachedKey)return;if(retainedMask(mask)){this.attachedPlan={schemaVersion:2,width:current!.width,height:current!.height,feather:m.plan.authoring?.feather??0,operations:[{kind:'retained-hard-v1',mask:structuredClone(mask),hard:r16Mask(mask)?m.plan.hard!:null}]};validateMaskPlan(this.attachedPlan);}else if(mask.mapping==='document-r16-v1'&&m.plan.authoring){validateMaskPlan(m.plan.authoring);this.attachedPlan=structuredClone(m.plan.authoring);if(mask.inverted)this.attachedPlan.operations.push({kind:'invert'});}else this.attachedPlan={width:current!.width,height:current!.height,feather:0,operations:[{kind:'import',assetId:mask.assetId,x:0,y:0,width:current!.width,height:current!.height,inverted:mask.inverted}]};this.attachedReady=true;this.changed();}).catch(e=>this.editor.fail(e));}
    }
    const key=this.editor.sessionId+':'+(this.editor.view.document?.id??'');
    if(key===this.session)return;this.session=key;this.cancelGesture();this.invalidate();this.draft=null;this.selection=[];this.importAsset=null;this.pendingImport=null;
    if(!this.editor.view.ready||!this.editor.view.document)return;
    this.restoring=key;
    const saved=this.editor.ui?.drafts.find(d=>d.kind==='mask'&&d.documentId===this.editor.view.document!.id&&d.status==='saved-unapplied');
    if(!saved)return;
    const text=await this.editor.draftText(saved.id);if(this.restoring!==key||this.session!==key||this.draft)return;
    const value=JSON.parse(text);maskDraftValue(value);value.plan=resolveMaskPlan(value.plan,saved.maskBindings!);
    const restoredLayer=this.editor.view.image?.layers.find(l=>l.id===saved.targetLayerId);if(!restoredLayer)return;
    this.draft={document:{...this.editor.view.document!,revision:saved.expectedDocumentRevision},layer:{...restoredLayer,version:value.layerVersion},id:saved.id,plan:value.plan};this.radius=value.radius;this.changed();
  }
  private async prepare(){
    const d=this.draft;if(!d)throw Error('Create a mask draft first.');if(this.stale())throw Error('Mask draft is stale. Start a fresh mask for the current revision.');
    const radius=this.number(this.radius,'feather radius');if(radius<0||radius>64)throw Error('Feather radius must be between 0 and 64 document pixels.');const candidate={...d.plan,feather:radius};validateMaskPlan(candidate);if(radius!==d.plan.feather){d.plan=candidate;this.save();}
    validateMaskPlan(d.plan);const generation=this.generation,plan=structuredClone(d.plan);
    await this.editor.flushDrafts();
    const result=await this.editor.command({type:'PrepareMask',plan},null);
    const mask=result.find(e=>e.type==='AssetRegistered');if(!mask||mask.type!=='AssetRegistered')throw Error('Mask preview is unavailable.');
    if(this.draft!==d||generation!==this.generation||this.stale())throw Error('Mask preview became stale; the draft is retained.');
    const layers=this.editor.view.image!.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.id===d.layer.id?{assetId:mask.payload.asset.id,mapping:'document-r16-v1' as const,inverted:false}:l.mask}));
    const events=await this.editor.command({type:'ComposeRaster',width:plan.width,height:plan.height,layers},null),after=events.find(e=>e.type==='AssetRegistered');if(!after||after.type!=='AssetRegistered')throw Error('Mask result preview is unavailable.');
    const manifest=await this.editor.json<{plan:{statistics:{support:{x:number;y:number;width:number;height:number}|null;hardPixels:number;effectivePixels:number}}}>('/api/v1/assets/'+mask.payload.asset.id+'/raster');
    const response=await this.editor.session.transport('/api/v1/assets/'+after.payload.asset.id+'/content');if(!response.ok)throw Error('Mask result pixels are unavailable.');const blob=await response.blob();
    if(this.draft!==d||generation!==this.generation||this.stale())throw Error('Mask preview became stale; the draft is retained.');
    const hardEvents=await this.editor.command({type:'PrepareMask',plan:{...plan,feather:0}},null),hard=hardEvents.find(e=>e.type==='AssetRegistered');if(hard?.type!=='AssetRegistered')throw Error('Hard mask preview is unavailable.');
    const urls:Record<string,string>={result:URL.createObjectURL(blob)};
    try{for(const [key,id] of [['hard',hard.payload.asset.id],['effective',mask.payload.asset.id],['original',d.document.image?.compositeAssetId]] as const){if(!id)continue;const response=await this.editor.session.transport('/api/v1/assets/'+id+'/content');if(!response.ok)throw Error('Mask preview is unavailable.');urls[key]=URL.createObjectURL(await response.blob());}
    if(this.draft!==d||generation!==this.generation||this.stale())throw Error('Mask preview became stale; the draft is retained.');}catch(error){for(const url of Object.values(urls))URL.revokeObjectURL(url);throw error;}
    this.previewMode='result';const stats=manifest.plan.statistics,s=stats.support;
    this.preview={mask:mask.payload.asset,after:after.payload.asset,generation,url:urls.result,views:urls,loaded:false,support:s?`X ${s.x}, Y ${s.y}, width ${s.width}, height ${s.height}`:'empty',supportRect:s,hard:stats.hardPixels,effective:stats.effectivePixels};this.changed();this.draw();
  }
  private async apply(){
    const d=this.draft,p=this.preview;if(!d||!p||!p.loaded||p.generation!==this.generation||this.stale())throw Error('Prepare and inspect a current mask preview before Apply.');
    await this.editor.flushDrafts();if(this.draft!==d||this.preview!==p||this.stale())throw Error('Mask draft changed.');
    const saved=this.editor.draftOwner?.drafts.get(d.id);if(!saved||saved.savedGeneration!==saved.generation)throw Error('Save the current mask draft before Apply.');
    await this.editor.command({type:'SetLayerProperties',layerId:d.layer.id,layerVersion:d.layer.version,properties:{mask:{assetId:p.mask.id,mapping:'document-r16-v1',inverted:false}},draft:{sessionId:this.editor.sessionId,draftId:d.id,generation:saved.generation}},d.document);
    this.invalidate();this.draft=null;this.changed();this.draw();
  }
  private async cancel(){const d=this.draft;if(d){await this.editor.flushDrafts();await this.editor.clearDraft(d.id);}this.invalidate();this.draft=null;this.editor.patch({message:'Mask draft canceled. Accepted layer unchanged.'});this.changed();this.draw();}
  private async importPNG(file:File){
    if(file.type!=='image/png')throw Error('Choose a static PNG mask.');
    const before=this.editor.view.document?.id;this.invalidate();await this.editor.importImage(file);
    const r=this.editor.view.review;if(r?.kind!=='image')throw Error('Mask conversion preview is unavailable.');
    this.editor.patch({review:null});
    // Conversion remains explicit: keep the standard image review authority,
    // then approve only when the user chooses the labelled mask conversion.
    this.pendingImport=r;this.importName=file.name;
    if(before!==this.editor.view.document?.id)throw Error('Document changed; choose the mask again.');this.changed();
  }
  private pendingImport:Extract<import('../state/editor-client.js').Review,{kind:'image'}>|null=null;
  private async useImport(){
    const r=this.pendingImport;if(!r)throw Error('Choose a PNG mask first.');
    if(r.target?.id!==this.editor.view.document?.id||r.target?.revision!==this.editor.view.document?.revision)throw Error('Mask import is stale; choose the PNG again.');
    const {document}=this.current(),op:Extract<MaskOperation,{kind:'import'}>={kind:'import',assetId:r.asset.id,x:this.number(this.importX,'mask X'),y:this.number(this.importY,'mask Y'),width:r.asset.raster!.width,height:r.asset.raster!.height,inverted:this.invertImport};
    validateMaskPlan({width:document.width,height:document.height,feather:this.number(this.radius,'feather radius'),operations:[op]});
    const events=await this.editor.command({type:'ApproveRaster',assetId:r.asset.id,reviewId:r.review.reviewId,reviewHash:r.review.reviewHash},null);
    const a=events.find(e=>e.type==='AssetRegistered');if(!a||a.type!=='AssetRegistered')throw Error('Mask conversion was not approved.');this.importAsset=a.payload.asset;op.assetId=a.payload.asset.id;
    this.begin(true);this.push(op);this.pendingImport=null;
    await this.prepare();
  }
  async sample(x:number,y:number){
    const document=this.editor.view.document;if(!document)throw Error('Open a document to sample.');
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<0||y<0||x>=document.width||y>=document.height)throw Error('Sample coordinates must be integer pixels inside the document.');
    const generation=++this.sampleGeneration,selected=this.editor.view.selected[0],scope=this.sampleScope;let assetId=document.image?.compositeAssetId;
    if(this.sampleScope==='active'){
      const l=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);if(!l)throw Error('Select an active layer to sample.');
      const events=await this.editor.command({type:'ComposeRaster',width:document.width,height:document.height,layers:[{assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}]},null),a=events.find(e=>e.type==='AssetRegistered');if(a?.type!=='AssetRegistered')throw Error('Sample is unavailable.');assetId=a.payload.asset.id;
    }
    if(!assetId)throw Error('There is no retained raster to sample.');
    const result=await this.editor.json<{rgba:number[]}>('/api/v1/assets/'+assetId+'/sample?x='+x+'&y='+y);
    if(generation!==this.sampleGeneration||scope!==this.sampleScope||scope==='active'&&selected!==this.editor.view.selected[0]||this.editor.view.document?.revision!==document.revision||this.editor.view.document?.id!==document.id)return;
    this.sampleX=String(x);this.sampleY=String(y);this.sampleText=`X ${x}, Y ${y} · sRGB RGBA (${result.rgba.join(', ')}) · alpha ${result.rgba[3]}/255`;this.color='#'+result.rgba.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');this.changed();this.draw();
  }
  private sampleGeneration=0;
  pointerDown(e:PointerEvent,p:Point){
    if(!['Select','Mask','Move','Sample'].includes(this.tool)||e.button!==0||this.editor.view.busy||!this.editor.view.document)return false;
    if(this.tool==='Sample'){this.run('Sample canonical color',()=>this.sample(Math.floor(p[0]),Math.floor(p[1])));return true;}
    const layer=this.editor.view.image?.layers.find(l=>l.id===this.editor.view.selected[0]);
    if(this.tool==='Move'&&(!layer||layer.locked))return true;
    if(this.tool==='Select'&&this.shape==='polygon'){this.polygon+=(this.polygon?'\n':'')+p.map(n=>Math.round(n*100)/100).join(', ');this.changed();return true;}
    this.gestureEpoch++;this.gesture={id:e.pointerId,points:[p],tool:this.tool,document:this.editor.view.document,layer,transform:layer?[...layer.layerToDocument]:undefined,layers:structuredClone(this.editor.view.image?.layers??[])};(e.target as HTMLElement).setPointerCapture(e.pointerId);return true;
  }
  pointerMove(e:PointerEvent,p:Point){const g=this.gesture;if(!g||g.id!==e.pointerId)return false;if(g.tool==='Mask')g.points.push(p);else g.points=[g.points[0],p];this.draw();if(g.tool==='Move')setTimeout(()=>{if(!e.defaultPrevented&&this.gesture===g)void this.previewMove(g).catch(error=>this.editor.fail(error));},0);return true;}
  private async previewMove(g:NonNullable<Authoring['gesture']>){
    if(this.movePending||!g.layer||!g.transform||this.gesture!==g)return;
    this.movePending=true;const point=g.points.at(-1)!,epoch=this.gestureEpoch;
    try{const transform=[...g.transform] as [number,number,number,number,number,number];transform[4]+=point[0]-g.points[0][0];transform[5]+=point[1]-g.points[0][1];
      const events=await this.editor.command({type:'ComposeRaster',width:g.document.width,height:g.document.height,layers:g.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.id===g.layer!.id?transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))},null),asset=events.find(e=>e.type==='AssetRegistered');
      if(this.gesture===g&&epoch===this.gestureEpoch&&g.document.revision===this.editor.view.document?.revision&&g.document.id===this.editor.view.document?.id&&point===g.points.at(-1)&&asset?.type==='AssetRegistered')await this.display(asset.payload.asset.id);
    }finally{this.movePending=false;if(this.gesture===g&&point!==g.points.at(-1))void this.previewMove(g).catch(error=>this.editor.fail(error));}
  }
  pointerUp(e:PointerEvent,p:Point){const g=this.gesture;if(!g||g.id!==e.pointerId)return false;this.gesture=null;void this.display(null).catch(error=>this.editor.fail(error));const epoch=this.gestureEpoch;
    setTimeout(()=>{if(e.defaultPrevented||epoch!==this.gestureEpoch)return;
    if(g.document.id!==this.editor.view.document?.id||g.document.revision!==this.editor.view.document?.revision){this.editor.fail(Error('Gesture became stale; no change applied.'));this.draw();return;}
    try{
      const start=g.points[0];
      if(g.tool==='Select')this.selectShape({kind:this.shape==='ellipse'?'ellipse':'rectangle',x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),width:Math.abs(p[0]-start[0]),height:Math.abs(p[1]-start[1])});
      else if(g.tool==='Mask')this.push({kind:'stroke',points:[...g.points,p],size:this.number(this.size,'brush size'),hardness:this.number(this.hardness,'brush hardness'),mode:this.brush});
      else if(g.tool==='Move'&&g.layer&&g.transform){const t=g.transform as [number,number,number,number,number,number];t[4]+=p[0]-start[0];t[5]+=p[1]-start[1];if(t[4]!==g.layer.layerToDocument[4]||t[5]!==g.layer.layerToDocument[5])this.run('Move layer',async()=>{await this.editor.command({type:'ApplyTransform',layerId:g.layer!.id,layerVersion:g.layer!.version,transform:t,draft:null},g.document);});}
    }catch(error){this.editor.fail(this.readable(error));}this.changed();this.draw();},0);return true;
  }
  undoStroke(){if(!this.draft?.plan.operations.length)return false;this.draft.plan.operations=this.draft.plan.operations.slice(0,-1);this.save();return true;}
  cancelGesture(){this.gestureEpoch++;const gesture=this.gesture;this.gesture=null;
    // With no gesture, the shell already owns the current document paint.
    if(gesture)void this.display(null).catch(error=>this.editor.fail(error));this.draw();}
  overlay(ctx:CanvasRenderingContext2D){
    ctx.save();ctx.strokeStyle=this.color;ctx.fillStyle=this.color;ctx.lineWidth=1;ctx.setLineDash([4,3]);
    const draw=(shape:Shape)=>{ctx.beginPath();if(shape.kind==='polygon'){shape.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();}else if(shape.kind==='ellipse')ctx.ellipse(shape.x+shape.width/2,shape.y+shape.height/2,shape.width/2,shape.height/2,0,0,Math.PI*2);else ctx.rect(shape.x,shape.y,shape.width,shape.height);ctx.stroke();};
    for(const op of this.selection)if(op.kind==='shape')draw(op.shape);
    const bounds=this.preview?.supportRect;if(bounds){ctx.save();ctx.setLineDash([1,3]);ctx.strokeStyle='#fff';ctx.strokeRect(bounds.x,bounds.y,bounds.width,bounds.height);const pattern=document.createElement('canvas');pattern.width=8;pattern.height=8;const tile=pattern.getContext('2d')!;tile.strokeStyle=this.color;tile.beginPath();tile.moveTo(0,8);tile.lineTo(8,0);tile.stroke();ctx.fillStyle=ctx.createPattern(pattern,'repeat')!;ctx.globalAlpha=.25;ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);ctx.restore();}
    const g=this.gesture;if(g){if(g.tool==='Mask'){ctx.setLineDash([]);ctx.globalAlpha=.45;ctx.lineWidth=Number(this.size)||1;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();g.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();}else if(g.points.length>1){const a=g.points[0],b=g.points.at(-1)!;draw({kind:this.shape==='ellipse'&&g.tool==='Select'?'ellipse':'rectangle',x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),width:Math.abs(a[0]-b[0]),height:Math.abs(a[1]-b[1])});}}
    ctx.restore();
  }
  render(){if(!this.editor.view.document)return nothing;const view=this.editor.view,d=this.draft,p=this.preview,disabled=view.busy||!view.ready||!view.document;
    return html`<en-accordion multiple .value=${['Select','Mask','Sample','Move'].includes(this.tool)?['authoring']:[]}><en-accordion-item value="authoring" label="Selection, masks and color"><en-stack gap="small">
      <p>Pointer Move previews the canonical layer result as local computation completes; release makes one history edit. Escape restores the accepted view.</p>
      <en-badge>${d?(this.stale()?'Stale mask draft':'Unapplied mask draft'):'Local authoring'}</en-badge>
      ${this.select('Selection shape',this.shape,['rectangle','ellipse','polygon'],v=>{this.shape=v as typeof this.shape;})}
      ${this.select('Selection combination',this.combine,['replace','add','subtract','intersect'],v=>{this.combine=v as Combine;})}
      <en-stack direction="horizontal" wrap gap="small">${this.field('Selection X',this.x,v=>this.x=v)}${this.field('Selection Y',this.y,v=>this.y=v)}${this.field('Selection width',this.width,v=>this.width=v)}${this.field('Selection height',this.height,v=>this.height=v)}</en-stack>
      ${this.shape==='polygon'?html`<en-textarea label="Polygon points (x,y pairs)" .value=${this.polygon} @en-input=${(e:CustomEvent<{value:string}>)=>{if(e.composedPath()[0]===e.currentTarget)this.polygon=e.detail.value;}}></en-textarea>`:nothing}
      <en-toolbar label="Selection actions" keyboard-navigation="tab"><en-button ?disabled=${disabled} @click=${(e:Event)=>this.mutate(e,()=>this.selectShape(this.numericShape()))}>Apply selection</en-button><en-button ?disabled=${disabled||!this.selection.length} @click=${(e:Event)=>this.mutate(e,()=>this.useSelection())}>Use selection as mask</en-button><en-button variant="ghost" @click=${(e:Event)=>this.mutate(e,()=>{this.selection=[];this.polygon='';})}>Clear selection</en-button></en-toolbar>
      <p>Dashed edges show authored selection shapes. Dotted hatched bounds show prepared effective support extents; inspect Hard and Effective views for exact coverage. No request crop or safe interior is approved.</p><p>Selection uses document pixels and does not select layers or attach provider inputs. Polygon clicks add points; Apply selection closes the polygon.</p>
      ${this.select('Brush action',this.brush,['add','subtract'],v=>this.brush=v as typeof this.brush)}
      ${this.field('Brush diameter (document px)',this.size,v=>this.size=v)}${this.field('Brush hardness (0–1)',this.hardness,v=>this.hardness=v)}
      ${this.field('Feather radius (document px)',this.radius,v=>{this.radius=v;if(d)this.save();})}
      <en-toolbar label="Mask draft actions" keyboard-navigation="tab">${(['fill','clear','invert'] as const).map(kind=>html`<en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.mutate(e,()=>this.push({kind}))}>${kind==='fill'?'Fill all':kind==='clear'?'Clear mask':'Invert mask'}</en-button>`)}<en-button variant="secondary" ?disabled=${!d?.plan.operations.length||disabled} @click=${(e:Event)=>this.mutate(e,()=>{this.undoStroke();})}>Undo mask stroke</en-button><en-button variant="ghost" ?disabled=${disabled} @click=${(e:Event)=>this.mutate(e,()=>{this.begin(true);this.save();})}>Start fresh mask</en-button></en-toolbar>
      ${d?.plan.schemaVersion===2?html`<en-alert announcement="none">This new draft starts from the retained mask at its saved origin: original hard coverage for authored masks, or original brightness and opacity for PNG masks. Preview and Apply will use the selected feather on the current document. Cancel preserves the attached effective mask.</en-alert>`:nothing}<en-alert announcement="none">Hard coverage is retained separately from effective feather. Radius ≤1 is identity; the finite triangle fades at document edges. White keeps a layer visible; black hides it. For a future edit mask, white means regenerate. No provider input is attached.</en-alert>
      <en-file-upload label="Import PNG mask" accept="image/png" ?disabled=${disabled} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLElement&{files:File[]};this.adapter.settled(e,()=>h.files,files=>{if(files[0])this.run('Inspect mask PNG',()=>this.importPNG(files[0]));});}}></en-file-upload>
      ${this.pendingImport?html`<en-card><p>${this.importName} · ${this.pendingImport.asset.raster!.width} × ${this.pendingImport.asset.raster!.height}. Linear sRGB luminance × alpha; transparent pixels are zero before inversion. Place at native size; alignment outside document is explicitly clipped by the document boundary.</p>${this.field('Imported mask X',this.importX,v=>this.importX=v)}${this.field('Imported mask Y',this.importY,v=>this.importY=v)}<en-switch label="Invert imported coverage" .checked=${this.invertImport} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLElement&{checked:boolean};this.adapter.settled(e,()=>h.checked,v=>{this.invertImport=v;});}}></en-switch><en-button ?disabled=${disabled} @click=${(e:Event)=>this.button(e,'Review aligned mask',()=>this.useImport())}>Review aligned mask</en-button><en-button variant="ghost" @click=${(e:Event)=>this.mutate(e,()=>{this.pendingImport=null;})}>Cancel mask import</en-button></en-card>`:nothing}
      <en-toolbar label="Mask review actions" keyboard-navigation="tab"><en-button ?disabled=${disabled||!d||this.stale()} @click=${(e:Event)=>this.button(e,'Prepare local mask preview',()=>this.prepare())}>Preview mask</en-button><en-button variant="ghost" ?disabled=${!d||disabled} @click=${(e:Event)=>this.button(e,'Cancel mask draft',()=>this.cancel())}>Cancel mask draft</en-button><en-button variant="secondary" ?disabled=${disabled} @click=${(e:Event)=>this.button(e,'Detach layer mask',async()=>{const {document,layer}=this.current();await this.editor.command({type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:null},draft:null},document);})}>Detach layer mask</en-button></en-toolbar>
      ${d?html`<p>Bound to ${d.layer.name}, revision ${d.document.revision}. ${d.plan.operations.length} draft operations. ${p?'Current local preview':'Preview pending; draft is not an attached mask.'}</p>`:nothing}
      ${p?html`<en-card><p>Hard support: ${p.hard} pixels. Effective support: ${p.effective} pixels · ${p.support}.</p><en-alert variant="warning" announcement="none">${p.effective===d!.plan.width*d!.plan.height?'Coverage reaches the whole document. ':p.effective===0?'Coverage is empty; an edit request would be blocked. ':''}No request crop or reconstruction halo has been approved. Request-domain review is required before any future provider use.</en-alert>${this.select('Mask preview view',this.previewMode,Object.keys(p.views),v=>{this.previewMode=v;})}<img class="review-image" src=${p.views[this.previewMode]} alt=${this.previewMode==='result'?'Prepared full document with layer mask':this.previewMode+' mask view'} @load=${(e:Event)=>{if(this.preview===p&&this.previewMode==='result'&&(e.currentTarget as HTMLImageElement).currentSrc===p.views.result){p.loaded=true;this.changed();}}}><en-button ?disabled=${disabled||!p.loaded||this.stale()} @click=${(e:Event)=>this.button(e,'Apply layer mask',()=>this.apply())}>Apply layer mask</en-button></en-card>`:nothing}
      <h2>Color sample</h2>${this.select('Sample source',this.sampleScope,['merged','active'],v=>{this.sampleScope=v;this.sampleGeneration++;})}<p>Active includes the selected layer even when hidden; its transform, mask and opacity are included.</p>${this.field('Sample X',this.sampleX,v=>this.sampleX=v)}${this.field('Sample Y',this.sampleY,v=>this.sampleY=v)}<en-button ?disabled=${disabled} @click=${(e:Event)=>this.button(e,'Sample canonical color',()=>this.sample(this.number(this.sampleX,'sample X'),this.number(this.sampleY,'sample Y')))}>Sample color</en-button><en-alert announcement="polite">${this.sampleText}</en-alert><en-color-field label="Selection display color (sRGB)" .value=${this.color} @en-change=${(e:Event)=>this.value(e,v=>{this.color=v;this.draw();})}></en-color-field>
    </en-stack></en-accordion-item></en-accordion>`;
  }
  dispose(){this.gestureEpoch++;this.invalidate();this.adapter.invalidate();}
}
