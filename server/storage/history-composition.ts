import type {BlobRef} from '../../src/protocol/store.js';
import type {CompositionRef} from '../../src/composition/core.js';
import {validateCompositionRef} from '../../src/composition/core.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {lineageRecord} from '../portable/lineage.js';
import {canonical} from '../../src/protocol/json.js';
import type {Objects} from './objects.js';
import {readRequestBytes} from './request-review.js';

/** Only exact, typed Composition value edges use the existing 1 MiB reader.
 * Text sources, authored leaves and every other metadata ref retain the
 * ordinary Objects read limit. readComposition still checks ID and bindings. */
export function historyCompositionReader(objects:Objects,compositions:readonly (CompositionRef|null|undefined)[]):(ref:BlobRef)=>Uint8Array {
  const values=new Set<string>();
  for(const composition of compositions)if(composition){validateCompositionRef(composition);values.add(canonical(composition.value));}
  return ref=>values.has(canonical(ref))?readRequestBytes(objects,ref,1048576):objects.verify(ref,true)!;
}

/** Original namespace IDs remain inert. Only the two validated record types
 * that own a CompositionRef may select the larger typed metadata boundary. */
export function retainedCompositionReference(value:unknown):CompositionRef|null {
  if(!value||typeof value!=='object')return null;
  if('kind'in value&&value.kind==='adopted-candidate-lineage-1'){
    lineageRecord(value);return value.result.request.specification.settings.prompt.composition;
  }
  if('schemaVersion'in value&&'layers'in value&&Array.isArray(value.layers)&&'width'in value&&Number.isSafeInteger(value.width)&&'height'in value&&Number.isSafeInteger(value.height)){
    imageState(value);return value.composition??null;
  }
  return null;
}
