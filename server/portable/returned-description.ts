import type {BlobRef} from '../../src/protocol/store.js';
import {validateReturnedTextOrigin,verifyReturnedDescriptionReview,validateReturnedTextSplitOrigin,inspectReturnedDescription} from '../../src/text/returned-description.js';
import {textDraft,textSplitPlan} from '../../src/protocol/text.js';
import type {TextCandidate} from '../../src/protocol/text.js';
import {keys,id,seq,requireValue as ok} from '../../src/protocol/validate.js';
import {planTextSplit} from '../../src/text/split.js';
import {validateSource,dependencyIdentity} from '../text/validation.js';
import {canonical,hashBytes} from '../storage/canonical.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {invalid} from './zip.js';

/** Inert provenance validation, with no job, render, upload or provider authority. */
export async function validateReturnedTextObservation(value:unknown,read:(ref:BlobRef)=>Promise<Uint8Array>){
 if(value&&typeof value==='object'&&'kind'in value&&value.kind==='created-text-split-description-1')return validateReturnedTextSplitObservation(value,read);
 try{
  validateReturnedTextOrigin(value);
  const exact=async(ref:BlobRef)=>{const bytes=await read(ref);if(String(bytes.byteLength)!==ref.byteLength||hashBytes(bytes)!==ref.hash)invalid();return bytes;};
  const sourceBytes=await exact(value.createdSource),source=validateSource(parseControlJSON(sourceBytes));
  if(canonical(source)!==Buffer.from(sourceBytes).toString('utf8'))invalid();
  const prompt=await exact(value.review.returnedPrompt);await exact(value.review.literal);
  verifyReturnedDescriptionReview(value.review,prompt,source);
 }catch{invalid();}
}

/** A retained candidate envelope is inert metadata, never a render admission. */
export function validateRetainedTextCandidate(value:unknown):TextCandidate{
 const candidate=value as TextCandidate;keys(candidate,['schemaVersion','token','source']);ok(candidate.schemaVersion===1);
 const token=candidate.token;keys(token,['documentId','documentRevision','layerId','layerVersion','sessionId','generation']);
 ok(id(token.documentId)&&seq(token.documentRevision)&&id(token.layerId)&&seq(token.layerVersion)&&id(token.sessionId)&&Number.isSafeInteger(token.generation)&&token.generation>=0);
 validateSource(candidate.source);return candidate;
}

/** Verify one complete retained split without resolving historical IDs into
 * local documents, jobs, layers, admissions, or provider authority. */
export async function validateReturnedTextSplitObservation(value:unknown,read:(ref:BlobRef)=>Promise<Uint8Array>,check:()=>void=()=>{}){
 try{
  validateReturnedTextSplitOrigin(value);
  const exact=async(ref:BlobRef,limit:number)=>{check();if(BigInt(ref.byteLength)>BigInt(limit))invalid();const bytes=await read(ref);check();if(String(bytes.byteLength)!==ref.byteLength||hashBytes(bytes)!==ref.hash)invalid();return bytes;};
  const metadata=async(ref:BlobRef)=>{const bytes=await exact(ref,65536),parsed=parseControlJSON(bytes);if(canonical(parsed)!==Buffer.from(bytes).toString('utf8'))invalid();return parsed;};
  const saved=await metadata(value.draft);textDraft(saved);if(saved.kind!=='text-draft-3')return invalid();
  const plan=await metadata(value.plan);textSplitPlan(plan);const description=plan.description;
  if(canonical(plan.originalText)!==canonical(saved.textUtf8)||!description||canonical(description)!==canonical(saved.description))return invalid();
  const original=await exact(plan.originalText,1048576),ranges=planTextSplit(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original),plan.parts.length);
  if(ranges.length!==plan.parts.length||ranges.some((range,index)=>range.startByte!==plan.parts[index].startByte||range.endByte!==plan.parts[index].endByte))invalid();
  const prompt=await exact(description.returnedPrompt,262144),inspection=inspectReturnedDescription(prompt);
  if(inspection.state!=='available'||!inspection.elements.some(element=>element.index===description.elementIndex&&element.elementHash===description.elementHash))invalid();
  let sharedToken:string|undefined;
  for(const part of plan.parts){
   check();const candidate=validateRetainedTextCandidate(await metadata(part.candidate)),token=candidate.token,source=candidate.source;
   const binding=canonical({documentId:token.documentId,documentRevision:token.documentRevision,sessionId:token.sessionId,generation:token.generation});
   if(sharedToken===undefined)sharedToken=binding;else if(binding!==sharedToken)invalid();
   if(token.layerId!==part.layerId||token.layerVersion!=='0'||canonical(source.text.style)!==canonical(saved.style)||canonical(source.text.frame)!==canonical(saved.frame)||canonical(source.text.fonts)!==canonical(saved.fonts)||
    source.render.dependencyHash!==part.reviewedDependencyHash||source.render.pixels.hash!==part.reviewedRasterHash||dependencyIdentity(source)!==source.render.dependencyHash)invalid();
   const text=await exact(source.text.textUtf8,16384),expected=original.subarray(part.startByte,part.endByte);
   if(text.byteLength!==expected.byteLength||!text.every((byte,index)=>byte===expected[index]))invalid();
  }
 }catch{invalid();}
}
