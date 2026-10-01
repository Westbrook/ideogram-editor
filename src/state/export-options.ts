import type {DocumentExportOptions} from '../protocol/export.js';
import type {Document} from '../protocol/store.js';
import type {ImageState} from '../protocol/history.js';

export type ExportForm={scope:'visible-document'|'selected-layers';includeHidden:boolean;format:'png'|'jpeg';dimensions:'native'|'resize';width:string;height:string;matte:string;quality:string};
export function initialExportForm(document:Document):ExportForm{return {scope:'visible-document',includeHidden:false,format:'png',dimensions:'native',width:String(document.width),height:String(document.height),matte:'#FFFFFF',quality:'0.9'};}
export function exportOptions(form:ExportForm,document:Document,image:ImageState|null,selected:readonly string[]):DocumentExportOptions{
 if(!['visible-document','selected-layers'].includes(form.scope)||!['png','jpeg'].includes(form.format)||!['native','resize'].includes(form.dimensions))throw Error('Choose a supported export scope, format and size.');
 const width=form.dimensions==='native'?document.width:Number(form.width),height=form.dimensions==='native'?document.height:Number(form.height);
 if(!form.width.trim()||!form.height.trim()||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height>25_000_000)throw Error('Export dimensions must be whole pixels, at most 8192 per side and 25 million pixels.');
 const ids=[...new Set(selected)],layers=image?.layers??[];
 if(form.scope==='selected-layers'&&(!ids.length||ids.length!==selected.length||ids.some(id=>!layers.some(layer=>layer.id===id))))throw Error('Select the exact layers to include before preparing their composite.');
 if(form.scope==='selected-layers'&&!form.includeHidden&&!layers.some(layer=>ids.includes(layer.id)&&layer.visible))throw Error('No selected layers are visible. Explicitly include hidden selected layers, or change the selection.');
 const matte=form.matte.toUpperCase(),quality=Number(form.quality);
 if(form.format==='jpeg'&&!/^#[0-9A-F]{6}$/.test(matte))throw Error('Enter an opaque sRGB matte as #RRGGBB, for example #FFFFFF.');
 if(form.format==='jpeg'&&(!form.quality.trim()||!Number.isFinite(quality)||quality<=0||quality>1||Math.abs(quality*100-Math.round(quality*100))>1e-8))throw Error('JPEG quality must be 0.01 to 1 in steps of 0.01. The default is 0.9.');
 return {scope:form.scope==='visible-document'?{kind:'visible-document'}:{kind:'selected-layers',layerIds:ids,includeHidden:form.includeHidden},format:form.format,resize:form.dimensions==='native'?null:{width,height},matte:form.format==='jpeg'?matte:null,quality:form.format==='jpeg'?quality:null};
}
