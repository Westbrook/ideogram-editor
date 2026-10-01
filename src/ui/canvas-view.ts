// Browser pixels are display-only. Exports always use the retained backend raster.
import {browserPhases} from '../observability/browser.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {DisplayTileCache,readDisplaySource,visibleTiles,viewportBacking,isDisplayAbort,type DisplaySource,type DisplayViewport,type TileSpec} from './display-tiles.js';

export class CanvasView {
  private generation=0;private tileGeneration=0;private source:DisplaySource|null=null;private asset:string|null=null;private width=0;private height=0;
  private canvasLease?:AllocationLease;private cache:DisplayTileCache;private required:TileSpec[]=[];
  private pending=new Set<Promise<void>>();private read?:AbortController;private tileRead?:AbortController;private tileWork?:{key:string;promise:Promise<void>};
  private requested:{asset:string|null;width:number;height:number}|null=null;
  private view:DisplayViewport={width:1,height:1,zoom:1,x:0,y:0,ratio:1};
  private failures=new Set<unknown>();private notified=new Set<unknown>();private failedKey:string|null=null;private failedError:unknown;
  private drawnSource:DisplaySource|null=null;private drawnKey:string|null=null;private releasing?:Promise<void>;private restorationTask?:Promise<void>;
  private ownerSerial=0;private residentSerial:number|null=null;
  private lost=false;private restoring=false;private losses=0;private restorations=0;
  private lastLossMs:number|null=null;private lastRestorationMs:number|null=null;private recoveryError=false;
  private visibleKey(){return this.source?this.source.assetId+':'+this.source.identity+':'+this.required.map(tile=>tile.key).join(','):null;}
  get decodedAssetId(){return !this.lost&&!this.recoveryError&&this.source&&this.drawnSource===this.source&&this.drawnKey===this.visibleKey()&&this.required.length>0&&this.cache.has(this.required)&&!this.cache.ownership.pendingCleanup?this.asset:null;}
  constructor(private canvas:HTMLCanvasElement,private transport:(path:string,init?:RequestInit)=>Promise<Response>,private recovery?:{changed:()=>void;restored:()=>void|Promise<void>;failed:(error:unknown)=>void}){
    this.cache=new DisplayTileCache(transport);
    canvas.addEventListener('contextlost',event=>{
      if(!event.isTrusted)return;
      this.lost=true;this.restoring=false;this.losses++;this.lastLossMs=event.timeStamp;this.generation++;this.abortReads();
      this.asset=null;this.source=null;this.canvas.dataset.asset='';try{this.releaseImages();}catch(error){this.remember(error);}
      this.recovery?.changed();
    });
    canvas.addEventListener('contextrestored',event=>{
      if(!event.isTrusted||!this.lost)return;
      this.lost=false;this.restoring=true;this.restorations++;this.lastRestorationMs=event.timeStamp;this.recoveryError=false;
      const recoveryLoss=this.losses,restoreGeneration=this.generation,target=this.requested;
      const task=(async()=>{try{if(this.releasing||restoreGeneration!==this.generation)return;if(this.recovery)await this.recovery.restored();else if(target)await this.show(target.asset,target.width,target.height);}
        catch(error){if(!isDisplayAbort(error))this.remember(error);}
        finally{if(recoveryLoss===this.losses)this.restoring=false;this.recovery?.changed();}})();
      // Restoration coordinates editor state and may itself call show(). Only
      // its actual show/read owners belong to the release barrier; waiting on
      // this callback as well would let a late show wait on its own release.
      this.restorationTask=task;void task.catch(error=>this.remember(error));
    });
  }
  private remember(error:unknown){if(isDisplayAbort(error))return;this.recoveryError=true;
    if(this.failures.size<64)this.failures.add(error);
    if(!this.notified.has(error)&&this.notified.size<64){this.notified.add(error);try{this.recovery?.failed(error);}catch(failure){if(this.failures.size<64)this.failures.add(failure);}}
  }
  private track(task:Promise<void>){this.pending.add(task);void task.then(()=>this.pending.delete(task),error=>{this.pending.delete(task);this.remember(error);});return task;}
  private async settleTasks(tasks:readonly Promise<void>[]){const failures=(await Promise.allSettled(tasks)).flatMap(result=>result.status==='rejected'&&!isDisplayAbort(result.reason)?[result.reason]:[]);if(failures.length)throw new AggregateError(failures,'DISPLAY_DRAIN_FAILED');}

