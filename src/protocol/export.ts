import { extent } from '../raster/core.js';
import { id, keys, requireValue as ok } from './validate.js';

/** The complete reviewed encoder choice; omission on legacy commands means native PNG. */
export type RasterExportOptions = {
  format: 'png' | 'jpeg';
  resize: null | { width: number; height: number };
  matte: string | null;
  quality: number | null;
};
export type DocumentExportOptions = RasterExportOptions & {
  scope: { kind: 'visible-document' } | { kind: 'selected-layers'; layerIds: string[]; includeHidden: boolean };
};
export type ExportCancellation = { protocolVersion:1; commandId:string; status:'canceled'|'completed'; receipt:import('./store.js').Receipt };
export function exportOptions(value: any, document: boolean): void {
  keys(value, ['format','resize','matte','quality',...(document?['scope']:[])]);
  ok(value.format==='png'||value.format==='jpeg');
  if(value.resize!==null){keys(value.resize,['width','height']);extent(value.resize.width,value.resize.height);}
  if(value.format==='png')ok(value.matte===null&&value.quality===null);
  else ok(typeof value.matte==='string'&&/^#[a-fA-F0-9]{6}$/.test(value.matte)&&typeof value.quality==='number'&&Number.isFinite(value.quality)&&value.quality>0&&value.quality<=1);
  if(document){
    const scope=value.scope;ok(scope&&typeof scope==='object');
    keys(scope,scope.kind==='visible-document'?['kind']:['kind','layerIds','includeHidden']);
    ok(scope.kind==='visible-document'||scope.kind==='selected-layers');
    if(scope.kind==='selected-layers')ok(Array.isArray(scope.layerIds)&&scope.layerIds.length>0&&scope.layerIds.length<=100&&scope.layerIds.every(id)&&new Set(scope.layerIds).size===scope.layerIds.length&&typeof scope.includeHidden==='boolean');
  }
}
