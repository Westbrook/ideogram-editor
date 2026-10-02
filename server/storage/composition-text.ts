import type {BlobRef} from '../../src/protocol/store.js';
import type {ImageState} from '../../src/protocol/history.js';
import type {Asset} from '../../src/protocol/assets.js';
import type {Draft} from '../../src/request/family.js';
import {isV45Draft} from '../../src/request/family.js';
import {RequestError} from '../../src/request/core.js';
import {v45PromptShape,type V45Prompt} from '../../src/request/v45-prompt.js';
import {assertCompositionTextReview,verifyCompositionTextReview} from '../../src/composition/text-export.js';
import {canonical} from '../../src/protocol/json.js';
import {compositionRefs,withLayerValues,readComposition,verifyReview} from './composition.js';
import {AssetRejection} from './assets.js';
import {StoreError} from './errors.js';
import type {CompositionMemory} from './composition-memory.js';

type Read=(ref:BlobRef)=>Uint8Array;
/** Frozen provenance only. Logical source IDs are not resolved into a current
 * document here; saving/importing a retained draft never grants live authority. */
export function readCompositionTextSource(prompt:V45Prompt,read:Read){
 try{
  v45PromptShape(prompt);if(prompt.projection===null)return null;
  const composition=readComposition(prompt.composition,read);
  verifyReview(composition,read);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read(prompt.text));
  verifyCompositionTextReview(composition,prompt.projection,text);
  const refs=[prompt.composition.value,prompt.text,...compositionRefs(composition)];
  return {composition,prompt:text,refs:[...new Map(refs.map(ref=>[canonical(ref),ref])).values()]};
 }catch(error){if(error instanceof StoreError)throw error;throw new AssetRejection('INVALID_INPUT','COMPOSITION_TEXT_EVIDENCE_MISMATCH');}
}
/** The source graph can name opaque authored leaves that are not present in the
 * request envelope. Keep those leaves owned by every saved/queued export. */
export function compositionTextOriginRefs(draft:Draft,read:Read):BlobRef[]{
 return isV45Draft(draft)?readCompositionTextSource(draft.prompt,read)?.refs??[]:[];
}
/** Review and queue admission additionally prove the exact current source and
 * all included layer links. This grants no provider composition semantics. */
export function assertCurrentCompositionText(draft:Draft,state:ImageState,read:Read,asset:(id:string)=>Asset|null,memory:CompositionMemory):void{
 if(!isV45Draft(draft)||draft.prompt.projection===null)return;
 try{
  if(!state.composition||canonical(state.composition)!==canonical(draft.prompt.composition))throw Error('COMPOSITION_TEXT_SOURCE_CHANGED');
  const prompt=draft.prompt,composition=state.composition;
  memory.compositions([prompt.composition],()=>{
   const retained=readCompositionTextSource(prompt,read)!;
   withLayerValues(state,read,asset,memory,layers=>assertCompositionTextReview(retained.composition,layers,composition.bindings,prompt.projection!,retained.prompt));
  });
 }catch(error){if(error instanceof StoreError)throw error;throw new RequestError([{field:'prompt',code:'COMPOSITION_TEXT_CHANGED',message:'Export and approve the current Composition as text again before reviewing this request.'}]);}
}
