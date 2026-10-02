import type { Writer } from './storage/writer.js';
import type { AssetAuth } from './storage/assets.js';
import { ProtocolError } from './errors.js';
import {validateComposition,validateCompositionRef,bindingMap} from '../src/composition/core.js';
import type { LayerValue, Composition } from '../src/composition/core.js';
import {compositionDraft,compositionDraftGraph} from '../src/composition/draft.js';
import {DRAFT_GRAPH_BYTES,COMPOSITION_VALUE_BYTES,COMPOSITION_DRAFT_VIEW_BYTES,COMPOSITION_VIEW_BYTES} from '../src/composition/view.js';
import {parseControlJSON} from '../src/protocol/json.js';
import type {BlobRef} from '../src/protocol/store.js';
import {adapterResources} from './observability/adapter-resources.js';

export async function compositionView(writer:Writer,id:string,revision:string,auth:AssetAuth,draftId:string|null,generation:string|null,current:()=>void=()=>{}){
 const read=await writer.openCompositionRead(current);
 const observed=async<T>(pending:Promise<T>)=>{const value=await pending;current();return value;};
 const consume=async<T>(ref:BlobRef,limit:number,parse:(bytes:Uint8Array)=>T):Promise<T>=>{
  const bytes=await read.read(ref,limit),releaseBytes=adapterResources.buffer('composition-view','metadata-bytes',bytes),releaseConsumer=adapterResources.handle('writer-consumer','metadata');
  try{return parse(bytes);}finally{writer.releaseResourceBytes(bytes);releaseBytes();releaseConsumer();}
 };
 try{
  if(draftId){
   const ui=await observed(writer.uiRead(id,auth)),draft=ui.drafts.find(d=>d.id===draftId&&d.kind==='composition');if(!draft||draft.generation!==generation)throw new ProtocolError('READ_CONTEXT_EXPIRED');
   const a=(await observed(writer.assetProjection(draft.assetId))).asset;if(!a)throw new ProtocolError('NOT_FOUND');
   const envelope=await consume(a.blob,65536,bytes=>parseControlJSON(bytes));compositionDraft(envelope);
   const graph=await consume(envelope.graph,DRAFT_GRAPH_BYTES,bytes=>parseControlJSON(bytes,DRAFT_GRAPH_BYTES));compositionDraftGraph(graph,envelope);
   const check=async()=>{const now=(await observed(writer.uiRead(id,auth))).drafts.find(d=>d.id===draftId);if(now?.kind!=='composition'||now.generation!==generation||now.assetId!==draft.assetId)throw new ProtocolError('READ_CONTEXT_EXPIRED');};
   await check();return {data:{graph,bindings:draft.compositionBindings??{},draft},raw:envelope.raw,check,read,limit:COMPOSITION_DRAFT_VIEW_BYTES};
  }
  const d=await observed(writer.document(id));if(!d||d.revision!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');const state=await observed(writer.imageState(id));let composition:Composition|null=null;
  if(state.composition){validateCompositionRef(state.composition);const v=await consume(state.composition.value,COMPOSITION_VALUE_BYTES,bytes=>parseControlJSON(bytes,COMPOSITION_VALUE_BYTES));validateComposition(v);if(v.id!==state.composition.id)throw new ProtocolError('READ_CONTEXT_EXPIRED');bindingMap(v,state.composition.bindings);composition=v;}
  const layers:LayerValue[]=[];
  for(const l of state.layers){const a=(await observed(writer.assetProjection(l.assetId))).asset;if(!a?.raster)throw new ProtocolError('NOT_FOUND');let width=a.raster.width,height=a.raster.height,text:string|undefined;if(l.kind==='text'){const s=await consume(l.source,65536,bytes=>parseControlJSON(bytes)) as any;width=s.text.frame.width;height=s.text.frame.height;text=await consume(s.text.textUtf8,65536,bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}layers.push({id:l.id,version:l.version,kind:l.kind,...(text!==undefined?{text}:{}),appearance:l.appearanceDescription??'',bounds:{rect:[0,0,width,height],transform:l.layerToDocument}});}
  const check=async()=>{if(await observed(writer.documentRevision(id))!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');};await check();
  return {data:{composition,compositionRef:state.composition??null,bindings:state.composition?.bindings??{},layers,revision},raw:composition?.raw??[],check,read,limit:COMPOSITION_VIEW_BYTES};
 }catch(error){try{await read.release();}catch(cleanup){throw new AggregateError([error,cleanup],'COMPOSITION_RELEASE_INCOMPLETE');}throw error;}
}
