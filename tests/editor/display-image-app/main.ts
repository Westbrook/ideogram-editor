import {html,nothing,render,type RootPart} from 'lit';
import {displayImage} from '../../../src/ui/display-image.js';
import {createDisplayPreviewURL,displayPreviewOwnership,revokeDisplayPreviewURL,validateDisplayImage} from '../../../src/observability/display-preview.js';
import {allocationLedger} from '../../../src/observability/allocations.js';
import {DISPLAY_HEADERS,DISPLAY_PROFILE,displayPath} from '../../../src/protocol/display.js';

const host=document.querySelector<HTMLElement>('#fixture')!;
let part:RootPart=render(nothing,host),url='',htmlLoads=0,svgLoads=0;
const requests:string[]=[],errors:string[]=[];
host.addEventListener('ie-display-error',event=>errors.push((event as CustomEvent<{message:string}>).detail.message));
const htmlLoaded=()=>{htmlLoads++;},svgLoaded=()=>{svgLoads++;};
function snapshot(){
  const image=host.querySelector('img'),svg=host.querySelector('image'),ledger=allocationLedger.snapshot();
  return {url,src:image?.getAttribute('src')??null,href:svg?.getAttribute('href')??null,htmlCount:host.querySelectorAll('img').length,svgCount:host.querySelectorAll('image').length,
    htmlLoads,svgLoads,requests:[...requests],errors:[...errors],ownership:displayPreviewOwnership(),
    ledger:{cpuBytes:ledger.cpuBytes,gpuBytes:ledger.gpuBytes,previewCacheBytes:ledger.previewCacheBytes,handles:ledger.handles,activeRecords:ledger.activeRecords,bitmap:ledger.byKind.bitmap,blob:ledger.byKind.blob}};
}
const fixture={
  snapshot,
  async prepare(input:{bytes:number[];hash:string;identity:string}){
    if(url)throw Error('FIXTURE_ALREADY_PREPARED');
    const source={assetId:'fixture-rgba',basis:'pixels' as const,identity:input.identity,width:1,height:1};
    const expected=displayPath(source.assetId,{kind:'preview',edge:256,basis:source.basis,identity:source.identity});
    const headers={
      'Content-Type':'image/png','Content-Length':String(input.bytes.length),ETag:'"'+input.hash+'"',
      [DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:source.identity,[DISPLAY_HEADERS.basis]:'pixels',
      [DISPLAY_HEADERS.width]:'1',[DISPLAY_HEADERS.height]:'1',[DISPLAY_HEADERS.sourceWidth]:'1',[DISPLAY_HEADERS.sourceHeight]:'1',[DISPLAY_HEADERS.lod]:'0',
    };
    // Only the transport is substituted. The production parser, SHA check,
    // createImageBitmap, Blob URL and HTML/SVG decoders are unmodified.
    url=await createDisplayPreviewURL(async(path,init)=>{
      if(path!==expected||!init?.signal||init.signal.aborted)throw Error('FIXTURE_DISPLAY_REQUEST');
      requests.push(path);return new Response(Uint8Array.from(input.bytes),{headers});
    },source,{owner:'display-image-fixture',edge:256});
    return snapshot();
  },
  mount(mode:'html'|'aliases'|'svg'|'empty'){
    const showHTML=mode==='html'||mode==='aliases',showSVG=mode==='svg'||mode==='aliases';
    part=render(html`<section>
      ${showHTML?html`<img alt="HTML preview alias" src=${displayImage(url)} @load=${htmlLoaded}>`:nothing}
      ${showSVG?html`<svg width="1" height="1" aria-label="SVG preview alias"><image width="1" height="1" href=${displayImage(url)} @load=${svgLoaded}></image></svg>`:nothing}
    </section>`,host);
    return snapshot();
  },
  connected(value:boolean){
    const image=host.querySelector('img'),svg=host.querySelector('image');
    // Exercise Lit's public RootPart lifecycle while retaining the same DOM.
    part.setConnected(value);
    return {...snapshot(),sameHTML:image===host.querySelector('img'),sameSVG:svg===host.querySelector('image')};
  },
  async decodeHTML(){
    const images=[...host.querySelectorAll('img')];if(!images.length)throw Error('FIXTURE_NO_HTML_IMAGE');
    return Promise.all(images.map(async image=>{await image.decode();validateDisplayImage(image,url);return {width:image.naturalWidth,height:image.naturalHeight,src:image.currentSrc};}));
  },
  revoke(){revokeDisplayPreviewURL(url);return snapshot();},
  clear(){part.setConnected(false);render(nothing,host);revokeDisplayPreviewURL(url);return snapshot();},
};
export type DisplayImageFixture=typeof fixture;
declare global{interface Window{displayImageFixture:DisplayImageFixture;}}
window.displayImageFixture=fixture;
