import { isId } from '../storage/canonical.js';
import { keys, requireValue as ok } from '../../src/protocol/validate.js';

// Imported exports have no new AssetRegistered event in the destination
// journal. This inert relation preserves their document ownership on re-copy.
export type RetainedExport = {id:string;documentId:string;assetId:string};
export function retainedExport(value:unknown):asserts value is RetainedExport {
 const v=value as RetainedExport;keys(v,['id','documentId','assetId']);
 ok(isId(v.id)&&isId(v.documentId)&&v.assetId===v.id);
}
