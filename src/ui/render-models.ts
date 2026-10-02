import {allocationLedger} from '../observability/allocations.js';
export type RenderModel={value:object;pin:()=>()=>void};
export const MAX_RENDER_MODEL_ROOTS=16;
export const RENDER_MODEL_LIMIT=MAX_RENDER_MODEL_ROOTS*3;
/** Pins actual template aliases, including scalar values, across replacement.
 * commit() is called by Lit's updated hook only after both render roots commit.
 * A failed render retains every attempted root until a successful replacement
 * or an explicit, successful clearing of the actual native render roots. */
export class RenderModelOwners {
 private held=new Map<object,{unpin:()=>void;lease:ReturnType<typeof allocationLedger.reserve>}>();private target=new Set<object>();private pending=false;
 begin(models:readonly RenderModel[]){
  const target=new Set(models.map(model=>model.value)),added:object[]=[];
  if(target.size>MAX_RENDER_MODEL_ROOTS)throw Error('EDITOR_RENDER_MODEL_COUNT');
  if(new Set([...this.held.keys(),...target]).size>RENDER_MODEL_LIMIT)throw Error('The previous editor render has not released its models. Retry closing the document.');
  try{for(const model of models){if(this.held.has(model.value))continue;const lease=allocationLedger.reserve({owner:'editor-render-model-borrow',kind:'control',cpuBytes:16,handles:1});let unpin:()=>void;try{unpin=model.pin();}catch(error){lease.release();throw error;}this.held.set(model.value,{unpin,lease});added.push(model.value);}}
  catch(error){for(const value of added)this.drop(value);throw error;}
  this.target=target;this.pending=true;
 }
 private drop(value:object){const entry=this.held.get(value);if(!entry)return;entry.unpin();entry.lease.release();this.held.delete(value);}
 commit(){for(const value of this.held.keys())if(!this.target.has(value))this.drop(value);this.pending=false;}
 clear(){for(const value of this.held.keys())this.drop(value);this.target.clear();this.pending=false;}
 get ownership(){return {roots:this.held.size,pending:this.pending};}
}
