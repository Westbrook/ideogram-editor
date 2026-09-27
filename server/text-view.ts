import type { Writer } from './storage/writer.js';
import { ProtocolError } from './errors.js';
import { textSource, textDraft } from '../src/protocol/text.js';
import type { AssetAuth } from './storage/assets.js';

// Only an explicit retained layer or this client's draft; never arbitrary hashes.
export async function readTextView(writer:Writer,id:string,target:string,revision:string|null,auth:AssetAuth){
  if(revision!==null){
    const document=await writer.document(id);
    if(!document||document.revision!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');
    const layer=(await writer.imageState(id)).layers.find(l=>l.id===target);
    if(!layer||layer.kind!=='text')throw new ProtocolError('NOT_FOUND');
    const source=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await writer.readMetadata(layer.source)));textSource(source);
    if(await writer.documentRevision(id)!==revision)throw new ProtocolError('READ_CONTEXT_EXPIRED');
    return {documentRevision:revision,layerVersion:layer.version,source};
  }
  const checkpoint=await writer.uiRead(id,auth),draft=checkpoint.drafts.find(d=>d.id===target&&d.kind==='text');
  if(!draft)throw new ProtocolError('NOT_FOUND');
  const asset=(await writer.assetProjection(draft.assetId)).asset;if(!asset)throw new ProtocolError('NOT_FOUND');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await writer.readMetadata(asset.blob)));textDraft(value);
  const current=(await writer.uiRead(id,auth)).drafts.find(d=>d.id===target);
  if(current?.generation!==draft.generation||current.assetId!==draft.assetId)throw new ProtocolError('READ_CONTEXT_EXPIRED');
  return {draft,value};
}
