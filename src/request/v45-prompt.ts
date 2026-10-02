import type {BlobRef} from '../protocol/store.js';
import type {CompositionRef} from '../composition/core.js';
import {validateCompositionRef} from '../composition/core.js';
import type {CompositionTextReview} from '../composition/text-export.js';
import {validateCompositionTextReview} from '../composition/text-export.js';
import {canonical} from '../protocol/json.js';
import {blob,keys,requireValue as ok} from '../protocol/validate.js';

/** Explicit local text export is a plain prompt with retained source evidence. */
export type V45Prompt=
 |{mode:'plain'|'raw';text:BlobRef;projection:null;composition:null}
 |{mode:'plain';text:BlobRef;projection:CompositionTextReview;composition:CompositionRef};

export function v45PromptShape(prompt:any):asserts prompt is V45Prompt {
 keys(prompt,['mode','text','projection','composition']);ok(['plain','raw'].includes(prompt.mode));blob(prompt.text);ok(prompt.text.mediaType==='text/plain'&&BigInt(prompt.text.byteLength)<=16777216n);
 if(prompt.projection===null||prompt.composition===null){ok(prompt.projection===null&&prompt.composition===null);return;}
 ok(prompt.mode==='plain');validateCompositionRef(prompt.composition);validateCompositionTextReview(prompt.projection);
 ok(prompt.composition.id===prompt.projection.sourceId&&prompt.projection.sourceProjection.sourceId===prompt.composition.id&&canonical(prompt.projection.prompt)===canonical(prompt.text));
}
export function v45PromptRefs(prompt:V45Prompt):BlobRef[]{
 v45PromptShape(prompt);return [prompt.text,...(prompt.projection?[prompt.composition.value,prompt.projection.sourceProjection.prompt]:[])];
}
