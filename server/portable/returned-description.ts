import type {BlobRef} from '../../src/protocol/store.js';
import {validateReturnedTextOrigin,verifyReturnedDescriptionReview} from '../../src/text/returned-description.js';
import {validateSource} from '../text/validation.js';
import {canonical,hashBytes} from '../storage/canonical.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {invalid} from './zip.js';

/** Inert provenance validation, with no job, render, upload or provider authority. */
export async function validateReturnedTextObservation(value:unknown,read:(ref:BlobRef)=>Promise<Uint8Array>){
 try{
  validateReturnedTextOrigin(value);
  const exact=async(ref:BlobRef)=>{const bytes=await read(ref);if(String(bytes.byteLength)!==ref.byteLength||hashBytes(bytes)!==ref.hash)invalid();return bytes;};
  const sourceBytes=await exact(value.createdSource),source=validateSource(parseControlJSON(sourceBytes));
  if(canonical(source)!==Buffer.from(sourceBytes).toString('utf8'))invalid();
  const prompt=await exact(value.review.returnedPrompt);await exact(value.review.literal);
  verifyReturnedDescriptionReview(value.review,prompt,source);
 }catch{invalid();}
}
