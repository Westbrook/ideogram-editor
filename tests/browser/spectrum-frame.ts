import type {Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import sharp from 'sharp';
export type Frame={data:Buffer;timestamp:number;viewportWidth:number;viewportHeight:number};
type Cast={start:(options:{onFrame:(frame:Frame)=>void;size:{width:number;height:number};quality:number})=>Promise<unknown>;stop:()=>Promise<void>};
export async function bounded<T>(work:Promise<T>,ms:number,label:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),Math.max(0,ms));})]);}
 finally{if(timer)clearTimeout(timer);}
}
export async function freshFrame(cast:Cast,size:{width:number;height:number},after:number,waitMs=4500,stopMs=500){
 let accept!:(frame:Frame)=>void;let reject!:(error:Error)=>void;let result:Frame|undefined;let error:unknown;
 const discarded:{timestamp:number;reason:string}[]=[];
 const frame=new Promise<Frame>((resolve,fail)=>{accept=resolve;reject=fail;});
 // A callback can fail while start is still pending; attach a handler immediately.
 void frame.catch(()=>{});
 const onFrame=(value:Frame)=>{
  if(!Number.isFinite(value.timestamp)){reject(Error('Invalid frame timestamp'));return;}
  if(value.timestamp<after){discarded.push({timestamp:value.timestamp,reason:'stale'});return;}
  if(value.viewportWidth!==size.width||value.viewportHeight!==size.height){reject(Error('Frame viewport mismatch'));return;}
  if(!value.data.length){reject(Error('Empty frame'));return;}
  accept(value);
 };
 try{result=await bounded((async()=>{await cast.start({onFrame,size,quality:100});return await frame;})(),waitMs,'Fresh frame deadline');}
 catch(e){error=e;}
 try{await bounded(cast.stop(),stopMs,'Screencast stop deadline');}
 catch(e){error=error?new AggregateError([error,e],'Capture and stop failed'):e;}
 if(error)throw error;
 return {frame:result!,discarded};
}
async function state(page:Page){
 const dom=await page.evaluate(()=>({appearance:document.documentElement.dataset.enAppearance,theme:document.documentElement.dataset.enTheme,background:getComputedStyle(document.documentElement).backgroundColor,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,path:location.pathname,activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id}));
 const dialogs=await page.getByRole('dialog').evaluateAll(nodes=>nodes.map(n=>({label:n.getAttribute('aria-label'),labelledby:n.getAttribute('aria-labelledby'),text:n.textContent})));
 return {dom,dialogs};
}
export async function captureFrame(page:Page,path:string,record:(value:unknown)=>Promise<void>){
 const deadline=Date.now()+5000;
 await bounded(page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));}),deadline-Date.now(),'Capture readiness deadline');
 const before=await state(page);const start=Date.now();const size={width:before.dom.width,height:before.dom.height};
 const result=await freshFrame(page.screencast,size,start,Math.max(0,deadline-Date.now()-500),500);
 const after=await state(page);
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Capture checkpoint state changed');
 const actual=await sharp(result.frame.data).metadata();
 if(actual.format!=='jpeg'||actual.width!==size.width||actual.height!==size.height)throw Error('Captured JPEG dimensions mismatch');
 await writeFile(path,result.frame.data);
 await record({phase:'frame',path,start,frameTimestamp:result.frame.timestamp,completed:Date.now(),viewport:size,actual:{format:actual.format,width:actual.width,height:actual.height},quality:100,before,after,discarded:result.discarded,limitation:'Viewport JPEG, not full-page or pixel-exact color evidence'});
}
