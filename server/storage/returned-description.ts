import type {DatabaseSync} from 'node:sqlite';
import type {Objects} from './objects.js';
import type {Document,BlobRef} from '../../src/protocol/store.js';
import type {TextSource} from '../../src/protocol/text.js';
import type {ReturnedDescriptionReview,ReturnedTextOrigin} from '../../src/text/returned-description.js';
import {verifyReturnedDescriptionReview,validateReturnedDescriptionReview,validateReturnedTextOrigin} from '../../src/text/returned-description.js';
import {canonical} from './canonical.js';
import {AssetRejection} from './assets.js';
import {retainedRasterMetadata} from '../portable/retained.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {StoreError} from './errors.js';

/** Carry only the immutable description origin across an appearance edit.
 * Raster-retention nodes describe prior pixels and cannot be relabeled as new ones. */
export function returnedTextOriginRoot(objects:Objects,root:BlobRef|undefined):BlobRef|null {
 const seen=new Set<string>();let ref=root??null;
 while(ref){if(seen.size>=4096||seen.has(ref.hash))throw new StoreError('CORRUPT_OBJECT');seen.add(ref.hash);
  const value=parseControlJSON(objects.verify(ref,true)!);
  if(value?.kind==='created-text-description-1'){validateReturnedTextOrigin(value);return ref;}
  retainedRasterMetadata(value);ref=value.previous;
 }
 return null;
}

/** Resolves only local retained provenance. No URL, provider or decoder access. */
export function assertReturnedDescriptionOwner(db:DatabaseSync,review:ReturnedDescriptionReview,document:Pick<Document,'id'|'revision'>){
 validateReturnedDescriptionReview(review);
 if(review.documentId!==document.id||review.documentRevision!==document.revision)throw new AssetRejection('STALE_REVISION','RETURNED_TEXT_TARGET_CHANGED');
 if(db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(document.id))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
 const live=db.prepare("SELECT json FROM candidate_jobs WHERE json_extract(json,'$.jobId')=? AND json_extract(json,'$.attemptId')=? LIMIT 1").get(review.jobId,review.attemptId);
 const imported=live?null:db.prepare("SELECT json FROM portable_rows WHERE kind='job-result' AND json_extract(json,'$.jobId')=? AND id=? LIMIT 1").get(review.jobId,review.attemptId);
 const row=live??imported;if(!row)throw new AssetRejection('MISSING_ASSET','RETURNED_DESCRIPTION_UNAVAILABLE');
 const result=JSON.parse(String(row.json)),provenance=result.provenance;
 // A retained caption is a text source, never an image safety authorization.
 if(result.documentId!==document.id||!provenance||provenance.schemaVersion===2||!provenance.complete||provenance.quarantined||provenance.inspection!=='supported'||!provenance.returnedPrompt||canonical(provenance.returnedPrompt)!==canonical(review.returnedPrompt))throw new AssetRejection('INCOMPATIBLE','SUPPORTED_RETURNED_DESCRIPTION_REQUIRED');
 return result;
}

/** Called inside the prepared text transaction and rechecked before commit. */
export async function prepareReturnedTextOrigin(input:{db:DatabaseSync;objects:Objects;review:ReturnedDescriptionReview;document:Pick<Document,'id'|'revision'>;source:TextSource;sourceRef:BlobRef;layerId:string;protect:(ref:BlobRef)=>Promise<void>;check:()=>void}):Promise<ReturnedTextOrigin>{
 const {db,objects,review,document,source,sourceRef,layerId,protect,check}=input;
 assertReturnedDescriptionOwner(db,review,document);await protect(review.returnedPrompt);await protect(review.literal);await protect(sourceRef);check();
 const bytes=objects.readRange(review.returnedPrompt,'0',Number(review.returnedPrompt.byteLength));
 try{verifyReturnedDescriptionReview(review,bytes,source);}catch{throw new AssetRejection('INVALID_INPUT','RETURNED_DESCRIPTION_REVIEW_CHANGED');}
 assertReturnedDescriptionOwner(db,review,document);
 return {schemaVersion:1,kind:'created-text-description-1',review:structuredClone(review),createdLayerId:layerId,createdSource:sourceRef};
}
