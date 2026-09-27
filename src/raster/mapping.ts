import {extent} from './core.js';

type Base = {assetId:string;inverted:boolean};
export type MaskMapping = Base & ({mapping:'document-luminance-alpha-v1'|'document-r16-v1'} |
  {mapping:'retained-luminance-alpha-v1'|'retained-r16-v1';offsetX:number;offsetY:number;width:number;height:number;outside:'zero'});
export const retainedMask=(m:MaskMapping):m is Extract<MaskMapping,{outside:'zero'}>=>'outside' in m;
export const r16Mask=(m:MaskMapping)=>m.mapping==='document-r16-v1'||m.mapping==='retained-r16-v1';
export function validateMaskMapping(m:any):asserts m is MaskMapping {
  const retained=['retained-luminance-alpha-v1','retained-r16-v1'].includes(m?.mapping);
  const fields=['assetId','mapping','inverted',...(retained?['offsetX','offsetY','width','height','outside']:[])];
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).length!==fields.length||fields.some(k=>!Object.hasOwn(m,k))||typeof m.assetId!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(m.assetId)||typeof m.inverted!=='boolean'||!['document-luminance-alpha-v1','document-r16-v1','retained-luminance-alpha-v1','retained-r16-v1'].includes(m.mapping))throw Error('MASK_MAPPING');
  if(retained){extent(m.width,m.height);if(m.outside!=='zero'||![m.offsetX,m.offsetY,m.offsetX+m.width,m.offsetY+m.height].every(Number.isSafeInteger))throw Error('MASK_ORIGIN');}
}
export function maskGrid(m:MaskMapping,width:number,height:number){return retainedMask(m)?{x:m.offsetX,y:m.offsetY,width:m.width,height:m.height}:{x:0,y:0,width,height};}
export function translateMask(m:MaskMapping,width:number,height:number,dx:number,dy:number):MaskMapping {
  const g=maskGrid(m,width,height),next:MaskMapping={assetId:m.assetId,inverted:m.inverted,mapping:r16Mask(m)?'retained-r16-v1':'retained-luminance-alpha-v1',offsetX:g.x+dx,offsetY:g.y+dy,width:g.width,height:g.height,outside:'zero'};
  validateMaskMapping(next);return next;
}
