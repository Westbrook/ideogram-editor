// Browser pixels are display-only. Exports always use the retained backend raster.
export class CanvasView {
  private generation=0;
  private image:ImageBitmap|null=null;
  private asset:string|null=null;
  private width=0;
  private height=0;
  constructor(private canvas:HTMLCanvasElement,private transport:(path:string)=>Promise<Response>){}
  async show(asset:string|null,width:number,height:number){
    const generation=++this.generation;
    if(asset===this.asset){this.width=width;this.height=height;return;}
    if(!asset){this.image?.close();this.image=null;this.asset=null;this.width=width;this.height=height;return;}
    const response=await this.transport('/api/v1/assets/'+asset+'/content');
    if(!response.ok)throw Error('CANVAS_CONTENT_UNAVAILABLE');
    const bitmap=await createImageBitmap(await response.blob());
    if(generation!==this.generation){bitmap.close();return;}
    this.image?.close();this.image=bitmap;this.asset=asset;this.width=width;this.height=height;
  }
  point(clientX:number,clientY:number,zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [(clientX-b.left-b.width/2-x)/zoom+this.width/2,(clientY-b.top-b.height/2-y)/zoom+this.height/2];}
  screenPoint(point:readonly [number,number],zoom:number,x:number,y:number):[number,number]{const b=this.canvas.getBoundingClientRect();return [b.left+b.width/2+x+(point[0]-this.width/2)*zoom,b.top+b.height/2+y+(point[1]-this.height/2)*zoom];}
  draw(zoom:number,x:number,y:number,overlay?:(ctx:CanvasRenderingContext2D)=>void){
    const {width,height}=this.canvas.getBoundingClientRect();
    // Viewport storage, independent from document extent; no canvas-based export.
    const ratio=devicePixelRatio||1;
    const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
    if(this.canvas.width!==w)this.canvas.width=w;if(this.canvas.height!==h)this.canvas.height=h;
    const ctx=this.canvas.getContext('2d')!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
    ctx.translate(width/2+x,height/2+y);ctx.scale(zoom,zoom);ctx.translate(-this.width/2,-this.height/2);
    // Checkerboard is presentation; it never enters canonical pixels.
    ctx.fillStyle='#ddd';ctx.fillRect(0,0,this.width,this.height);
    ctx.save();ctx.beginPath();ctx.rect(0,0,this.width,this.height);ctx.clip();
    const side=12/zoom;ctx.fillStyle='#aaa';
    const left=Math.max(0,Math.floor((this.width/2-(width/2+x)/zoom)/side));
    const top=Math.max(0,Math.floor((this.height/2-(height/2+y)/zoom)/side));
    const right=Math.min(Math.ceil(this.width/side),left+Math.ceil(width/zoom/side)+2);
    const bottom=Math.min(Math.ceil(this.height/side),top+Math.ceil(height/zoom/side)+2);
    for(let iy=top;iy<bottom;iy++)for(let ix=left;ix<right;ix++)if((ix+iy)%2)ctx.fillRect(ix*side,iy*side,side,side);
    if(this.image)ctx.drawImage(this.image,0,0);ctx.restore();overlay?.(ctx);
    this.canvas.dataset.asset=this.asset??'';
  }
  dispose(){this.generation++;this.image?.close();this.image=null;}
}
