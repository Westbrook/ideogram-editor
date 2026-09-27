import { CompositionEditing } from './composition.js';
import { NativeTextEditing } from './native-text.js';
import { Authoring } from './authoring.js';
import { iconDefinition } from '@en-reve/elements/definitions/icon.js';
import { linkDefinition } from '@en-reve/elements/definitions/link.js';
import { colorFieldDefinition } from '@en-reve/elements/definitions/color-field.js';
import { segmentedControlDefinition } from '@en-reve/elements/definitions/segmented-control.js';
import { accordionItemDefinition } from '@en-reve/elements/definitions/accordion-item.js';
import { accordionDefinition } from '@en-reve/elements/definitions/accordion.js';
import { alertDefinition } from '@en-reve/elements/definitions/alert.js';
import { badgeDefinition } from '@en-reve/elements/definitions/badge.js';
import { cardDefinition } from '@en-reve/elements/definitions/card.js';
import { stackDefinition } from '@en-reve/elements/definitions/stack.js';
import { LitElement, html, nothing, render as renderInto } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { createElementScope } from '@en-reve/elements/element-scope.js';
import { buttonDefinition } from '@en-reve/elements/definitions/button.js';
import { textareaDefinition } from '@en-reve/elements/definitions/textarea.js';
import { textFieldDefinition } from '@en-reve/elements/definitions/text-field.js';
import { numberFieldDefinition } from '@en-reve/elements/definitions/number-field.js';
import { selectDefinition } from '@en-reve/elements/definitions/select.js';
import { selectOptionDefinition } from '@en-reve/elements/definitions/select-option.js';
import { splitterDefinition } from '@en-reve/elements/definitions/splitter.js';
import { toolbarDefinition } from '@en-reve/elements/definitions/toolbar.js';
import { tabsDefinition } from '@en-reve/elements/definitions/tabs.js';
import { tabDefinition } from '@en-reve/elements/definitions/tab.js';
import { tabPanelDefinition } from '@en-reve/elements/definitions/tab-panel.js';
import { fileUploadDefinition } from '@en-reve/elements/definitions/file-upload.js';
import { treeDefinition } from '@en-reve/elements/definitions/tree.js';
import { activityFeedDefinition } from '@en-reve/elements/definitions/activity-feed.js';
import { switchDefinition } from '@en-reve/elements/definitions/switch.js';
import { sliderDefinition } from '@en-reve/elements/definitions/slider.js';
import { validationSummaryDefinition } from '@en-reve/elements/definitions/validation-summary.js';
import { popoverDefinition } from '@en-reve/elements/definitions/popover.js';
import { SignalController } from '@en-reve/primitives/interactions/signal-controller.js';
import type { EnTextarea } from '@en-reve/elements/textarea.js';
import type { EnFileUpload } from '@en-reve/elements/file-upload.js';
import type { EnTree } from '@en-reve/elements/tree.js';
import type { EnSelect } from '@en-reve/elements/select.js';
import type { EnNumberField } from '@en-reve/elements/number-field.js';
import type { EnSwitch } from '@en-reve/elements/switch.js';
import type { EnSlider } from '@en-reve/elements/slider.js';
import type { EnSplitter } from '@en-reve/elements/splitter.js';
import type { EnDialog } from '@en-reve/elements/dialog.js';
import type { DraftInputEvent } from '@en-reve/elements/events.js';
import type { ActivityRecord } from '@en-reve/elements/activity-feed.js';
import type { ImageLayer, ImageHistoryNode } from '../protocol/history.js';
import type { Command, Document } from '../protocol/store.js';
import { createSessionClient } from '../state/session-client.js';
import { EditorClient } from '../state/editor-client.js';
import { chooseDestination, writeDestination } from '../state/destination.js';
import { ControlAdapter } from './adapters.js';
import { CanvasView } from './canvas-view.js';
import { icon } from './icons.js';
import { SHA256 } from '../protocol/sha256.js';

