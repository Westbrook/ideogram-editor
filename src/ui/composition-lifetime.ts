type Payload={release():void;pin():()=>void};
export type CompositionOwner={release(requestRender?:boolean):void;pin():()=>void};
type Entry={payload:Payload;refs:number;root:boolean;releaseRegistration?:()=>void};
/** Finite ownership of actual current, rendered and in-flight control payloads.
 * This stores leases and release callbacks, never a history of model graphs. */
export class CompositionLifetime {
 private entries=new Set<Entry>();private retired=new Set<Entry>();private actions=new Set<Map<Entry,()=>void>>();
 private metadata?:Payload;private rendering?:Promise<void>;private renderFailure:unknown;private requestRender=false;private closing=false;
 constructor(private reserve:(bytes:number)=>Payload,private render:(request:boolean)=>Promise<unknown>){}
 ensure(count=1){if(this.closing)throw Error('COMPOSITION_LIFETIME_CLOSED');if(!Number.isSafeInteger(count)||count<0||this.entries.size+count>96)throw Error('COMPOSITION_MODEL_CAPACITY');this.metadata??=this.reserve(96*256+32*(96*64+1024)+4096);}
 private unref(entry:Entry){if(--entry.refs===0){this.entries.delete(entry);entry.releaseRegistration?.();}}
 private pin(entry:Entry){const release=entry.payload.pin();entry.refs++;let live=true;return ()=>{if(live){live=false;release();this.unref(entry);}};}
 own(payload:Payload,releaseRegistration?:()=>void,inheritActions=true):CompositionOwner{
  this.ensure();const entry:Entry={payload,refs:1,root:true,releaseRegistration};this.entries.add(entry);
  // Earlier actions cannot borrow later render-only allocations. Their initial
  // snapshots and all later domain/model payloads retain the existing pins.
  if(inheritActions)for(const action of this.actions)action.set(entry,this.pin(entry));
  return {pin:()=>{if(!entry.refs)throw Error('COMPOSITION_OWNER_RELEASED');return this.pin(entry);},release:(request=true)=>{if(!entry.root)return;entry.root=false;this.retired.add(entry);this.requestRender||=request;this.schedule();}};
 }
 action(){this.ensure(0);if(this.actions.size>=32)throw Error('COMPOSITION_ACTION_CAPACITY');const pins=new Map<Entry,()=>void>();for(const entry of this.entries)pins.set(entry,this.pin(entry));this.actions.add(pins);let live=true;return ()=>{if(!live)return;live=false;this.actions.delete(pins);for(const release of pins.values())release();pins.clear();};}
 private schedule(){
  if(this.rendering||!this.retired.size)return;
  const pending=Promise.resolve().then(async()=>{
   const batch=[...this.retired],request=this.requestRender;this.requestRender=false;
   try{await this.render(request);for(const entry of batch){this.retired.delete(entry);entry.payload.release();this.unref(entry);}this.renderFailure=undefined;}
   catch(error){this.renderFailure=error;}
  });this.rendering=pending;
  void pending.then(()=>{if(this.rendering===pending)this.rendering=undefined;if(!this.renderFailure&&this.retired.size)this.schedule();});
 }
 async close(){
  this.closing=true;for(const entry of this.entries)if(entry.root){entry.root=false;this.retired.add(entry);}this.requestRender=true;
  if(this.rendering)await this.rendering;this.renderFailure=undefined;this.schedule();if(this.rendering)await this.rendering;
  if(this.retired.size||this.renderFailure)throw new AggregateError(this.renderFailure?[this.renderFailure]:[],'COMPOSITION_RENDER_RELEASE_UNCONFIRMED');
  if(this.actions.size||this.entries.size)throw Error('COMPOSITION_ACTION_RELEASE_UNCONFIRMED');
  this.metadata?.release();this.metadata=undefined;
 }
 get state(){return {owners:this.entries.size,retired:this.retired.size,actions:this.actions.size,renderFailed:this.renderFailure!==undefined};}
}
