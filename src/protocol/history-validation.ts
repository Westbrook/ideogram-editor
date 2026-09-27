import { blob } from './validate.js';
import { isTextCommand, textBody } from './text.js';
import { keys, id, seq, requireValue as ok } from './validate.js';
import { inverse, extent } from '../raster/core.js';
import type { Affine } from '../raster/core.js';
import type { ImageState } from './history.js';

export function affine(v: any) { ok(Array.isArray(v) && v.length === 6); inverse(v as unknown as Affine); }
export function layerMask(v: any) {
  if (v === null) return;
  keys(v, ['assetId','mapping','inverted']);
  ok(id(v.assetId) && ['document-luminance-alpha-v1','document-r16-v1'].includes(v.mapping) && typeof v.inverted === 'boolean');
}
export function imageState(v: any): asserts v is ImageState {
  keys(v, ['schemaVersion','width','height','layers']); extent(v.width,v.height);
  ok([1,2,3].includes(v.schemaVersion) && Array.isArray(v.layers) && v.layers.length <= 100);
  const seen = new Set();
  for (const l of v.layers) {
    keys(l,['id','version','kind','name','assetId','layerToDocument','opacity','visible','locked','blend','mask',...(l.kind==='text'?['source']:[])]);
    if(l.kind==='text'){ok(v.schemaVersion>=2);blob(l.source);ok(l.source.mediaType==='application/json'&&BigInt(l.source.byteLength)<=65536n);}
    ok(id(l.id) && seq(l.version) && ['image','text'].includes(l.kind) && id(l.assetId) && !seen.has(l.id)); seen.add(l.id);
    if(l.mask?.mapping==='document-r16-v1')ok(v.schemaVersion===3);
    properties({name:l.name,opacity:l.opacity,visible:l.visible,locked:l.locked,mask:l.mask});
    affine(l.layerToDocument); ok(l.blend === 'normal');
  }
}
function properties(v: any) {
  ok(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0);
  for (const [k,x] of Object.entries(v)) {
    if (k === 'name') ok(typeof x === 'string' && x.length > 0 && new TextEncoder().encode(x).length <= 1024);
    else if (k === 'opacity') ok(typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1);
    else if (k === 'visible' || k === 'locked') ok(typeof x === 'boolean');
    else if (k === 'mask') layerMask(x);
    else throw new Error('Unknown image property');
  }
}
export function historyBody(b: any) {
  if(isTextCommand(b.type)){textBody(b);return;}
  const fields: Record<string,string[]> = {
    ImportAsset:['assetId','layerId','name','draft'], ApplyTransform:['layerId','layerVersion','transform','draft'],
    SetLayerProperties:['layerId','layerVersion','properties','draft'], DeleteLayer:['layerId','layerVersion','draft'],
    DuplicateLayer:['layerId','layerVersion','newLayerId','name','draft'], MoveLayers:['orderedLayerIds','draft'],
    CropDocument:['x','y','width','height','draft'], ResizeCanvas:['width','height','offsetX','offsetY','draft'],
    PrepareImageResample:['layerId','layerVersion','width','height'],PrepareFlattenedCopy:['layerIds','includeHidden','hideOriginals','newLayerId','name'],ReviewImageEdit:['previewId'],ResampleImage:['previewId','reviewId','reviewHash','draft'],CreateFlattenedCopy:['previewId','reviewId','reviewHash','draft'],SaveCheckpoint:['name'], Undo:['historyHead'], Redo:['historyNode'], SwitchBranch:['branchId','historyNode'], ExportDocument:['historyHead'],
  };
  ok(Object.hasOwn(fields,b.type)); keys(b,['type',...fields[b.type]]);
  for (const k of ['assetId','layerId','newLayerId','historyHead','historyNode','branchId','previewId','reviewId']) if (k in b) ok(id(b[k]));
  if('reviewHash' in b)ok(/^sha256:[a-f0-9]{64}$/.test(b.reviewHash));
  if('layerIds' in b)ok(Array.isArray(b.layerIds)&&b.layerIds.length>0&&b.layerIds.length<=100&&b.layerIds.every(id)&&new Set(b.layerIds).size===b.layerIds.length&&typeof b.includeHidden==='boolean'&&typeof b.hideOriginals==='boolean');
  if ('layerVersion' in b) ok(seq(b.layerVersion));
  if ('name' in b) {if(b.type==='SaveCheckpoint')ok(typeof b.name==='string');else properties({name:b.name});}
  if ('transform' in b) affine(b.transform);
  if ('properties' in b) properties(b.properties);
  if ('orderedLayerIds' in b) ok(Array.isArray(b.orderedLayerIds) && b.orderedLayerIds.length <= 100 && b.orderedLayerIds.every(id) && new Set(b.orderedLayerIds).size === b.orderedLayerIds.length);
  if ('width' in b) extent(b.width,b.height);
  for (const k of ['x','y','offsetX','offsetY']) if (k in b) ok(Number.isSafeInteger(b[k]));
  if ('draft' in b && b.draft !== null) { keys(b.draft,['sessionId','draftId','generation']); ok(id(b.draft.sessionId)&&id(b.draft.draftId)&&seq(b.draft.generation)); }
}