const scope=createElementScope({document,registry:'auto'});
scope.register([iconDefinition,linkDefinition,colorFieldDefinition,segmentedControlDefinition,accordionItemDefinition,accordionDefinition,alertDefinition,badgeDefinition,cardDefinition,stackDefinition,buttonDefinition,textareaDefinition,textFieldDefinition,numberFieldDefinition,selectDefinition,selectOptionDefinition,splitterDefinition,toolbarDefinition,tabsDefinition,tabDefinition,tabPanelDefinition,fileUploadDefinition,treeDefinition,activityFeedDefinition,switchDefinition,sliderDefinition,validationSummaryDefinition,popoverDefinition]);
const operations=['Generate image','Generate with Instant','Generate with Fast','Transform image','Edit masked region','Generate with adapters','Transform with adapters','Edit with adapters'];
const connection=createSessionClient();
const editor=new EditorClient(connection);
const statusName={checking:'Connecting',paired:'Connected locally',unpaired:'Pairing needed',offline:'Server offline',error:'Connection error'};
type Fields={appearance:string;name:string;opacity:string;visible:boolean;locked:boolean;a:string;b:string;c:string;d:string;x:string;y:string};
class EditorShell extends LitElement {
  private readonly read=new SignalController(this,()=>({view:editor.state.value.get(),session:connection.state.value.get()}));
  private adapter=new ControlAdapter();
  private lifecycle?:AbortController;
  private canvas?:CanvasView;
  private resize?:ResizeObserver;
  private connectedOwner:string|null=null;
  private sessionBusy=true;
  private composition=false;
  private operation=operations[0];
  private prompts:Record<string,string>={};
  private promptIds:Record<string,string>={};
  private tool='Pan';
  private authoring=new Authoring(editor,()=>this.requestUpdate(),()=>this.draw(),asset=>this.displayPreview(asset));
  private textEditing=new NativeTextEditing(this,editor,()=>this.draw(),p=>this.canvas?.screenPoint(p,this.zoom,this.pan.x,this.pan.y)??[0,0]);
  private structure='layers';
  private semantic=new CompositionEditing(this,editor,()=>{this.structure='composition';this.requestUpdate();},()=>this.draw(),()=>this.panels(),id=>{this.structure='layers';editor.select([id]);this.requestUpdate();});
  private zoom=1;
  private pan={x:0,y:0};
  private gesture:{id:number;x:number;y:number;oldX:number;oldY:number}|null=null;
  private panelReady=false;
  private panelLoading?:Promise<void>;
  private panel:'new'|'open'|'import'|'resample'|'flatten'|'bounds'|'copy'|null=null;
  private inspectorKey='';
  private restoredUI='';
  private promptGeneration=0;
  private previewLoaded=false;
  private fields?:{layer:ImageLayer;document:Document;values:Fields;dirty:boolean;draftId:string};
  private previewURL='';
  private previewAsset='';
  private renderGeneration=0;
  private repaintKey='';
  private narrow=matchMedia('(max-width:1100px)').matches;
  private extreme=matchMedia('(max-width:720px)').matches;
  private requestNode=document.createElement('section');
  private inspectorNode=document.createElement('aside');
  private get drawerMode(){return this.narrow&&!this.extreme&&this.panelReady;}
  private requestOpen=false;
  private inspectorOpen=false;
  constructor(){super();this.renderOptions.creationScope=scope.creationScope;}
  protected createRenderRoot(){return this;}
  connectedCallback(){
    super.connectedCallback();this.lifecycle=new AbortController();const signal=this.lifecycle.signal;
    window.addEventListener('ie-pairing',()=>{let token=window.__IE_PAIRING__;delete window.__IE_PAIRING__;void connection.start(token);token=undefined;},{signal});
    this.addEventListener('keydown',this.shortcut,{signal});
    this.addEventListener('compositionstart',()=>{this.composition=true;this.requestUpdate();},{signal});
    this.addEventListener('compositionend',()=>{this.composition=false;setTimeout(()=>void this.updateLayout(),0);this.requestUpdate();void editor.flushDrafts().catch(e=>editor.fail(e));},{signal});
    for(const query of ['(max-width:1100px)','(max-width:720px)'])matchMedia(query).addEventListener('change',()=>void this.updateLayout(),{signal});
    if(this.narrow&&!this.extreme)void this.updateLayout();
  }
  disconnectedCallback(){super.disconnectedCallback();this.adapter.invalidate();this.lifecycle?.abort();this.resize?.disconnect();this.canvas?.dispose();this.authoring.dispose();this.semantic.dispose();this.textEditing.dispose();if(this.previewURL)URL.revokeObjectURL(this.previewURL);editor.dispose();connection.dispose();}
  protected firstUpdated(){
    const canvas=this.querySelector<HTMLCanvasElement>('canvas')!;this.canvas=new CanvasView(canvas,connection.transport);
    this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
  }
  protected updated(){
    const {view,session}=this.read.snapshot;
    void this.textEditing.sync().catch(e=>editor.fail(e));
    void this.authoring.sync().catch(e=>editor.fail(e));
    void this.semantic.sync().catch(e=>editor.fail(e));
    performance.clearMarks('ie.editor.updated');performance.mark('ie.editor.updated',{detail:{busy:view.busy,ready:view.ready,documentId:view.document?.id??null,revision:view.document?.revision??null,selected:view.selected}});
    if(!session.busy&&(this.sessionBusy||this.connectedOwner!==connection.identity())){
      this.connectedOwner=connection.identity();if(session.connection==='paired')void editor.connect().catch(e=>editor.fail(e));else editor.disconnect();
    }
    this.sessionBusy=session.busy;
    const uiKey=editor.sessionId+':'+(view.document?.id??'');
    if(view.ready&&uiKey!==this.restoredUI){this.restoredUI=uiKey;void this.restoreUI(uiKey).catch(e=>editor.fail(e));}
    const tree=this.querySelector<EnTree>('#layer-tree');if(tree&&JSON.stringify(tree.selectedKeys)!==JSON.stringify(view.selected))this.adapter.write(tree,'selectedKeys',[...view.selected]);
    const selected=view.image?.layers.find(l=>l.id===view.selected[0]);
    const key=(view.document?.id??'')+':'+(selected?.id??'');
    if(key===this.inspectorKey&&selected&&view.document&&this.fields&&!this.fields.dirty&&this.fields.document.revision!==view.document.revision){this.fields=this.newFields(selected,view.document);this.requestUpdate();void this.updateComplete.then(()=>this.writeFields());}
    if(key!==this.inspectorKey){this.inspectorKey=key;this.adapter.invalidate();this.fields=selected&&view.document?this.newFields(selected,view.document):undefined;this.requestUpdate();void this.updateComplete.then(async()=>{this.writeFields();await this.restoreInspector(key);});}
    const paintKey=(view.document?.image?.compositeAssetId??'')+':'+view.document?.width+':'+view.document?.height;
    if(paintKey!==this.repaintKey){this.repaintKey=paintKey;void this.paint().catch(e=>editor.fail(e));}
    const review=view.review;
    const asset=review?.kind==='image'?review.asset.id:review?.kind==='edit'?review.review.preview.after.compositeAssetId:null;
    if(asset&&asset!==this.previewAsset){this.previewLoaded=false;this.previewURL='';this.previewAsset=asset;void this.reviewImage(asset);}
    if(!review&&this.previewURL){URL.revokeObjectURL(this.previewURL);this.previewURL='';this.previewAsset='';}
  }
  private async restoreUI(key:string){
    const ui=editor.ui;if(!ui)return;const generation=this.promptGeneration;
    this.zoom=ui.preferences.viewport.zoom;
    for(const [id,pixels] of [['left-divider',ui.preferences.panels.left],['right-divider',ui.preferences.panels.right]] as const){const h=this.querySelector<EnSplitter>('#'+id);if(h&&!this.narrow){const width=h.parentElement!.getBoundingClientRect().width-1;const value=Math.max(h.min,Math.min(h.max,(id==='left-divider'?pixels:width-pixels)/width*100));this.adapter.write(h,'value',value);h.parentElement!.style.setProperty('--pane-ratio',String(value/100));}}
    this.pan={x:ui.preferences.viewport.x,y:ui.preferences.viewport.y};this.draw();
    for(const draft of ui.drafts){
      if(draft.kind!=='prompt'||draft.documentId!==editor.view.document?.id||draft.status==='applied')continue;
      const text=await editor.draftText(draft.id);if(key!==this.restoredUI||generation!==this.promptGeneration)return;
      let operation=operations[0],value=text;
      try{const stored=JSON.parse(text);if(stored.schema==='editor-prompt-1'&&operations.includes(stored.operation)&&typeof stored.text==='string'){operation=stored.operation;value=stored.text;}}catch{/* Earlier plain captions remain readable. */}
      this.prompts[editor.view.document!.id+':'+operation]=value;this.promptIds[editor.view.document!.id+':'+operation]=draft.id;
    }
    if(key!==this.restoredUI||generation!==this.promptGeneration)return;
    const host=this.querySelector<EnTextarea>('#prompt');if(host)this.adapter.write(host,'value',this.prompts[editor.view.document?.id+':'+this.operation]??'');
    const panX=this.querySelector<EnNumberField>('#pan-x'),panY=this.querySelector<EnNumberField>('#pan-y');if(panX)this.adapter.write(panX,'value',String(this.pan.x));if(panY)this.adapter.write(panY,'value',String(this.pan.y));
    this.requestUpdate();
  }
  private async restoreInspector(key:string){
    const f=this.fields;if(!f)return;
    const draft=editor.ui?.drafts.find(d=>d.kind==='inspector'&&d.documentId===f.document.id&&d.targetLayerId===f.layer.id&&d.status==='saved-unapplied');
    if(!draft)return;
    const text=await editor.draftText(draft.id);if(key!==this.inspectorKey||this.fields!==f||f.dirty)return;
    let values:Fields;try{values=JSON.parse(text);}catch{throw Error('Inspector draft retained, but its format is unavailable.');}
    if(values.appearance===undefined)values.appearance=f.values.appearance;
    if(Object.keys(f.values).some(k=>typeof values[k as keyof Fields]!==typeof f.values[k as keyof Fields]))throw Error('Inspector draft retained, but its fields are unavailable.');
    f.values=values;f.dirty=true;f.draftId=draft.id;f.document={...f.document,revision:draft.expectedDocumentRevision};this.writeFields();editor.patch({drafts:'Restored unapplied inspector draft'});this.requestUpdate();
  }
  private draftId(kind:string,...parts:string[]){const legacy=[kind,...parts].join('_');if(legacy.length<=128)return legacy;const hash=new SHA256();hash.update(new TextEncoder().encode(JSON.stringify([kind,...parts])));return kind+'_'+hash.digest().slice(7);}
  private newFields(layer:ImageLayer,document:Document){const [a,b,c,d,x,y]=layer.layerToDocument;return {layer,document,dirty:false,draftId:this.draftId('inspector',document.id,layer.id),values:{appearance:layer.appearanceDescription??'',name:layer.name,opacity:String(layer.opacity),visible:layer.visible,locked:layer.locked,a:String(a),b:String(b),c:String(c),d:String(d),x:String(x),y:String(y)}};}
  private writeFields(){if(!this.fields)return;const slider=this.querySelector<EnSlider>('en-slider');if(slider)this.adapter.write(slider,'value',Number(this.fields.values.opacity)||0);for(const [key,value] of Object.entries(this.fields.values)){
    const host=this.querySelector<HTMLElement>('[data-field="'+key+'"]');if(host){if(typeof value==='boolean')this.adapter.write(host as EnSwitch,'checked',value);else this.adapter.write(host as EnNumberField,'value',value);}
  }}
  private async paint(){const generation=++this.renderGeneration;const d=editor.view.document;if(!this.canvas)return;await this.canvas.show(d?.image?.compositeAssetId??null,d?.width??0,d?.height??0);if(generation!==this.renderGeneration)return;this.draw();performance.clearMarks('ie.canvas.drawn');performance.mark('ie.canvas.drawn',{detail:{documentId:d?.id??null,revision:d?.revision??null,assetId:d?.image?.compositeAssetId??null}});}
  private async displayPreview(asset:string|null){const d=editor.view.document;if(!this.canvas||!d)return;const generation=++this.renderGeneration;await this.canvas.show(asset??d.image?.compositeAssetId??null,d.width,d.height);if(generation===this.renderGeneration)this.draw();}
  private draw(){this.canvas?.draw(this.zoom,this.pan.x,this.pan.y,ctx=>{this.authoring.overlay(ctx);this.semantic.overlay(ctx);this.textEditing.overlay(ctx);});performance.clearMarks('ie.viewport.drawn');performance.mark('ie.viewport.drawn',{detail:{zoom:this.zoom,x:this.pan.x,y:this.pan.y}});}
  private async reviewImage(asset:string){const response=await connection.transport('/api/v1/assets/'+asset+'/content');if(!response.ok){editor.fail(Error('PREVIEW_UNAVAILABLE'));return;}const blob=await response.blob();if(this.previewAsset!==asset)return;if(this.previewURL)URL.revokeObjectURL(this.previewURL);this.previewURL=URL.createObjectURL(blob);this.requestUpdate();}
  private async panels(){
    if(this.panelReady)return;
    this.panelLoading??=import('./editor-panels.js').then(({panelDefinitions})=>{scope.register(panelDefinitions);this.panelReady=true;this.requestUpdate();}).catch(error=>{this.panelLoading=undefined;throw error;});
    await this.panelLoading;await this.updateComplete;
  }
  private showPanel(panel:NonNullable<EditorShell['panel']>){void editor.run('Open '+panel,async()=>{await this.panels();if(panel==='open'){await editor.listUI();await editor.listStages();}this.panel=panel;this.requestUpdate();await this.updateComplete;this.querySelector<EnDialog>('#editor-dialog')?.show();});}
  private action(event:Event,label:string,work:()=>Promise<void>){this.adapter.action(event,()=>{void editor.run(label,work,event.timeStamp);});}
  private statusNavigation=(event:KeyboardEvent)=>{
    const region=event.currentTarget;
    if(event.defaultPrevented||event.isComposing||this.composition||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!['Home','End'].includes(event.key)||!(region instanceof HTMLElement)||region.tagName!=='SECTION'||event.target!==region||document.activeElement!==region||!region.isConnected||region.isContentEditable)return;
    // Only this app-owned scroll region consumes its own navigation keys.
    // Descendant native editing/activation and normal page navigation keep ownership.
    event.preventDefault();region.scrollTo({top:event.key==='Home'?0:region.scrollHeight,behavior:'instant'});
  };
  private closePanel(){this.panel=null;this.requestUpdate();}
  private async prepare(work:()=>Promise<void>){await this.panels();await work();this.panel=null;this.requestUpdate();await this.updateComplete;this.querySelector<EnDialog>('#review-dialog')?.show();}
  private input=(event:DraftInputEvent)=>{
    if(event.composedPath()[0]!==event.currentTarget)return;
    const key=(event.currentTarget as HTMLElement).dataset.field as keyof Fields;
    if(!key||!this.fields)return;
    (this.fields.values as Record<string,unknown>)[key]=event.detail.value;this.fields.dirty=true;this.saveInspector(event.detail.isComposing??this.composition);
  };
  private saveInspector(composing=false){const fields=this.fields;if(!fields)return;editor.changeDraft(fields.draftId,'inspector',JSON.stringify(fields.values),fields.layer.id,composing);}
  private changed=(event:Event)=>{const host=event.currentTarget as EnNumberField;this.adapter.settled(event,()=>host.value,value=>{if(this.fields){(this.fields.values as Record<string,unknown>)[host.dataset.field!]=value;this.fields.dirty=true;this.saveInspector();}});};
  private promptInput=(event:DraftInputEvent)=>{if(event.composedPath()[0]!==event.currentTarget)return;this.promptGeneration++;this.prompts[editor.view.document?.id+':'+this.operation]=event.detail.value;editor.changeDraft(this.promptId(),'prompt',JSON.stringify({schema:'editor-prompt-1',operation:this.operation,text:event.detail.value}),null,this.composition);};
  private promptId(){return this.promptIds[editor.view.document?.id+':'+this.operation]??this.draftId('prompt',String(editor.view.document?.id),String(operations.indexOf(this.operation)));}
  private async applyFields(kind:'properties'|'transform'|'appearance'){
    const f=this.fields;if(!f||this.composition)return;
    const before=JSON.stringify(f.values);await editor.flushDrafts();if(this.fields!==f||JSON.stringify(f.values)!==before)throw Error('DRAFT_CHANGED');
    const v=f.values;const id=f.draftId;const saved=editor.draftOwner?.drafts.get(id);
    const draft=saved&&saved.savedGeneration===saved.generation&&!editor.ui?.drafts.some(d=>d.id===id&&d.generation===saved.generation&&d.status==='applied')?{sessionId:editor.sessionId,draftId:id,generation:saved!.generation}:null;
    let body:Command['body'];
    if(kind==='appearance'){body={type:'SetLayerAppearance',layerId:f.layer.id,layerVersion:f.layer.version,description:v.appearance,draft};}
    else if(kind==='properties'){const opacity=Number(v.opacity);if(v.opacity.trim()===''||!Number.isFinite(opacity)||opacity<0||opacity>1)throw Error('Enter opacity between 0 and 1.');body={type:'SetLayerProperties',layerId:f.layer.id,layerVersion:f.layer.version,properties:{name:v.name,opacity,visible:v.visible,locked:v.locked},draft};}
    else{const transform=[v.a,v.b,v.c,v.d,v.x,v.y].map(Number) as [number,number,number,number,number,number];if(!transform.every(Number.isFinite)||transform[0]*transform[3]===transform[1]*transform[2])throw Error('Enter a finite, invertible image transform.');body={type:'ApplyTransform',layerId:f.layer.id,layerVersion:f.layer.version,transform,draft};}
    await editor.command(body,f.document);const layer=editor.view.image?.layers.find(l=>l.id===f.layer.id);if(layer&&editor.view.document){this.fields=this.newFields(layer,editor.view.document);this.writeFields();this.requestUpdate();}
  }
  private resetFields(){const old=this.fields;if(old)void editor.clearDraft(old.draftId).catch(e=>editor.fail(e));const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer&&editor.view.document){this.fields=this.newFields(layer,editor.view.document);this.writeFields();this.requestUpdate();}}
  private file=(event:Event,kind:'image'|'bundle')=>{const host=event.currentTarget as EnFileUpload;this.adapter.settled(event,()=>host.files,files=>{const file=files[0];if(!file)return;void editor.run(kind==='image'?'Prepare image':'Inspect portable project',()=>this.prepare(()=>kind==='image'?editor.importImage(file):editor.openBundle(file)));});};
  private drop=(event:DragEvent)=>{
    if(event.defaultPrevented||!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();
    const file=[...event.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(!file){editor.fail(Error('Drop a PNG, JPEG or static WebP image here. Use Open for a portable project.'));return;}
    void editor.run('Prepare dropped image',()=>this.prepare(()=>editor.importImage(file)),event.timeStamp);
  };
  private paste=(event:ClipboardEvent)=>{if(event.defaultPrevented||this.composition||this.editable(event))return;const file=[...(event.clipboardData?.files??[])].find(f=>f.type.startsWith('image/'));if(!file)return;event.preventDefault();void editor.run('Prepare pasted image',()=>this.prepare(()=>editor.importImage(file)));};
  private editable(event:Event){return event.composedPath().some(n=>n instanceof HTMLElement&&(n.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')||n.isContentEditable));}
  private shortcut=(event:KeyboardEvent)=>{
    if(event.defaultPrevented||event.isComposing||this.composition||event.keyCode===229||this.editable(event))return;
    const mod=event.metaKey||event.ctrlKey;
    if(event.key==='Escape'&&this.semantic.dragging){event.preventDefault();this.semantic.cancelDrag();return;}
    if(event.key==='Escape'&&this.authoring.drawing){event.preventDefault();this.authoring.cancelGesture();return;}
    if(mod&&event.key.toLowerCase()==='s'){event.preventDefault();if(event.shiftKey)this.showPanel('copy');else if(editor.view.document)void editor.run('Save checkpoint',async()=>{await editor.command({type:'SaveCheckpoint',name:'Checkpoint '+new Date().toLocaleString()});});return;}
    if(mod&&event.key.toLowerCase()==='o'){event.preventDefault();this.showPanel('open');return;}
    if(mod&&event.key.toLowerCase()==='z'&&!event.shiftKey&&this.tool==='Mask'&&this.authoring.undoStroke()){event.preventDefault();return;}
    if(mod&&event.key.toLowerCase()==='z'&&editor.view.document){event.preventDefault();this.historyAction(event.shiftKey?'Redo':'Undo');return;}
    if(mod||event.altKey)return;
    if(event.key==='?'){void this.panels().then(()=>this.querySelector<EnDialog>('#help-drawer')?.show());return;}
    if(!this.querySelector('#canvas')?.contains(event.target as Node))return;
    if(event.key==='Enter'){const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer?.kind==='text'){event.preventDefault();void editor.run('Edit text',()=>this.textEditing.begin(this.querySelector('#canvas')!,layer));return;}}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const n=event.shiftKey?50:10;this.pan={x:this.pan.x+(event.key==='ArrowLeft'?-n:event.key==='ArrowRight'?n:0),y:this.pan.y+(event.key==='ArrowUp'?-n:event.key==='ArrowDown'?n:0)};this.draw();void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));}
    if(event.key.toLowerCase()==='h'){this.tool='Pan';this.authoring.choose('Pan');this.requestUpdate();}
    if(['+','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')this.fit();else this.setZoom(this.zoom*(event.key==='+'?1.1:1/1.1));}
    if(event.key==='Escape'&&this.gesture){this.pan={x:this.gesture.oldX,y:this.gesture.oldY};this.gesture=null;this.draw();}
  };
  private historyAction(type:'Undo'|'Redo'){const d=editor.view.document;if(!d||type==='Redo'&&!d.redo)return;void editor.run(type,async()=>{await editor.command(type==='Undo'?{type,historyHead:d.historyHead}:{type,historyNode:d.redo!},d);});}
  private setZoom(value:number){if(!Number.isFinite(value)||value<=0){editor.fail(Error('Enter a positive, finite zoom percentage.'));return;}this.zoom=value;this.draw();void editor.preferences({viewport:{...this.pan,zoom:value}}).catch(e=>editor.fail(e));this.requestUpdate();}
  private fit(){const d=editor.view.document,c=this.querySelector('canvas');if(!d||!c)return;const box=c.getBoundingClientRect();this.pan={x:0,y:0};this.setZoom(Math.max(Number.EPSILON,Math.min((box.width-40)/d.width,(box.height-40)/d.height)));}
  private split=(event:Event)=>{const host=event.currentTarget as EnSplitter;this.adapter.settled(event,()=>host.value,value=>{host.parentElement!.style.setProperty('--pane-ratio',String(value/100));});};
  private persistSplit=(event:Event)=>{const host=event.currentTarget as EnSplitter;setTimeout(()=>{const p=editor.ui?.preferences.panels;if(p)void editor.preferences({panels:{...p,[host.id==='left-divider'?'left':'right']:(host.parentElement!.getBoundingClientRect().width-1)*(host.id==='left-divider'?host.value:100-host.value)/100}}).catch(e=>editor.fail(e));},0);};
  private numeric(id:string){const host=this.querySelector<EnNumberField>('#'+id)!;const raw=host.value;if(raw.trim()===''||!Number.isFinite(Number(raw)))throw Error('Enter a valid value for '+host.label+'.');return Number(raw);}
  private async download(){const item=editor.view.download;if(!item)return;const chosen=chooseDestination(item.name);await editor.run('Write '+item.kind,async()=>{editor.patch({download:{...item,status:'writing'}});try{const status=await writeDestination(item,connection.transport,chosen);editor.patch({download:{...item,status},message:status==='confirmed'?'Saved to destination: browser write completed.':'Download initiated. External destination remains unconfirmed.'});}catch(error){editor.patch({download:{...item,status:'failed'}});throw error;}});}
  private number(id:string,label:string,value:string,field?:keyof Fields){return html`<en-number-field id=${id} label=${label} .defaultValue=${value} data-field=${field??''} @en-input=${field?this.input:nothing} @en-change=${field?this.changed:nothing}></en-number-field>`;}
  private async leaf(body:Command['body']){await editor.command(body);}
  private historyItem=(item:ActivityRecord)=>{const node=editor.view.history.find(n=>n.id===item.key);return html`<p>${item.text}</p>${node?.kind==='image-edit'?html`<en-button slot="actions" size="small" variant="secondary" ?disabled=${editor.view.busy} @click=${(e:Event)=>this.action(e,'Switch retained branch',()=>this.leaf({type:'SwitchBranch',branchId:node.branchId,historyNode:node.id}))}>Open this history state</en-button>`:nothing}`;};
  private renderPanes(){
    const view=editor.view,d=view.document,f=this.fields,locked=!view.ready||view.busy;
    for(const [node,id,label,classes,open] of [[this.requestNode,'request','Request','request-panel panel',this.requestOpen],[this.inspectorNode,'inspector','Layers and properties','inspector panel',this.inspectorOpen]] as const){node.id=id;node.className=classes;node.tabIndex=-1;node.setAttribute('aria-label',label);node.hidden=this.narrow&&!this.drawerMode&&!open;}
    renderInto(html`<div class="panel-heading"><h1>Request</h1><en-badge>Draft</en-badge></div><div class="request-fields"><en-select label="Operation" .value=${this.semantic.view==='composition'?(this.semantic.operation??this.operation):this.operation} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSelect;this.adapter.settled(e,()=>host.value,value=>{this.promptGeneration++;this.operation=value;this.semantic.operationChanged(value);this.adapter.write(this.querySelector<EnTextarea>('#prompt')!,'value',this.prompts[editor.view.document?.id+':'+value]??'');this.requestUpdate();});}}>${operations.map(name=>html`<en-select-option value=${name}>${name}</en-select-option>`)}</en-select>
    ${this.semantic.request()}<div ?hidden=${this.semantic.view!=='plain'}><en-textarea id="prompt" label="Prompt" description=${d?'Draft autosaves locally; generation remains unavailable.':'Open a document to save this draft locally.'} placeholder="Describe the image you have in mind…" .rows=${5} @en-input=${this.promptInput} @focusout=${()=>void editor.flushDrafts().catch(e=>editor.fail(e))}></en-textarea></div><p class="muted">${view.drafts||(this.semantic.view==='plain'?'Plain prompt draft has not been applied.':'')}</p><h2>Explicit inputs</h2><p>Selecting a layer does not attach it to a request. Provider source, mask, adapters and generation remain unavailable; local layer masks are separate.</p><en-button disabled>Generate</en-button><p>Local selection, masks and layer edits are available in the inspector. Text uses explicit local Preview and Apply. Composition uses independent semantic elements and explicit reviewed field links.</p></div>`,this.requestNode,{host:this,creationScope:scope.creationScope});
    renderInto(html`<en-tabs label="Document structure" .value=${this.structure} @en-change=${(e:Event)=>{const h=e.currentTarget as HTMLElement&{value:string};this.adapter.settled(e,()=>h.value,v=>{this.semantic.cancelReview();this.structure=v;this.requestUpdate();});}}><en-tab slot="tab" value="layers">Layers</en-tab><en-tab slot="tab" value="composition">Composition</en-tab><en-tab-panel slot="panel" value="layers">
    <en-tree id="layer-tree" label="Image layers" .multiple=${true} .items=${[...(view.image?.layers??[])].reverse().map(l=>({key:l.id,label:(l.kind==='text'?'Text · ':'Image · ')+l.name+(l.visible?' · visible':' · hidden')+(l.locked?' · locked':'' )}))} @en-change=${(e:Event)=>{const h=e.currentTarget as EnTree;this.adapter.settled(e,()=>[...h.selectedKeys],ids=>{performance.clearMarks('ie.intent.Select layers');performance.mark('ie.intent.Select layers',{startTime:e.timeStamp});editor.select(ids);});}}></en-tree>
    ${!d?html`<p class="empty">No layers yet. Import an image to begin.</p>`:nothing}
    <en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Duplicate layer',()=>this.leaf({type:'DuplicateLayer',layerId:f!.layer.id,layerVersion:f!.layer.version,newLayerId:crypto.randomUUID(),name:f!.layer.name+' copy',draft:null}))}>Duplicate</en-button><en-button variant="ghost" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Delete layer',()=>this.leaf({type:'DeleteLayer',layerId:f!.layer.id,layerVersion:f!.layer.version,draft:null}))}>Delete layer</en-button><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Move layer up',async()=>{const ids=[...d!.orderedLayerIds],i=ids.indexOf(f!.layer.id);if(i<ids.length-1)[ids[i],ids[i+1]]=[ids[i+1],ids[i]];await this.leaf({type:'MoveLayers',orderedLayerIds:ids,draft:null});})}>Move up</en-button><en-button variant="secondary" ?disabled=${locked||!f} @click=${(e:Event)=>this.action(e,'Move layer down',async()=>{const ids=[...d!.orderedLayerIds],i=ids.indexOf(f!.layer.id);if(i>0)[ids[i],ids[i-1]]=[ids[i-1],ids[i]];await this.leaf({type:'MoveLayers',orderedLayerIds:ids,draft:null});})}>Move down</en-button></en-stack>
    </en-tab-panel><en-tab-panel slot="panel" value="composition">${this.semantic.inspector()}</en-tab-panel></en-tabs>
    <section class="properties" ?hidden=${this.structure!=='layers'}><h2>Layer properties</h2>${f?.layer.kind==='text'?html`<en-button id="edit-selected-text" ?disabled=${locked} @click=${(e:Event)=>{const trigger=e.currentTarget as HTMLElement;this.action(e,'Edit text',()=>this.textEditing.begin(trigger,f.layer));}}>Edit text</en-button>`:nothing}${f?html`<p>${f.dirty?'Unapplied inspector draft':'Accepted layer'} · base revision ${f.document.revision}</p><en-text-field label="Layer name" data-field="name" @en-input=${this.input} @en-change=${this.changed}></en-text-field>${this.number('opacity','Opacity (0–1)',f.values.opacity,'opacity')}
    <en-slider label="Opacity preview" .min=${0} .max=${1} .step=${.01} .defaultValue=${Number(f.values.opacity)||0} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSlider;this.adapter.settled(e,()=>host.value,v=>{f.values.opacity=String(v);f.dirty=true;this.adapter.write(this.querySelector<EnNumberField>('#opacity')!,'value',String(v));this.saveInspector();});}}></en-slider>
    ${(['visible','locked'] as const).map(key=>html`<en-switch data-field=${key} label=${key==='visible'?'Visible':'Locked'} @en-change=${(e:Event)=>{const host=e.currentTarget as EnSwitch;this.adapter.settled(e,()=>host.checked,v=>{f.values[key]=v;f.dirty=true;this.saveInspector();});}}></en-switch>`) }
    <en-button variant="secondary" ?disabled=${locked} @click=${(e:Event)=>this.action(e,f.layer.locked?'Unlock layer':'Lock layer',()=>this.leaf({type:'SetLayerProperties',layerId:f.layer.id,layerVersion:f.layer.version,properties:{locked:!f.layer.locked},draft:null}))}>${f.layer.locked?'Unlock layer':'Lock layer'}</en-button><en-stack class="actions" direction="horizontal" wrap gap="small"><en-button ?disabled=${locked||this.composition||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply properties',()=>this.applyFields('properties'))}>Apply properties</en-button><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.resetFields())}>Cancel changes</en-button></en-stack>
    <en-textarea label="Layer appearance description" data-field="appearance" @en-input=${this.input} @en-change=${this.changed}></en-textarea><en-button variant="secondary" ?disabled=${locked||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply appearance description',()=>this.applyFields('appearance'))}>Apply appearance description</en-button>${this.semantic.linked(f.layer.id).length?html`<en-button variant="secondary" @click=${(e:Event)=>this.adapter.action(e,()=>this.semantic.reveal(f.layer.id))}>Reveal linked semantic element</en-button>`:nothing}<h2>Transform</h2><p class="muted">Affine coefficients preserve rotation and shear. X/Y use document pixels. Scaling a text layer does not reflow its frame.</p><div class="property-grid">${(['x','y','a','b','c','d'] as const).map(k=>this.number('transform-'+k,k.toUpperCase(),f.values[k],k))}</div><en-button ?disabled=${locked||f.layer.locked} @click=${(e:Event)=>this.action(e,'Apply transform',()=>this.applyFields('transform'))}>Apply transform</en-button><en-button variant="secondary" ?disabled=${locked||f.layer.locked||f.layer.kind==='text'} @click=${()=>this.showPanel('resample')}>Resample image…</en-button>`:html`<p>Select a layer to inspect it.</p>`}
    ${this.authoring.render()}<en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${locked||!d} @click=${()=>this.showPanel('bounds')}>Canvas bounds…</en-button><en-button variant="secondary" ?disabled=${locked||!d?.image} @click=${()=>this.showPanel('flatten')}>Flatten copy…</en-button></en-stack></section>`,this.inspectorNode,{host:this,creationScope:scope.creationScope});
  }
  private async updateLayout(){
    if(this.composition)return;
    let active:Element|null=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    const focus=active instanceof HTMLElement?active:null;
    const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd,active.selectionDirection] as const:null;
    const inRequest=!!active&&this.requestNode.contains(document.activeElement),inInspector=!!active&&this.inspectorNode.contains(document.activeElement);
    const narrow=matchMedia('(max-width:1100px)').matches,extreme=matchMedia('(max-width:720px)').matches;
    if(narrow&&!extreme)await this.panels();
    if(this.composition)return;
    this.narrow=narrow;this.extreme=extreme;
    this.requestOpen ||= inRequest;this.inspectorOpen ||= inInspector;
    this.requestUpdate();await this.updateComplete;
    if(this.drawerMode){const drawer=this.querySelector<EnDialog>(inRequest?'#request-drawer':'#inspector-drawer');if(inRequest||inInspector)await drawer?.updateComplete;}
    if(focus?.isConnected&&(inRequest||inInspector)){focus.focus({preventScroll:true});if(selection&&selection[0]!==null)(focus as HTMLInputElement).setSelectionRange(selection[0],selection[1],selection[2]??undefined);}
  }
  private async togglePane(kind:'request'|'inspector',force?:boolean){
    if(this.narrow&&!this.extreme)await this.panels();
    if(kind==='request')this.requestOpen=force??!this.requestOpen;else this.inspectorOpen=force??!this.inspectorOpen;
    this.requestUpdate();await this.updateComplete;
  }
  protected render(){const {view,session}=this.read.snapshot;const d=view.document,f=this.fields;const locked=!view.ready||view.busy;this.renderPanes();
    return html`
    <div class="skip-links">${[['request','Request'],['canvas','Canvas'],['inspector','Layers'],['results','History']].map(([id,label])=>html`<en-link href=${'#'+id} @click=${async(e:Event)=>{e.preventDefault();if(id==='request'||id==='inspector')await this.togglePane(id,true);this.requestUpdate();await this.updateComplete;this.querySelector<HTMLElement>('#'+id)?.focus();const u=new URL(location.href);u.hash=id;history.replaceState(history.state,'',u);}}>Go to ${label}</en-link>`)}</div>
    <header class="document-bar"><div class="identity"><span class="brand-mark"><en-icon name="sparkles"></en-icon></span><div><strong>Ideogram <span class="wordmark-secondary">Editor</span></strong><span class="document-name">${d?`${d.width} × ${d.height} · revision ${d.revision}`:'No document open'}</span></div></div>
    <en-toolbar label="Document actions" keyboard-navigation="tab"><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('new')}>New</en-button><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('open')}>Open</en-button><en-button variant="ghost" ?disabled=${locked} @click=${()=>this.showPanel('import')}>Import image</en-button><en-button variant="ghost" ?disabled=${locked||!d?.image} @click=${(e:Event)=>this.adapter.action(e,()=>this.historyAction('Undo'))}>Undo</en-button><en-button variant="ghost" ?disabled=${locked||!d?.redo} @click=${(e:Event)=>this.adapter.action(e,()=>this.historyAction('Redo'))}>Redo</en-button></en-toolbar>
    <div class="bar-end"><en-button id="session-trigger" variant="ghost">${statusName[session.connection]}</en-button><en-popover for="session-trigger" label="Local connection"><p>${session.message}</p><p>No provider request is available in this workflow.</p><en-stack class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${session.busy} @click=${()=>connection.resume()}>Check connection</en-button><en-button variant="secondary" ?disabled=${session.busy||session.connection!=='paired'} @click=${()=>connection.renew()}>Renew connection</en-button><en-button variant="ghost" ?disabled=${session.busy||session.connection!=='paired'} @click=${()=>connection.revoke()}>Disconnect</en-button></en-stack></en-popover>
    <en-button variant="secondary" ?disabled=${locked||!d} @click=${()=>this.showPanel('copy')}>Save copy</en-button><en-button ?disabled=${locked||!d} @click=${(e:Event)=>this.action(e,'Export exact PNG',()=>editor.export())}>Export image</en-button><en-button id="help-trigger" variant="ghost" aria-describedby="help-description" @click=${()=>void this.panels().then(()=>this.querySelector<EnDialog>('#help-drawer')?.show())}>Help</en-button><span id="help-description" class="help-description">Shortcuts and recovery</span></div></header>
    ${session.connection!=='paired'?html`<section class="connection-panel"><p>${session.message}</p><en-button variant="secondary" ?disabled=${session.busy} @click=${()=>connection.resume()}>Check connection</en-button></section>`:nothing}
    <section class="operation-status" aria-label="Operation status" tabindex="0" @keydown=${this.statusNavigation} aria-busy=${view.busy}><en-alert class="operation-message" announcement="polite">${view.message}</en-alert>${view.recovery?html`<en-alert variant="warning">${view.recovery}</en-alert><en-button @click=${(e:Event)=>this.action(e,'Reconnect',async()=>{this.repaintKey='';await editor.connect();})}>Reconnect</en-button>`:nothing}${view.error&&!this.panel&&!view.review?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'inspector',message:view.error}]} @en-action=${(e:Event)=>{e.preventDefault();this.inspectorOpen=true;this.requestUpdate();void this.updateComplete.then(()=>this.querySelector<HTMLElement>('#inspector')?.focus());}}></en-validation-summary>`:nothing}
    ${view.uiPending.map(id=>html`<p>UI change receipt unknown. Current draft text is retained.</p><en-button ?disabled=${view.busy||!view.ready} @click=${(e:Event)=>this.action(e,'Retry original UI draft',()=>editor.retryDraft(id))}>Retry original draft delivery</en-button>`)}${view.pending.map(p=>html`<en-card class="pending"><span>${p.label} · ${p.result?.kind==='pending'?p.result.phase:'receipt unknown'}</span><en-button variant="secondary" ?disabled=${view.busy||!view.ready} @click=${(e:Event)=>this.action(e,'Retry original operation',()=>editor.retry(p.request.command.commandId))}>Check and retry original</en-button></en-card>`)}</section>
    <div class="mobile-openers"><en-button variant="secondary" id="request-opener" @click=${()=>void this.togglePane('request')}>${this.requestOpen?'Hide request':'Show request'}</en-button><en-button variant="secondary" id="inspector-opener" @click=${()=>void this.togglePane('inspector')}>${this.inspectorOpen?'Hide layers':'Show layers'}</en-button></div>
    <main class="workspace" aria-label="Image editor"><aside class="tool-rail"><en-toolbar label="Canvas tools" orientation=${this.narrow?'horizontal':'vertical'}>${[['Move','move'],['Text','text'],['Select','select'],['Mask','mask'],['Crop','crop'],['Sample','sample'],['Pan','hand'],['Zoom','zoom']].map(([name,glyph])=>html`<en-button class="tool" variant="ghost" ?disabled=${!(['Pan','Zoom'].includes(name)||!locked&&!!d)} aria-pressed=${this.tool===name} @click=${(e:Event)=>{const trigger=e.currentTarget as HTMLElement;this.adapter.action(e,()=>{this.tool=name;this.authoring.choose(name);if(name==='Text')void editor.run('Open text editor',()=>this.textEditing.begin(trigger));if(name==='Crop')this.showPanel('bounds');if(['Select','Mask','Sample','Move'].includes(name))void this.togglePane('inspector',true);this.requestUpdate();});}}><span slot="prefix" aria-hidden="true">${icon(glyph)}</span><span slot="label">${name}</span></en-button>`)}</en-toolbar></aside>
    <div class="outer-grid">${this.drawerMode?nothing:this.requestNode}
    <en-splitter id="left-divider" label="Request panel width" orientation="vertical" .value=${24} .min=${18} .max=${38} @en-change=${this.split} @pointerup=${this.persistSplit} @keyup=${this.persistSplit}></en-splitter>
    <div class="inner-grid"><section id="canvas" class="canvas-panel" tabindex="0" aria-label="Canvas" @paste=${this.paste} @dragover=${(e:DragEvent)=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();}} @drop=${this.drop}><en-toolbar class="canvas-toolbar" label="View controls" keyboard-navigation="tab"><span>${this.textEditing.active?'Text draft':this.tool} · ${d?'retained raster':'no document'}</span><en-number-field id="zoom" label="Zoom percentage" .value=${String(Math.round(this.zoom*100))} .min=${0.01} .step=${10} @en-change=${(e:Event)=>{const h=e.currentTarget as EnNumberField;this.adapter.settled(e,()=>h.value,v=>{performance.clearMarks('ie.intent.View zoom');performance.mark('ie.intent.View zoom',{startTime:e.timeStamp});this.setZoom(Number(v)/100);});}}></en-number-field><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.fit())} ?disabled=${!d}>Fit</en-button><en-button variant="ghost" @click=${(e:Event)=>this.adapter.action(e,()=>this.setZoom(1))} ?disabled=${!d}>100%</en-button></en-toolbar>
    <div class="canvas-viewport"><canvas aria-label="Document raster preview" @dblclick=${()=>{const layer=editor.view.image?.layers.find(l=>l.id===editor.view.selected[0]);if(layer?.kind==='text')void editor.run('Edit text',()=>this.textEditing.begin(this.querySelector('#canvas')!,layer));}} @pointerdown=${(e:PointerEvent)=>{if(this.semantic.pointerDown(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(this.authoring.pointerDown(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(e.button!==0)return;this.gesture={id:e.pointerId,x:e.clientX,y:e.clientY,oldX:this.pan.x,oldY:this.pan.y};(e.target as HTMLElement).setPointerCapture(e.pointerId);}} @pointermove=${(e:PointerEvent)=>{if(this.semantic.pointerMove(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(this.authoring.pointerMove(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;const g=this.gesture;if(!g||g.id!==e.pointerId)return;performance.clearMarks('ie.intent.Pan');performance.mark('ie.intent.Pan',{startTime:e.timeStamp});this.pan={x:g.oldX+e.clientX-g.x,y:g.oldY+e.clientY-g.y};this.draw();}} @pointerup=${(e:PointerEvent)=>{if(this.semantic.pointerUp(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;if(this.authoring.pointerUp(e,this.canvas!.point(e.clientX,e.clientY,this.zoom,this.pan.x,this.pan.y)))return;this.gesture=null;void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));}} @pointercancel=${()=>{this.semantic.cancelDrag();this.authoring.cancelGesture();const g=this.gesture;if(g)this.pan={x:g.oldX,y:g.oldY};this.gesture=null;this.draw();}}></canvas>
    ${!d?html`<div class="canvas-empty"><h2>A little room to create.</h2><p>Choose or drop an image, then review before Apply.</p><en-file-upload label="Import an image" choose-label="Choose image" accept="image/png,image/jpeg,image/webp" ?disabled=${locked} @en-change=${(e:Event)=>this.file(e,'image')}></en-file-upload><p>PNG, JPEG or static WebP. Original bytes are retained.</p></div>`:nothing}</div><div class="canvas-caption"><span>${d?`${d.width} × ${d.height} pixels · ${view.selected.length} selected`:'No image accepted'}</span><span>Paste an image here to review</span></div><en-toolbar class="pan-fields" label="Numeric view controls" keyboard-navigation="tab">${this.number('pan-x','View X (px)',String(this.pan.x))}${this.number('pan-y','View Y (px)',String(this.pan.y))}<en-button variant="secondary" @click=${(e:Event)=>this.adapter.action(e,()=>{this.pan={x:this.numeric('pan-x'),y:this.numeric('pan-y')};this.draw();void editor.preferences({viewport:{...this.pan,zoom:this.zoom}}).catch(e=>editor.fail(e));})}>Apply view</en-button></en-toolbar></section>
    <en-splitter id="right-divider" label="Canvas and inspector width" orientation="vertical" .value=${73} .min=${45} .max=${80} @en-change=${this.split} @pointerup=${this.persistSplit} @keyup=${this.persistSplit}></en-splitter>
    ${this.drawerMode?nothing:this.inspectorNode}</div></div></main>
    ${this.textEditing.render()}
    <section id="results" class="results-tray" tabindex="-1" aria-label="Activity"><en-accordion-item label="Activity" .open=${true}><en-tabs label="Activity views" value="history"><en-tab slot="tab" value="results">Results</en-tab><en-tab slot="tab" value="jobs">Jobs</en-tab><en-tab slot="tab" value="history">History</en-tab><en-tab-panel slot="panel" value="results"><p class="empty">Generation results are not available in this version.</p></en-tab-panel><en-tab-panel slot="panel" value="jobs"><p class="empty">No jobs submitted. This workflow makes no provider calls.</p></en-tab-panel><en-tab-panel slot="panel" value="history"><en-activity-feed label="Retained document history" mode="paginated" .pageSize=${20} .items=${view.history.map(n=>({key:n.id,author:n.kind==='image-edit'?n.operation:'Document created',text:(n.kind==='image-edit'?n.operation:'Creation')+' · '+n.id+(n.id===d?.historyHead?' · current':''),label:'History '+n.id}))} .renderItem=${this.historyItem}></en-activity-feed>
    ${d?html`<en-button variant="ghost" @click=${(e:Event)=>this.action(e,'Read first history page',()=>editor.historyPage('history'))}>First history page</en-button>`:nothing}${view.historyNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next history page',()=>editor.historyPage('history',view.historyNext))}>Next history page</en-button>`:nothing}
    <en-stack class="actions" direction="horizontal" wrap gap="small"><en-text-field id="checkpoint-name" label="Checkpoint name" value="My checkpoint"></en-text-field><en-button ?disabled=${locked||!d} @click=${(e:Event)=>this.action(e,'Save checkpoint',()=>this.leaf({type:'SaveCheckpoint',name:(this.querySelector('#checkpoint-name') as EnNumberField).value}))}>Save checkpoint</en-button></en-stack><p>Checkpoints retain their full history.</p>${view.checkpoints.map(checkpoint=>html`<en-button variant="secondary" ?disabled=${locked||!checkpoint.image} @click=${(e:Event)=>this.action(e,'Open checkpoint',()=>editor.openCheckpoint(checkpoint))}>Open checkpoint: ${checkpoint.name}</en-button>`)}${view.checkpointNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next checkpoints',()=>editor.historyPage('checkpoints',view.checkpointNext))}>Next checkpoint page</en-button>`:nothing}</en-tab-panel></en-tabs></en-accordion-item></section>
    ${view.download?html`<en-card class="download-panel" role="region" aria-label="Prepared file"><p>${view.download.kind==='copy'?'Full-history copy':'Exact PNG'} · ${view.download.bytes} bytes · captured revision ${view.download.revision}${view.download.documentId!==d?.id||view.download.revision!==d?.revision?' (earlier document state)':''} · ${view.download.status==='confirmed'?'Saved to destination':view.download.status==='unconfirmed'?'Download initiated — destination unconfirmed':view.download.status==='writing'?'Writing destination…':view.download.status==='failed'?'Destination write failed; local bytes retained':'Ready — destination unconfirmed'}</p><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.adapter.action(e,()=>void this.download())}>${typeof (window as unknown as {showSaveFilePicker?:unknown}).showSaveFilePicker==='function'?'Choose destination and save':'Download prepared file'}</en-button></en-card>`:nothing}
    <footer class="status-bar"><span>${view.busy?'Operation pending':view.ready?'Accepted edits saved locally':'Local authority unavailable'} · ${view.drafts||'No local draft change'}</span><span>${!d?'No document checkpoint':view.save?.documentChangedSinceCheckpoint?'Checkpoint outdated':'Checkpoint content current'} · ${!d?'No portable copy':view.save?.bundleOutdated?'Portable copy outdated':'Copy state current'} · External destination ${view.download?.status==='confirmed'?'confirmed for prepared file':'unconfirmed'}</span></footer>
    ${this.panelReady?html`<en-drawer id="request-drawer" label="Request panel" placement="start" .open=${this.drawerMode&&this.requestOpen} @en-change=${(e:Event)=>{const h=e.currentTarget as EnDialog;this.adapter.settled(e,()=>h.open,v=>{this.requestOpen=v;this.requestUpdate();});}}>${this.drawerMode?this.requestNode:nothing}</en-drawer><en-drawer id="inspector-drawer" label="Layers and properties panel" placement="end" .open=${this.drawerMode&&this.inspectorOpen} @en-change=${(e:Event)=>{const h=e.currentTarget as EnDialog;this.adapter.settled(e,()=>h.open,v=>{this.inspectorOpen=v;this.requestUpdate();});}}>${this.drawerMode?this.inspectorNode:nothing}</en-drawer>`:nothing}
    ${this.panelReady?this.dialogs():nothing}${this.panelReady?this.semantic.dialog():nothing}
    ${new URL(location.href).searchParams.has('progress-report')?html`<en-link class="report-return" href=${__PROGRESS_REPORT_URL__}>Progress Report ↗</en-link>`:nothing}`;
  }
  private dialogs(){const view=editor.view,d=view.document,r=view.review;const close=(e:Event)=>{const host=e.currentTarget as EnDialog;this.adapter.settled(e,()=>host.open,open=>{if(!open){this.panel=null;this.requestUpdate();}});};
    return html`<en-drawer id="help-drawer" label="Editor help" for="help-trigger"><p>Import → review → Apply → edit → Undo → Save copy → reopen → Export image.</p><p>Cmd/Ctrl+S saves a checkpoint; Shift+Cmd/Ctrl+S prepares a full-history copy; Cmd/Ctrl+O opens a local document or portable file. Native fields keep their own undo and clipboard shortcuts.</p><p>Canvas: H Pan, +/− zoom, 0 Fit. Use numeric view fields without a pointer. Conversion, resample and flatten review require Apply.</p><p>Restart the launcher on the same private root, pair, then open recovered documents. An expired review needs a fresh review. Accepted commands and originals stay retained.</p></en-drawer>
    <en-dialog id="editor-dialog" label=${this.panel==='new'?'New document':this.panel==='open'?'Open document':this.panel==='import'?'Import image':this.panel==='resample'?'Resample intrinsic image':this.panel==='flatten'?'Flatten a copy':this.panel==='copy'?'Full-history portable copy':'Canvas bounds'} .open=${this.panel!==null} @en-change=${close}>
    ${view.error&&this.panel?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'editor-dialog',message:view.error}]}></en-validation-summary>`:nothing}
    ${this.panel==='new'?html`<p>Create an empty sRGB, 8-bit document.</p>${this.number('new-width','Width (px)','1024')}${this.number('new-height','Height (px)','1024')}<en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Create document',async()=>{await editor.create(this.numeric('new-width'),this.numeric('new-height'));this.closePanel();})}>Create</en-button>`:nothing}
    ${this.panel==='open'?html`<h2>Recovered local documents</h2>${view.documents.map(doc=>html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Open local document',async()=>{await editor.open(doc.id);this.closePanel();})}>${doc.id} · ${doc.width} × ${doc.height} · revision ${doc.revision}</en-button>`)}<h2>Interrupted file transfers</h2><p>Reselect the exact original file to resume from its committed offset. Bytes never uploaded and unadmitted requests cannot be reconstructed after losing this tab.</p>${view.stages.map(stage=>html`<section><p>${stage.purpose} · ${stage.committedOffset} / ${stage.expectedBytes} bytes · ${stage.state}</p>${stage.ownerClientId===connection.identity()&&['image','bundle'].includes(stage.purpose)?html`<en-file-upload label=${'Resume '+stage.stagingId} choose-label="Reselect exact original" ?disabled=${view.busy} @en-change=${(e:Event)=>{const host=e.currentTarget as EnFileUpload;this.adapter.settled(e,()=>host.files,files=>{if(files[0])void editor.run('Resume original transfer',()=>this.prepare(()=>editor.resumeStage(files[0],stage.stagingId)));});}}></en-file-upload>`:html`<p>Retained content; current client has no import authority for this entry.</p>`}</section>`)}${view.stageNext?html`<en-button @click=${(e:Event)=>this.action(e,'Read next transfers',()=>editor.listStages(view.stageNext))}>Next transfer page</en-button>`:nothing}<h2>Saved views and drafts</h2><p>Choose a current checkpoint to restore its view and unapplied drafts. A sequence belongs only to that checkpoint.</p>${view.uiChoices.map(choice=>html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Restore UI checkpoint',async()=>{await editor.restoreUI(choice);this.restoredUI='';this.inspectorKey='';this.closePanel();})}>Restore ${choice.sessionId} · document ${choice.documentId??'none'} · sequence ${choice.uiSeq}</en-button>`)}${view.uiNext?html`<en-button variant="secondary" @click=${(e:Event)=>this.action(e,'Read next UI checkpoints',()=>editor.listUI(view.uiNext))}>Next saved views page</en-button>`:nothing}<en-file-upload label="Open portable project" choose-label="Choose project" accept=".ideogram-project" ?disabled=${view.busy} @en-change=${(e:Event)=>this.file(e,'bundle')}></en-file-upload>`:nothing}
    ${this.panel==='import'?html`<en-file-upload label="Image file" choose-label="Choose image" accept="image/png,image/jpeg,image/webp" ?disabled=${view.busy} @en-change=${(e:Event)=>this.file(e,'image')}></en-file-upload><p>Selection prepares a conversion review. Apply is required to change the document.</p>`:nothing}
    ${this.panel==='resample'?html`<p>Change intrinsic source dimensions. Document bounds and layer transform remain unchanged. Review the resulting full document before Apply.</p>${this.number('resample-width','Intrinsic width (px)','1024')}${this.number('resample-height','Intrinsic height (px)','1024')}<en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare resample',()=>this.prepare(()=>editor.prepareEdit({type:'PrepareImageResample',layerId:this.fields!.layer.id,layerVersion:this.fields!.layer.version,width:this.numeric('resample-width'),height:this.numeric('resample-height')})))}>Prepare preview</en-button>`:nothing}
    ${this.panel==='flatten'?html`<en-select id="flatten-scope" label="Flatten scope" value="visible"><en-select-option value="visible">All visible layers</en-select-option><en-select-option value="selected">Selected layers</en-select-option></en-select><en-switch id="flatten-hidden" label="Include hidden selected layers"></en-switch><en-switch id="flatten-hide" label="Hide originals after creating the copy"></en-switch><p>Originals and retained branches remain. The topmost copy can change the visible result; review the actual full document.</p><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare flatten copy',()=>this.prepare(()=>editor.prepareEdit({type:'PrepareFlattenedCopy',layerIds:(this.querySelector('#flatten-scope') as EnSelect).value==='visible'?view.image!.layers.filter(l=>l.visible).map(l=>l.id):view.selected,includeHidden:(this.querySelector('#flatten-hidden') as EnSwitch).checked,hideOriginals:(this.querySelector('#flatten-hide') as EnSwitch).checked,newLayerId:crypto.randomUUID(),name:'Flattened copy'})))}>Prepare preview</en-button>`:nothing}
    ${this.panel==='bounds'?html`<en-select id="bounds-mode" label="Bounds action" value="resize"><en-select-option value="resize">Resize canvas</en-select-option><en-select-option value="crop">Crop document</en-select-option></en-select><div class="property-grid">${this.number('bounds-width','Width (px)',String(d?.width??1024))}${this.number('bounds-height','Height (px)',String(d?.height??1024))}${this.number('bounds-x','X offset / crop origin (px)','0')}${this.number('bounds-y','Y offset / crop origin (px)','0')}</div><en-alert announcement="none">Apply moves layers and retained mask origins by the reviewed offset; crop uses the negative crop origin. Original pixels and hard/effective coverage stay intact. Outside a retained mask grid, coverage is zero, including inverted masks. Later expansion can reveal coverage hidden by these bounds.</en-alert><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Apply canvas bounds',async()=>{const width=this.numeric('bounds-width'),height=this.numeric('bounds-height'),x=this.numeric('bounds-x'),y=this.numeric('bounds-y');await editor.command((this.querySelector('#bounds-mode') as EnSelect).value==='crop'?{type:'CropDocument',width,height,x,y,draft:null}:{type:'ResizeCanvas',width,height,offsetX:x,offsetY:y,draft:null});this.closePanel();})}>Apply bounds</en-button>`:nothing}
    ${this.panel==='copy'?html`<p>This copy includes all retained branches, edits, checkpoints, original and derived image bytes, and current drafts for this document. Other documents are excluded. Missing required bytes block a complete copy.</p><p>Preparing bytes does not confirm an external destination. Choose a destination after the complete copy is ready.</p><en-button ?disabled=${view.busy} @click=${(e:Event)=>this.action(e,'Prepare full-history copy',async()=>{await editor.copy();this.closePanel();})}>Prepare complete copy</en-button>`:nothing}
    <en-button slot="footer" variant="secondary" @click=${()=>this.closePanel()}>Cancel</en-button></en-dialog>
    <en-dialog id="review-dialog" label=${r?.kind==='image'?'Review image conversion':r?.kind==='edit'?'Review prepared image edit':'Review portable project'} .open=${!!r} @en-change=${(e:Event)=>{const host=e.currentTarget as EnDialog;this.adapter.settled(e,()=>host.open,open=>{if(!open&&!editor.view.busy)editor.patch({review:null});});}}>
    ${view.error&&r?html`<en-validation-summary heading="Action needs attention" .items=${[{target:'review-dialog',message:view.error}]}></en-validation-summary>`:nothing}
    ${r?.kind==='image'?html`<p>${r.name}</p><p>${r.asset.raster!.width} × ${r.asset.raster!.height} working pixels · ${r.review.conversion?.profile} → sRGB · orientation ${r.review.conversion?.orientation} · ${r.review.conversion?.colorChanged?'color conversion applied':'color unchanged'} · ${r.review.conversion?.orientationChanged?'orientation normalized':'orientation unchanged'} · no resize · alpha retained</p><p>${r.target?'Apply adds a layer to revision '+r.target.revision:'Apply creates a document at the image dimensions.'}</p>`:nothing}
    ${r?.kind==='edit'?html`<p>${r.review.preview.kind} · source revision ${r.review.preview.documentRevision}. This is the prepared full-document result. Apply commits these exact retained pixels.</p>`:nothing}
    ${r&&r.kind!=='bundle'?html`<img class="review-image" src=${this.previewURL||nothing} alt="Exact prepared raster preview" @load=${()=>{this.previewLoaded=true;this.requestUpdate();}}><p class="identity-note">Review expires ${r.review.expiresAt}. Restart or connection renewal invalidates unaccepted authority.</p>`:nothing}
    ${r?.kind==='bundle'?html`<p>${r.name} · ${r.review.source.byteLength} bytes</p><p>${r.review.objectCount} objects · ${r.review.entityCount} entities · ${r.review.eventCount} events · ${r.review.uiSessionCount} UI checkpoints</p><p>Includes this document’s current drafts and all retained domain history. Obsolete unattributed UI-only content is excluded and retained locally.</p><p>${r.review.editable?'Apply opens a new local identity. Imported records do not schedule provider work.':'Inspection only: '+r.review.reason}</p>`:nothing}
    <en-stack slot="footer" class="actions" direction="horizontal" wrap gap="small"><en-button variant="secondary" ?disabled=${view.busy} @click=${()=>editor.patch({review:null,message:'Review canceled. Original bytes remain retained; no document edit was accepted.'})}>Cancel review</en-button><en-button ?disabled=${view.busy||!r||r.kind==='bundle'&&!r.review.editable||r.kind!=='bundle'&&!this.previewLoaded} @click=${(e:Event)=>this.action(e,'Apply reviewed result',()=>editor.applyReview())}>Apply reviewed result</en-button></en-stack></en-dialog>`;
  }
}
scope.register([{tagName:'ie-shell',elementClass:EditorShell}]);
export async function mount(token?:string){const shell=scope.createElement('ie-shell') as EditorShell;document.querySelector('#app')!.append(shell);await shell.updateComplete;void connection.start(token);token=undefined;}
