import type { Writer } from './storage/writer.js';
import type { AssetAuth } from './storage/assets.js';
import { ProtocolError } from './errors.js';
import {validateComposition,validateCompositionRef,bindingMap} from '../src/composition/core.js';
import type { LayerValue, Composition } from '../src/composition/core.js';
import {compositionDraft,compositionDraftGraph} from '../src/composition/draft.js';
import {parseControlJSON} from '../src/protocol/json.js';

export async function compositionView(writer:Writer,id:string,revision:string,auth:AssetAuth,draftId:string|null,generation:string|null){
 if(draftId){const ui=await writer.uiRead(id,auth),draft=ui.drafts.find(d=>d.id===draftId&&d.kind==='composition');if(!draft||draft.generation!==generation)throw new ProtocolError('READ_CONTEXT_EXPIRED');const a=(await writer.assetProjection(draft.assetId)).asset;if(!a)throw new ProtocolError('NOT_FOUND');const envelope=parseControlJSON(await writer.readMetadata(a.blob));compositionDraft(envelope);if(BigInt(envelope.graph.byteLength)>8388608n)throw new ProtocolError('PAYLOAD_TOO_LARGE');const graph=parseControlJSON(await writer.readMetadata(envelope.graph),8388608);compositionDraftGraph(graph,envelope);const now=(await writer.uiRead(id,auth)).drafts.find(d=>d.id===draftId);if(now?.generation!==generation||now.assetId!==draft.assetId)throw new ProtocolError('READ_CONTEXT_EXPIRED');return {data:{graph,bindings:draft.compositionBindings,draft},raw:envelope.raw};}
 const d=await writer.document(id);if(!d||d.revision!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');const state=await writer.imageState(id);let composition:Composition|null=null;
 if(state.composition){validateCompositionRef(state.composition);const v=parseControlJSON(await writer.readMetadata(state.composition.value),1048576);validateComposition(v);bindingMap(v,state.composition.bindings);composition=v;}
 const layers:LayerValue[]=[];
 for(const l of state.layers){const a=(await writer.assetProjection(l.assetId)).asset;if(!a?.raster)throw new ProtocolError('NOT_FOUND');let width=a.raster.width,height=a.raster.height,text:string|undefined;if(l.kind==='text'){const s=parseControlJSON(await writer.readMetadata(l.source)) as any;width=s.text.frame.width;height=s.text.frame.height;text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await writer.readMetadata(s.text.textUtf8));}layers.push({id:l.id,version:l.version,kind:l.kind,...(text!==undefined?{text}:{}),appearance:l.appearanceDescription??'',bounds:{rect:[0,0,width,height],transform:l.layerToDocument}});}
 if(await writer.documentRevision(id)!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');return {data:{composition,bindings:state.composition?.bindings??{},layers,revision},raw:composition?.raw??[]};
}
