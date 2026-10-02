import type {Document} from '../protocol/store.js';
import type {ImageLayer} from '../protocol/history.js';
import {cloneOwnedModel,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {allocationLedger} from '../observability/allocations.js';
import {friendlyTransform,changedFriendlyTransform,inspectorMatrix,FRIENDLY_NUMERIC_UNITS,validateIntrinsicExtent,type IntrinsicExtent} from './inspector-transform.js';
import {jsonPayloadUnits} from '../observability/prompt-memory.js';
export type InspectorValues={name:string;appearance:string;opacity:string;visible:boolean;locked:boolean;a:string;b:string;c:string;d:string;x:string;y:string;width:string;height:string;rotation:string;transformInput:'matrix'|'friendly'};
export type InspectorSnapshot={layer:Pick<ImageLayer,'id'|'version'|'kind'|'name'|'locked'|'assetId'>;intrinsic:{status:'unread'|'requested'}|({status:'ready'}&IntrinsicExtent);document:Pick<Document,'id'|'revision'>;values:InspectorValues;dirty:boolean;draftId:string};
export const INSPECTOR_MODEL_BYTES=512*1024;
export function ownInspector(value:InspectorSnapshot):OwnedModel<InspectorSnapshot>{if(modelPayloadBytes(value)>INSPECTOR_MODEL_BYTES)throw Error('Inspector text exceeds the local editing allowance. Shorten the field; the previous draft is retained.');return cloneOwnedModel('editor-inspector',value);}
export function newInspector(layer:ImageLayer,document:Document,draftId:string,extent?:IntrinsicExtent){const [a,b,c,d,x,y]=layer.layerToDocument;const values:InspectorValues={appearance:layer.appearanceDescription??'',name:layer.name,opacity:String(layer.opacity),visible:layer.visible,locked:layer.locked,a:String(a),b:String(b),c:String(c),d:String(d),x:String(x),y:String(y),width:'',height:'',rotation:'',transformInput:'matrix'};if(extent)Object.assign(values,friendlyTransform(values,extent));return ownInspector({layer:{id:layer.id,version:layer.version,kind:layer.kind,name:layer.name,locked:layer.locked,assetId:layer.assetId},intrinsic:extent?{status:'ready',...extent}:{status:'unread'},document:{id:document.id,revision:document.revision},dirty:false,draftId,values});}
export function friendlyInspectorAvailable(value:InspectorSnapshot){if(value.intrinsic.status!=='ready')return false;try{friendlyTransform(value.values,value.intrinsic);return true;}catch{return false;}}
export function changedInspector(value:InspectorSnapshot,key:keyof InspectorValues,input:string|boolean){
 const values={...value.values,[key]:input} as InspectorValues;
 if(key==='width'||key==='height'||key==='rotation'){
  if(typeof input!=='string'||input.length>FRIENDLY_NUMERIC_UNITS)throw Error('Keep each numeric transform field within 128 characters. The previous draft is retained.');
  if(!friendlyInspectorAvailable(value))throw Error('Friendly transform controls need valid layer dimensions and an invertible matrix.');values.transformInput='friendly';
  // Incomplete numeric text is a real owned draft. Keep it for correction and
  // block Apply; only complete valid values update the advanced coefficients.
  try{const m=changedFriendlyTransform(value.values,value.intrinsic as IntrinsicExtent,values);values.a=String(m[0]);values.b=String(m[1]);values.c=String(m[2]);values.d=String(m[3]);}catch{/* Validation occurs on Apply; entered text stays retained. */}
 }else if(['a','b','c','d'].includes(key)){values.transformInput='matrix';if(value.intrinsic.status==='ready')try{Object.assign(values,friendlyTransform(values,value.intrinsic));}catch{values.width='';values.height='';values.rotation='';}}
 return ownInspector({...value,values,dirty:true});
}
export function inspectorTransform(value:InspectorSnapshot){if(value.values.transformInput==='friendly'){if(value.intrinsic.status!=='ready')throw Error('Load layer dimensions before applying this transform.');return changedFriendlyTransform(value.values,value.intrinsic,value.values);}return inspectorMatrix(value.values);}
export function sizedInspector(value:InspectorSnapshot,extent:IntrinsicExtent){validateIntrinsicExtent(extent);const values={...value.values};if(values.transformInput==='matrix')try{Object.assign(values,friendlyTransform(values,extent));}catch{values.width='';values.height='';values.rotation='';}return ownInspector({...value,values,intrinsic:{status:'ready',width:extent.width,height:extent.height}});}
export function serializedInspector(values:InspectorValues){const lease=allocationLedger.reserve({owner:'editor-inspector-wire',kind:'control',cpuBytes:jsonPayloadUnits(values)*2,handles:1});try{return {wire:JSON.stringify(values),release:()=>lease.release()};}catch(error){lease.release();throw error;}}
export function restoredInspector(prior:InspectorSnapshot,text:string,revision:string,draftId:string){
 if(text.length*2>INSPECTOR_MODEL_BYTES)throw Error('Saved inspector fields exceed the local editing allowance. The previous draft is retained.');
 const workspace=allocationLedger.reserve({owner:'editor-inspector-parse',kind:'scratch',cpuBytes:text.length*6+4096,handles:2});
 try{const parsed=JSON.parse(text) as Record<string,unknown>,values={...prior.values};for(const key in values){const name=key as keyof InspectorValues,value=parsed[name];if(['appearance','width','height','rotation','transformInput'].includes(name)&&value===undefined)continue;if(typeof value!==typeof values[name])throw Error('Inspector draft retained, but its fields are unavailable.');(values as Record<string,unknown>)[name]=value;}if(!['matrix','friendly'].includes(values.transformInput)||[values.width,values.height,values.rotation].some(value=>value.length>FRIENDLY_NUMERIC_UNITS))throw Error('Inspector transform draft is unavailable.');if(values.transformInput==='matrix'&&prior.intrinsic.status==='ready')try{Object.assign(values,friendlyTransform(values,prior.intrinsic));}catch{values.width='';values.height='';values.rotation='';}return ownInspector({...prior,values,dirty:true,draftId,document:{id:prior.document.id,revision}});}finally{workspace.release();}
}
