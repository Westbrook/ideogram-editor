export type DocumentResource = {release():void|Promise<void>; inspect():Readonly<Record<string,number|boolean>>};

// Application consumers register ownership, not GC estimates. A settled release
// means their references/handles have been dropped; process RSS is measured by
// the independent qualification observer after the prescribed idle interval.
export class DocumentResources {
  private resources=new Map<string,DocumentResource>();
  private pending?:Promise<void>;
  private releases=0;
  private failed=false;
  private lastReleaseMilliseconds:number|null=null;
  register(name:string,resource:DocumentResource){
    if(this.resources.has(name))throw Error('DOCUMENT_RESOURCE_ALREADY_REGISTERED');
    this.resources.set(name,resource);return ()=>{if(this.resources.get(name)===resource)this.resources.delete(name);};
  }
  release(){
    if(this.pending)return this.pending;
    const started=performance.now();
    this.pending=(async()=>{
      const results=await Promise.allSettled([...this.resources.values()].map(async resource=>resource.release()));
      const errors=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
      if(errors.length){this.failed=true;throw new AggregateError(errors.map(r=>r.reason),'DOCUMENT_RESOURCE_RELEASE_FAILED');}
      this.failed=false;this.releases++;this.lastReleaseMilliseconds=performance.now()-started;
    })().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  get snapshot(){return {releasing:!!this.pending,failed:this.failed,releases:this.releases,lastReleaseMilliseconds:this.lastReleaseMilliseconds,
    consumers:Object.fromEntries([...this.resources].map(([name,resource])=>[name,resource.inspect()]))};}
}
