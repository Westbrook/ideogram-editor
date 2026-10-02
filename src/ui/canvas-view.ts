// Browser pixels are display-only. Exports always use the retained backend raster.
import {browserPhases} from '../observability/browser.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {DisplayTileCache,readOwnedDisplaySource,ownedVisibleTiles,viewportBacking,isDisplayAbort,type DisplaySource,type DisplayViewport,type TileSpec} from './display-tiles.js';
import {ownDisplayControl} from '../observability/display-control.js';
import {reserveModelBytes,type ModelPayload,type OwnedModel} from '../observability/model-memory.js';

export class CanvasView {
  private generation=0;private tileGeneration=0;private source:DisplaySource|null=null;private asset:string|null=null;private width=0;private height=0;
  private canvasLease?:AllocationLease;private cache:DisplayTileCache;private required:readonly TileSpec[]=[];
  private sourceOwner?:OwnedModel<DisplaySource>;private requiredOwner?:OwnedModel<readonly TileSpec[]>;private keyOwner?:OwnedModel<string>;
  private serviceControl?:ModelPayload;
  private suspended=false;private retired=false;private retirementComplete=false;private retirement?:Promise<void>;private suspension?:Promise<void>;private ownerEpoch=0;
  private onContextLost!:EventListener;private onContextRestored!:EventListener;
  private pending=new Set<Promise<void>>();private read?:AbortController;private tileRead?:AbortController;private tileWork?:{key:string;promise:Promise<void>};
  private showWork?:{asset:string|null;width:number;height:number;generation:number;promise:Promise<void>;users:number};
  private requestedOwner?:OwnedModel<{asset:string|null;width:number;height:number}>;
  private get requested(){return this.requestedOwner?.value??null;}
  private setRequested(asset:string|null,width:number,height:number){const next=ownDisplayControl('canvas-request',2048,()=>({asset,width,height})),prior=this.requestedOwner;this.requestedOwner=next;prior?.release();}
  private clearRequested(){const prior=this.requestedOwner;this.requestedOwner=undefined;prior?.release();}
  private viewOwner?:OwnedModel<DisplayViewport>;
  private get view(){return this.viewOwner!.value;}
  private setView(create:()=>DisplayViewport){const next=ownDisplayControl('canvas-view',1024,create),prior=this.viewOwner;this.viewOwner=next;prior?.release();}
  private failures=new Set<unknown>();private notified=new Set<unknown>();private failedKey:string|null=null;private failedError:unknown;
  private drawnSource:DisplaySource|null=null;private drawnKey:string|null=null;private drawnKeyPin?:()=>void;private failedKeyPin?:()=>void;private releasing?:Promise<void>;private restorationTask?:Promise<void>;
  private ownerSerial=0;private residentSerial:number|null=null;
  private lost=false;private restoring=false;private losses=0;private restorations=0;
  private lastLossMs:number|null=null;private lastRestorationMs:number|null=null;private recoveryError=false;
  private setDrawnKey(owner?:OwnedModel<string>){const next=owner?.pin(),prior=this.drawnKeyPin;this.drawnKey=owner?.value??null;this.drawnKeyPin=next;prior?.();}
  private setFailedKey(owner?:OwnedModel<string>,error?:unknown){const next=owner?.pin(),prior=this.failedKeyPin;this.failedKey=owner?.value??null;this.failedKeyPin=next;this.failedError=error;prior?.();}
  private visibleKey(){return this.source?this.keyOwner?.value??null:null;}
  get decodedAssetId(){return !this.suspended&&!this.lost&&!this.recoveryError&&this.source&&this.drawnSource===this.source&&this.drawnKey===this.visibleKey()&&this.required.length>0&&this.cache.has(this.required)&&!this.cache.ownership.pendingCleanup?this.asset:null;}
  constructor(private canvas:HTMLCanvasElement,private transport:(path:string,init?:RequestInit)=>Promise<Response>,private recovery?:{changed:()=>void;restored:()=>void|Promise<void>;failed:(error:unknown)=>void}){
    this.cache=new DisplayTileCache(transport);
    try{this.serviceControl=reserveModelBytes('canvas-service',4096,2);this.viewOwner=ownDisplayControl('canvas-view',1024,()=>({width:1,height:1,zoom:1,x:0,y:0,ratio:1}));
    // The existing element may still have its HTML default extent. Book that
    // exact extent before any context acquisition, resize, or rendering.
    this.resizeCanvas(Math.max(1,canvas.width),Math.max(1,canvas.height));
    this.onContextLost=event=>{
      if(this.suspended||!event.isTrusted)return;
      this.lost=true;this.restoring=false;this.losses++;this.lastLossMs=event.timeStamp;this.generation++;this.abortReads();
      this.asset=null;this.source=null;this.canvas.dataset.asset='';try{this.releaseImages();}catch(error){this.remember(error);}
      this.recovery?.changed();
    };
    this.onContextRestored=event=>{
      if(this.suspended||!event.isTrusted||!this.lost)return;
      this.lost=false;this.restoring=true;this.restorations++;this.lastRestorationMs=event.timeStamp;this.recoveryError=false;
      const recoveryLoss=this.losses,restoreGeneration=this.generation,target=this.requested,releaseTarget=this.requestedOwner?.pin();
      const task=(async()=>{try{if(this.releasing||restoreGeneration!==this.generation)return;if(this.recovery)await this.recovery.restored();else if(target)await this.show(target.asset,target.width,target.height);}
        catch(error){if(!isDisplayAbort(error))this.remember(error);}
        finally{releaseTarget?.();if(recoveryLoss===this.losses)this.restoring=false;this.recovery?.changed();}})();
      // Restoration coordinates editor state and may itself call show(). Only
      // its actual show/read owners belong to the release barrier; waiting on
      // this callback as well would let a late show wait on its own release.
      this.restorationTask=task;void task.catch(error=>this.remember(error));
    };
    this.attachListeners();
    }catch(error){this.suspended=true;try{if(this.onContextLost)this.canvas.removeEventListener('contextlost',this.onContextLost);if(this.onContextRestored)this.canvas.removeEventListener('contextrestored',this.onContextRestored);this.canvas.width=0;this.canvas.height=0;this.canvasLease?.release();this.canvasLease=undefined;this.serviceControl?.release();this.viewOwner?.release();}catch(cleanup){this.canvasLease?.markUnused();throw new AggregateError([error,cleanup],'CANVAS_CONSTRUCTION_CLEANUP');}throw error;}
  }
  private attachListeners(){this.serviceControl!.resize(4096,2);this.canvas.addEventListener('contextlost',this.onContextLost);this.canvas.addEventListener('contextrestored',this.onContextRestored);}
  private detachListeners(){this.canvas.removeEventListener('contextlost',this.onContextLost);this.canvas.removeEventListener('contextrestored',this.onContextRestored);this.serviceControl!.resize(4096,0);}
  /** Detaching the shell ends native display ownership; document close does not.
   * A remount waits this exact drain before readmitting the same canvas. */
  suspend(){this.suspended=true;this.ownerEpoch++;if(this.retirementComplete)return Promise.resolve();if(this.suspension)return this.suspension;
    const task=(async()=>{await this.releaseDocument();this.detachListeners();try{this.canvas.width=0;this.canvas.height=0;}catch(error){this.canvasLease?.markUnused();throw error;}this.canvasLease?.release();this.canvasLease=undefined;})();
    const settled=task.finally(()=>{if(this.suspension===settled)this.suspension=undefined;});this.suspension=settled;return settled;
  }
  async resume(){if(this.retired)throw new DOMException('Canvas owner is retired.','AbortError');const epoch=++this.ownerEpoch;await this.suspension;if(this.retired)throw new DOMException('Canvas owner is retired.','AbortError');if(epoch!==this.ownerEpoch||!this.suspended)return;this.resizeCanvas(1,1);this.attachListeners();if(epoch!==this.ownerEpoch)return;this.suspended=false;}
  retire(){this.retired=true;if(this.retirementComplete)return Promise.resolve();if(this.retirement)return this.retirement;const task=(async()=>{await this.suspend();this.serviceControl?.release();this.serviceControl=undefined;const view=this.viewOwner;this.viewOwner=undefined;view?.release();this.retirementComplete=true;})();const settled=task.finally(()=>{if(this.retirement===settled)this.retirement=undefined;});this.retirement=settled;return settled;}
  private currentOwner(){if(this.retired||this.suspended)throw new DOMException('Canvas owner is suspended.','AbortError');}