  get ownership(){const cache=this.cache.ownership;return Object.freeze({schemaVersion:1,generation:this.generation,decodedAssetId:this.decodedAssetId,bitmapSerial:cache.decodedBitmaps?this.residentSerial:null,width:this.width,height:this.height,
    ...cache,pendingReads:this.pending.size,representation:'viewport-tiles' as const,requiredTiles:this.required.length,residentRequiredTiles:this.required.filter(tile=>this.cache.contains(tile.key)).length,visibleComplete:this.decodedAssetId!==null,lod:this.required[0]?.lod??null,
    renderer:'main-thread-canvas-2d' as const,usesBrowserRasterWorker:false,usesOffscreenCanvas:false,contextLost:this.lost,contextRestoring:this.restoring,contextLosses:this.losses,contextRestorations:this.restorations,lastLossMs:this.lastLossMs,lastRestorationMs:this.lastRestorationMs,recoveryError:this.recoveryError});}
  async show(asset:string|null,width:number,height:number,viewport?:Pick<DisplayViewport,'zoom'|'x'|'y'>){
    if(this.releasing)await this.releasing;
    if(viewport)this.view={...this.view,...viewport};
    this.requested={asset,width,height};if(this.lost)throw Error('CANVAS_CONTEXT_LOST');
    const generation=++this.generation,prior=[...this.pending].filter(task=>task!==this.restorationTask);this.abortReads();this.drawnSource=null;this.drawnKey=null;this.failedKey=null;this.failedError=undefined;
    const current=()=>generation===this.generation&&!this.lost;
    const task=(async()=>{
      await this.settleTasks(prior);await this.cache.retryCleanup();if(!current())return;
      if(!asset){this.source=null;this.asset=null;this.width=width;this.height=height;this.releaseImages();this.recoveryError=false;return;}
      if(this.source?.assetId===asset&&this.width===width&&this.height===height){this.measureView();this.cache.reuse(this.required);await this.settleVisible(current);if(current()&&!this.cache.ownership.pendingCleanup){this.recoveryError=false;this.failures.clear();}return;}
      const abort=new AbortController();this.read=abort;
      const source=await readDisplaySource(this.transport,asset,width,height,abort.signal,this.cache.cleanup);if(!current())return;
      this.releaseImages();this.source=source;this.asset=asset;this.width=width;this.height=height;this.residentSerial=null;
      this.measureView();await this.settleVisible(current);if(current()&&!this.cache.ownership.pendingCleanup){this.recoveryError=false;this.failures.clear();}
    })();this.track(task);
    try{await task;}catch(error){if(!isDisplayAbort(error))throw error;}finally{if(generation===this.generation)this.read=undefined;}
  }
  private measureView(){const bounds=this.canvas.getBoundingClientRect();const ratio=typeof devicePixelRatio==='number'&&devicePixelRatio>0?devicePixelRatio:1;const backing=viewportBacking(bounds.width,bounds.height,ratio);this.view={...this.view,width:bounds.width,height:bounds.height,ratio:backing.ratio};}
  private startVisible(){
    const source=this.source;if(!source||this.lost||this.releasing)return Promise.resolve();
    const specs=visibleTiles(source,this.view),key=source.assetId+':'+source.identity+':'+specs.map(tile=>tile.key).join(',');this.required=specs;
    if(this.failedKey===key)return Promise.reject(this.failedError);
    try{this.cache.pin(specs);}catch(error){this.failedKey=key;this.failedError=error;return Promise.reject(error);}
    let previous:Promise<void>|undefined;
    if(this.tileWork&&this.tileWork.key!==key){previous=this.tileWork.promise;this.tileRead?.abort();this.tileGeneration++;this.tileWork=undefined;}
    if(this.tileWork?.key===key)return this.tileWork.promise;
    if(this.cache.has(specs)&&!previous&&!this.cache.ownership.pendingCleanup)return Promise.resolve();
    this.tileRead?.abort();const abort=new AbortController(),epoch=++this.tileGeneration;this.tileRead=abort;
    const owns=()=>!this.lost&&!this.releasing&&this.source===source&&epoch===this.tileGeneration&&!abort.signal.aborted;
    const promise=(async()=>{
      if(previous)await this.settleTasks([previous]);await this.cache.retryCleanup();if(!owns())return;
      // Native decode/cancel cleanup from the retired viewport settles before
      // this owner starts new work, even when the required tiles are cached.
      for(const spec of specs){if(!owns())return;await this.cache.load(source,spec,abort.signal,owns);if(!owns())return;if(this.cache.ownership.decodedBitmaps&&this.residentSerial===null)this.residentSerial=++this.ownerSerial;this.recovery?.changed();}
      if(owns()){this.recoveryError=false;this.recovery?.changed();}
    })().catch(error=>{if(!isDisplayAbort(error)){if(owns()){this.failedKey=key;this.failedError=error;}throw error;}}).finally(()=>{if(this.tileWork?.promise===promise)this.tileWork=undefined;});
    this.tileWork={key,promise};this.track(promise);return promise;
  }
  private async settleVisible(current:()=>boolean){const source=this.source;for(;;){if(!current())return;await this.startVisible();if(!current()||this.source!==source||this.lost||this.cache.has(this.required))return;}}
  point(clientX:number,clientY:number,zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [(clientX-b.left-b.width/2-x)/zoom+this.width/2,(clientY-b.top-b.height/2-y)/zoom+this.height/2];}
  screenPoint(point:readonly [number,number],zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [b.left+b.width/2+x+(point[0]-this.width/2)*zoom,b.top+b.height/2+y+(point[1]-this.height/2)*zoom];}
  draw(zoom:number,x:number,y:number,overlay?:(ctx:CanvasRenderingContext2D)=>void){
    this.drawnSource=null;this.drawnKey=null;this.canvas.dataset.asset='';
    if(this.lost||this.releasing)return false;
    const work=browserPhases.recorder.start('frame.app_work',this.asset?{assetId:this.asset}:{});let complete=false;
    try{
      if(!this.width||!this.height){this.resizeCanvas(1,1);this.canvas.dataset.asset='';complete=true;return true;}
      const {width,height}=this.canvas.getBoundingClientRect(),ratio=typeof devicePixelRatio==='number'&&devicePixelRatio>0?devicePixelRatio:1,backing=viewportBacking(width,height,ratio);
      this.view={width,height,zoom,x,y,ratio:backing.ratio};
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
      for(const tile of this.cache.tiles().sort((a,b)=>b.lod-a.lod))ctx.drawImage(tile.bitmap,0,0,tile.width,tile.height,tile.sourceX,tile.sourceY,tile.sourceWidth,tile.sourceHeight);
      ctx.restore();overlay?.(ctx);complete=true;
      const ready=!this.recoveryError&&!this.cache.ownership.pendingCleanup&&(this.required.length===0||this.cache.has(this.required));
      this.drawnSource=ready?this.source:null;this.drawnKey=ready?this.visibleKey():null;this.canvas.dataset.asset=this.decodedAssetId??'';return ready;
    }finally{work.end(complete?'incomplete':'error',{boundary:'render-submitted'});}
  }
  get lifecycle(){return {decodedBitmaps:this.cache.ownership.decodedBitmaps,pendingReads:this.pending.size,canvasBytes:this.canvas.width*this.canvas.height*4};}
  releaseDocument(){if(this.releasing)return this.releasing;
    this.releasing=(async()=>{const failures=new Set<unknown>();
      try{this.dispose();}catch(error){failures.add(error);}
      // Aborted reads may settle into a failed native close after the first
      // cache clear. Drain every owner, then retry those actual closes/unlocks.
      while(this.pending.size){const results=await Promise.allSettled([...this.pending]);for(const result of results)if(result.status==='rejected'&&!isDisplayAbort(result.reason))failures.add(result.reason);}
      for(const error of this.failures)failures.add(error);this.failures.clear();
      try{await this.cache.retryCleanup();}catch(error){failures.add(error);}
      try{this.releaseImages();}catch(error){failures.add(error);}
      try{this.resizeCanvas(1,1);this.canvasLease?.release();this.canvasLease=undefined;}catch(error){this.canvasLease?.markUnused();failures.add(error);}
      if(failures.size)throw new AggregateError([...failures],'CANVAS_RELEASE_FAILED');this.recoveryError=false;this.notified.clear();
    })().finally(()=>{this.releasing=undefined;});return this.releasing;
  }
  private releaseImages(){this.required=[];this.residentSerial=null;this.drawnSource=null;this.drawnKey=null;this.cache.clear();}
  private abortReads(){this.read?.abort();this.read=undefined;this.tileRead?.abort();this.tileRead=undefined;this.tileGeneration++;this.tileWork=undefined;}
  private resizeCanvas(width:number,height:number){
    const bytes=width*height*4;if(!Number.isSafeInteger(bytes)||bytes<4||width>8192||height>8192||width*height>16*1024**2)throw Error('CANVAS_DIMENSIONS');
    // Canvas2D has no owned texture API. Both possible native CPU/GPU backing
    // allowances are reserved; they are not claimed physical driver bytes.
    const peak=Math.max(bytes,width*this.canvas.height*4,this.canvas.width*this.canvas.height*4);
    if(this.canvasLease)this.canvasLease.resize({cpuBytes:peak,gpuBytes:peak});else this.canvasLease=allocationLedger.reserve({owner:'canvas-viewport',kind:'canvas',cpuBytes:peak,gpuBytes:peak,handles:1});
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;this.canvasLease.resize({cpuBytes:bytes,gpuBytes:bytes});
  }
  dispose(){this.generation++;this.requested=null;this.abortReads();this.source=null;this.asset=null;this.width=0;this.height=0;this.failedKey=null;this.failedError=undefined;this.drawnSource=null;this.drawnKey=null;this.canvas.dataset.asset='';
    const failures:unknown[]=[];try{this.releaseImages();}catch(error){failures.push(error);}
    try{this.resizeCanvas(1,1);this.canvasLease?.release();this.canvasLease=undefined;}catch(error){this.canvasLease?.markUnused();failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'CANVAS_RELEASE_FAILED');
  }
}
