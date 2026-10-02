import type {LitElement} from 'lit';
import {modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';

/** UI roots stay reachable and charged through actual Lit replacement. Failed
 * commits retain the same root for an explicit retry; actions are separate. */
export class DialogOwnership{
  private models=new Set<OwnedModel<unknown>>();
  private retired=new Map<OwnedModel<unknown>,{pending?:Promise<void>;failed:boolean}>();
  private actions=0;private actionWaiters=new Set<Promise<void>>();
  constructor(private host:Pick<LitElement,'requestUpdate'|'updateComplete'>,private name:string){}
  create<T>(allowance:number,create:()=>T):OwnedModel<T>{
    if(this.models.size>=32)throw Error('DIALOG_MODEL_LIMIT');
    const lease=reserveModelBytes(this.name,allowance);let model:OwnedModel<T>;
    try{const value=create(),bytes=modelPayloadBytes(value);if(bytes>allowance)throw Error('DIALOG_MODEL_ALLOWANCE');let refs=1,live=true;
      const drop=()=>{if(!--refs){this.models.delete(model);lease.release();}};
      model=Object.freeze({value,release:()=>{if(live){live=false;drop();}},pin:()=>{if(!refs)throw Error('DIALOG_MODEL_RELEASED');refs++;let held=true;return ()=>{if(held){held=false;drop();}};}});
      this.models.add(model);return model;
    }catch(error){lease.release();throw error;}
  }
  action(models:readonly (OwnedModel<unknown>|null)[],metadata:unknown){
    if(this.actions>=8)throw Error('DIALOG_ACTION_LIMIT');
    const lease=reserveModelBytes(this.name+'-action',modelPayloadBytes(metadata),1),pins:Array<()=>void>=[];
    try{for(const model of models)if(model)pins.push(model.pin());}catch(error){for(const release of pins)release();lease.release();throw error;}
    this.actions++;let done!:()=>void;const waiting=new Promise<void>(resolve=>{done=resolve;});this.actionWaiters.add(waiting);let live=true;return ()=>{if(!live)return;live=false;for(const release of pins)release();lease.release();this.actions--;this.actionWaiters.delete(waiting);done();};
  }
  retire(model:OwnedModel<unknown>,schedule=true):Promise<void>{
    let record=this.retired.get(model);if(record?.pending)return record.pending;
    if(!record){record={failed:false};this.retired.set(model,record);}
    const retained=record;let update:Promise<unknown>;
    // Register before calling user/host code, including synchronous failures.
    try{if(schedule)this.host.requestUpdate();update=this.host.updateComplete;}catch(error){update=Promise.reject(error);}
    const pending=Promise.resolve(update).then(()=>{model.release();this.retired.delete(model);},error=>{retained.failed=true;throw error;}).finally(()=>{if(retained.pending===pending)retained.pending=undefined;});
    retained.pending=pending;void pending.catch(()=>{});return pending;
  }
  async drainRetired(){
    await Promise.allSettled([...this.retired.values()].flatMap(record=>record.pending?[record.pending]:[]));
    const outcomes=await Promise.allSettled([...this.retired.keys()].map(model=>this.retire(model)));
    const errors=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected').map(value=>value.reason);
    if(errors.length)throw new AggregateError(errors,'DIALOG_RENDER_RELEASE_FAILED');
  }
  async drain(){while(this.actionWaiters.size)await Promise.allSettled([...this.actionWaiters]);await this.drainRetired();}
  get lifecycle(){return {models:this.models.size,retiring:this.retired.size,failed:[...this.retired.values()].filter(record=>record.failed).length,actions:this.actions};}
}