  private remember(error:unknown){if(isDisplayAbort(error))return;this.recoveryError=true;
    if(this.failures.size<64)this.failures.add(error);
    if(!this.notified.has(error)&&this.notified.size<64){this.notified.add(error);try{this.recovery?.failed(error);}catch(failure){if(this.failures.size<64)this.failures.add(failure);}}
  }
  private track(task:Promise<void>){this.pending.add(task);void task.then(()=>this.pending.delete(task),error=>{this.pending.delete(task);this.remember(error);});return task;}
  private async settleTasks(tasks:readonly Promise<void>[]){const failures=(await Promise.allSettled(tasks)).flatMap(result=>result.status==='rejected'&&!isDisplayAbort(result.reason)?[result.reason]:[]);if(failures.length)throw new AggregateError(failures,'DISPLAY_DRAIN_FAILED');}

  get ownership(){const cache=this.cache.ownership;return Object.freeze({schemaVersion:1,generation:this.generation,decodedAssetId:this.decodedAssetId,bitmapSerial:cache.decodedBitmaps?this.residentSerial:null,width:this.width,height:this.height,
    ...cache,pendingReads:this.pending.size,representation:'viewport-tiles' as const,suspended:this.suspended,requiredTiles:this.required.length,residentRequiredTiles:this.required.reduce((count,tile)=>count+(this.cache.contains(tile.key)?1:0),0),visibleComplete:this.decodedAssetId!==null,lod:this.required[0]?.lod??null,
    renderer:'main-thread-canvas-2d' as const,usesBrowserRasterWorker:false,usesOffscreenCanvas:false,contextLost:this.lost,contextRestoring:this.restoring,contextLosses:this.losses,contextRestorations:this.restorations,lastLossMs:this.lastLossMs,lastRestorationMs:this.lastRestorationMs,recoveryError:this.recoveryError});}
  async show(asset:string|null,width:number,height:number,viewport?:Pick<DisplayViewport,'zoom'|'x'|'y'>){
    this.currentOwner();if(asset!==null&&!/^[A-Za-z0-9_-]{1,128}$/.test(asset))throw Error('DISPLAY_SOURCE');
    // Each pending slot covers our input/result/failure indices and bounded
    // control records; native Promise implementation storage is excluded.
    const control=reserveModelBytes('canvas-show-work',4096+this.pending.size*256);
    try{return await this.showOwned(asset,width,height,viewport);}finally{control.release();}
  }
  private async showOwned(asset:string|null,width:number,height:number,viewport?:Pick<DisplayViewport,'zoom'|'x'|'y'>){
    if(this.releasing)await this.releasing;this.currentOwner();
    if(viewport)this.setView(()=>({...this.view,...viewport}));
    this.setRequested(asset,width,height);if(this.lost)throw Error('CANVAS_CONTEXT_LOST');
    const active=this.showWork;
    if(active&&active.generation===this.generation&&active.asset===asset&&active.width===width&&active.height===height){
      // A repeated presentation of the same immutable source shares its live
      // read. A genuine viewport change still updates the required tile set;
      // the joined caller drains its requested visible work before completing.
      active.users++;let visible:Promise<void>|undefined;
      try{
        if(this.source?.assetId===asset&&this.width===width&&this.height===height){this.measureView();visible=this.startVisible();void visible.catch(error=>this.remember(error));}
        // Superseding the old viewport may abort its read. Still drain the
        // joined viewport work before reporting this presentation complete.
        await this.settleTasks(visible?[active.promise,visible]:[active.promise]);
      }catch(error){if(!isDisplayAbort(error))throw error;}
      finally{if(!--active.users&&this.showWork===active)this.showWork=undefined;}return;
    }
    const generation=++this.generation,prior=[...this.pending].filter(task=>task!==this.restorationTask);this.abortReads();this.drawnSource=null;this.setDrawnKey();this.setFailedKey();
    const current=()=>generation===this.generation&&!this.lost&&!this.suspended;
    const task=(async()=>{
      await this.settleTasks(prior);await this.cache.retryCleanup();if(!current())return;
      if(!asset){this.source=null;this.asset=null;this.width=width;this.height=height;this.releaseImages();this.recoveryError=false;return;}
      if(this.source?.assetId===asset&&this.width===width&&this.height===height){this.measureView();this.cache.reuse(this.required);await this.settleVisible(current);if(current()&&!this.cache.ownership.pendingCleanup){this.recoveryError=false;this.failures.clear();}return;}
      const abort=new AbortController();this.read=abort;
      const owned=await readOwnedDisplaySource(this.transport,asset,width,height,abort.signal,this.cache.cleanup);
      if(!current()){owned.release();return;}
      try{this.releaseImages();}catch(error){owned.release();throw error;}
      this.sourceOwner=owned;this.source=owned.value;this.asset=asset;this.width=width;this.height=height;this.residentSerial=null;
      this.measureView();await this.settleVisible(current);if(current()&&!this.cache.ownership.pendingCleanup){this.recoveryError=false;this.failures.clear();}
    })();const work={asset,width,height,generation,promise:task,users:1};this.showWork=work;this.track(task);
    try{await task;}catch(error){if(!isDisplayAbort(error))throw error;}finally{if(!--work.users&&this.showWork===work)this.showWork=undefined;if(generation===this.generation)this.read=undefined;}
  }
  private measureView(){const bounds=this.canvas.getBoundingClientRect();const ratio=typeof devicePixelRatio==='number'&&devicePixelRatio>0?devicePixelRatio:1;const backing=viewportBacking(bounds.width,bounds.height,ratio);this.setView(()=>({...this.view,width:bounds.width,height:bounds.height,ratio:backing.ratio}));}
  private startVisible(){
    const source=this.source,sourceOwner=this.sourceOwner;if(!source||!sourceOwner||this.suspended||this.lost||this.releasing)return Promise.resolve();
    const batch=ownedVisibleTiles(source,this.view),specs=batch.value;let keyOwner:OwnedModel<string>;
    try{const keyBytes=source.assetId.length+source.identity.length+2+specs.reduce((n,tile)=>n+tile.key.length+1,0);keyOwner=ownDisplayControl('canvas-visible-key',512+keyBytes*4+specs.length*8,()=>source.assetId+':'+source.identity+':'+specs.map(tile=>tile.key).join(','));}catch(error){batch.release();throw error;}
    const priorBatch=this.requiredOwner,priorKey=this.keyOwner;this.requiredOwner=batch;this.keyOwner=keyOwner;this.required=specs;priorBatch?.release();priorKey?.release();const key=keyOwner.value;
    if(this.failedKey===key)return Promise.reject(this.failedError);
    try{this.cache.pin(specs);}catch(error){this.setFailedKey(keyOwner,error);return Promise.reject(error);}
    let previous:Promise<void>|undefined;
    if(this.tileWork&&this.tileWork.key!==key){previous=this.tileWork.promise;this.tileRead?.abort();this.tileGeneration++;this.tileWork=undefined;}
    if(this.tileWork?.key===key)return this.tileWork.promise;
    if(this.cache.has(specs)&&!previous&&!this.cache.ownership.pendingCleanup)return Promise.resolve();
    this.tileRead?.abort();const abort=new AbortController(),epoch=++this.tileGeneration;this.tileRead=abort;
    const owns=()=>!this.suspended&&!this.lost&&!this.releasing&&this.source===source&&epoch===this.tileGeneration&&!abort.signal.aborted;
    const control=reserveModelBytes('canvas-tile-work',2048+key.length*2),releaseSource=sourceOwner.pin(),releaseBatch=batch.pin(),releaseKey=keyOwner.pin();
    const promise=(async()=>{
      if(previous)await this.settleTasks([previous]);await this.cache.retryCleanup();if(!owns())return;
      // Native decode/cancel cleanup from the retired viewport settles before
      // this owner starts new work, even when the required tiles are cached.
      for(const spec of specs){if(!owns())return;await this.cache.load(source,spec,abort.signal,owns);if(!owns())return;if(this.cache.ownership.decodedBitmaps&&this.residentSerial===null)this.residentSerial=++this.ownerSerial;this.recovery?.changed();}
      if(owns()){this.recoveryError=false;this.recovery?.changed();}
    })().catch(error=>{if(!isDisplayAbort(error)){if(owns()){this.setFailedKey(keyOwner,error);}throw error;}}).finally(()=>{if(this.tileWork?.promise===promise)this.tileWork=undefined;releaseKey();releaseBatch();releaseSource();control.release();});
    this.tileWork={key,promise};this.track(promise);return promise;
  }
  private async settleVisible(current:()=>boolean){const source=this.source,release=this.sourceOwner?.pin();try{for(;;){if(!current())return;await this.startVisible();if(!current()||this.source!==source||this.lost||this.cache.has(this.required))return;}}finally{release?.();}}
  point(clientX:number,clientY:number,zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [(clientX-b.left-b.width/2-x)/zoom+this.width/2,(clientY-b.top-b.height/2-y)/zoom+this.height/2];}
  screenPoint(point:readonly [number,number],zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [b.left+b.width/2+x+(point[0]-this.width/2)*zoom,b.top+b.height/2+y+(point[1]-this.height/2)*zoom];}
  draw(zoom:number,x:number,y:number,overlay?:(ctx:CanvasRenderingContext2D)=>void){
    this.drawnSource=null;this.setDrawnKey();this.canvas.dataset.asset='';
    if(this.suspended||this.lost||this.releasing)return false;
    const work=browserPhases.recorder.start('frame.app_work',this.asset?{assetId:this.asset}:{});let complete=false;
    try{
      if(!this.width||!this.height){this.resizeCanvas(1,1);this.canvas.dataset.asset='';complete=true;return true;}
      const {width,height}=this.canvas.getBoundingClientRect(),ratio=typeof devicePixelRatio==='number'&&devicePixelRatio>0?devicePixelRatio:1,backing=viewportBacking(width,height,ratio);
      this.setView(()=>({width,height,zoom,x,y,ratio:backing.ratio}));
      void this.startVisible().catch(error=>this.remember(error));
      this.resizeCanvas(backing.width,backing.height);
      const ctx=this.canvas.getContext('2d');if(!ctx||ctx.isContextLost?.())return false;
      ctx.setTransform(backing.width/Math.max(1,width),0,0,backing.height/Math.max(1,height),0,0);ctx.clearRect(0,0,width,height);
      ctx.translate(width/2+x,height/2+y);ctx.scale(zoom,zoom);ctx.translate(-this.width/2,-this.height/2);
      ctx.fillStyle='#ddd';ctx.fillRect(0,0,this.width,this.height);ctx.save();ctx.beginPath();ctx.rect(0,0,this.width,this.height);ctx.clip();
      const side=12/zoom;ctx.fillStyle='#aaa';const left=Math.max(0,Math.floor((this.width/2-(width/2+x)/zoom)/side)),top=Math.max(0,Math.floor((this.height/2-(height/2+y)/zoom)/side));
      const right=Math.min(Math.ceil(this.width/side),left+Math.ceil(width/zoom/side)+2),bottom=Math.min(Math.ceil(this.height/side),top+Math.ceil(height/zoom/side)+2);
      for(let iy=top;iy<bottom;iy++)for(let ix=left;ix<right;ix++)if((ix+iy)%2)ctx.fillRect(ix*side,iy*side,side,side);
      // Cached lower resolution tiles fill gaps during pan/zoom. Draw the exact
      // required LOD last, with each tile mapped to its original pixel extent.
      this.cache.withTiles(tiles=>{for(const tile of tiles.sort((a,b)=>b.lod-a.lod))ctx.drawImage(tile.bitmap,0,0,tile.width,tile.height,tile.sourceX,tile.sourceY,tile.sourceWidth,tile.sourceHeight);});
      ctx.restore();overlay?.(ctx);complete=true;
      const ready=!this.recoveryError&&!this.cache.ownership.pendingCleanup&&(this.required.length===0||this.cache.has(this.required));
      this.drawnSource=ready?this.source:null;this.setDrawnKey(ready?this.keyOwner:undefined);this.canvas.dataset.asset=this.decodedAssetId??'';return ready;
    }finally{work.end(complete?'incomplete':'error',{boundary:'render-submitted'});}
  }
  get lifecycle(){return {decodedBitmaps:this.cache.ownership.decodedBitmaps,pendingReads:this.pending.size,canvasBytes:this.canvas.width*this.canvas.height*4};}
  releaseDocument(){if(this.releasing)return this.releasing;
    const control=reserveModelBytes('canvas-release-work',4096+this.pending.size*256);
    this.releasing=(async()=>{const failures=new Set<unknown>();
      try{this.dispose();}catch(error){failures.add(error);}
      // Aborted reads may settle into a failed native close after the first
      // cache clear. Drain every owner, then retry those actual closes/unlocks.
      while(this.pending.size){const results=await Promise.allSettled([...this.pending]);for(const result of results)if(result.status==='rejected'&&!isDisplayAbort(result.reason))failures.add(result.reason);}
      for(const error of this.failures)failures.add(error);this.failures.clear();
      try{await this.cache.retryCleanup();}catch(error){failures.add(error);}
      try{this.releaseImages();}catch(error){failures.add(error);}
      try{if(!this.suspended||this.canvasLease)this.resizeCanvas(1,1);}catch(error){this.canvasLease?.markUnused();failures.add(error);}
      if(failures.size)throw new AggregateError([...failures],'CANVAS_RELEASE_FAILED');this.recoveryError=false;this.notified.clear();
    })().finally(()=>{this.releasing=undefined;control.release();});return this.releasing;
  }
  private releaseImages(){const batch=this.requiredOwner,key=this.keyOwner,source=this.sourceOwner;this.requiredOwner=undefined;this.keyOwner=undefined;this.sourceOwner=undefined;this.required=[];this.source=null;this.residentSerial=null;this.drawnSource=null;this.setDrawnKey();this.setFailedKey();batch?.release();key?.release();source?.release();this.cache.clear();}
  private abortReads(){this.read?.abort();this.read=undefined;this.tileRead?.abort();this.tileRead=undefined;this.tileGeneration++;this.tileWork=undefined;}
  private resizeCanvas(width:number,height:number){
    const bytes=width*height*4;if(!Number.isSafeInteger(bytes)||bytes<4||width>8192||height>8192||width*height>16*1024**2)throw Error('CANVAS_DIMENSIONS');
    // Canvas2D has no owned texture API. Both possible native CPU/GPU backing
    // allowances are reserved; they are not claimed physical driver bytes.
    const peak=Math.max(bytes,width*this.canvas.height*4,this.canvas.width*this.canvas.height*4);
    if(this.canvasLease)this.canvasLease.resize({cpuBytes:peak,gpuBytes:peak});else this.canvasLease=allocationLedger.reserve({owner:'canvas-viewport',kind:'canvas',cpuBytes:peak,gpuBytes:peak,handles:1});
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;this.canvasLease.resize({cpuBytes:bytes,gpuBytes:bytes});
  }
  dispose(){this.generation++;this.clearRequested();this.abortReads();this.source=null;this.asset=null;this.width=0;this.height=0;this.setFailedKey();this.drawnSource=null;this.setDrawnKey();this.canvas.dataset.asset='';
    const failures:unknown[]=[];try{this.releaseImages();}catch(error){failures.push(error);}
    try{if(!this.suspended||this.canvasLease)this.resizeCanvas(1,1);}catch(error){this.canvasLease?.markUnused();failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'CANVAS_RELEASE_FAILED');
  }
}
