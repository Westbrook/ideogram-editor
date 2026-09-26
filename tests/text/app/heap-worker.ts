import { createTextEngine } from '../../../src/text/engine';
import { LIMITS } from '../../../src/text/contracts';
import { loadBundledFont } from '../../../src/text/bundled-fonts';
const scope=self as unknown as {postMessage(value:unknown):void;close():void};
try {
  const ck=await createTextEngine(), before=ck.HEAPU8.byteLength;
  const within=ck.Malloc(Uint8Array,20*1024**2), pointer=within.byteOffset;
  if(pointer)ck.Free(within);
  const after=ck.HEAPU8.byteLength;
  const refused=ck.Malloc(Uint8Array,LIMITS.wasmBytes+65536), overPointer=refused.byteOffset;
  if(overPointer)ck.Free(refused);
  const font=await loadBundledFont('NotoSans'), provider=ck.TypefaceFontProvider.Make(), collection=ck.FontCollection.Make();
  provider.registerFont(await font.bytes.arrayBuffer(),font.hash);collection.setDefaultFontManager(provider);
  const builder=ck.ParagraphBuilder.MakeFromFontCollection(new ck.ParagraphStyle({textStyle:{fontFamilies:[font.hash],fontSize:20}}),collection);
  builder.addText('office');const paragraph=builder.build();paragraph.layout(300);
  const bounded=paragraph as any;
  const denied=bounded.getShapedLinesBounded(0,20,20),shaped=bounded.getShapedLinesBounded(20,20,20);
  const deniedRects=bounded.getRectsForRangeBounded(0,6,ck.RectHeightStyle.Tight,ck.RectWidthStyle.Tight,0);
  const emptyRects=bounded.getRectsForRangeBounded(6,6,ck.RectHeightStyle.Tight,ck.RectWidthStyle.Tight,0);
  const rects=bounded.getRectsForRangeBounded(0,6,ck.RectHeightStyle.Tight,ck.RectWidthStyle.Tight,20);
  const glyphs=shaped.flatMap((l:any)=>l.runs).reduce((n:number,r:any)=>n+r.glyphs.length,0);
  for(const line of shaped)for(const run of line.runs)run.typeface.delete();
  ck._free(rects.byteOffset);paragraph.delete();builder.delete();collection.delete();provider.delete();ck.purgeOwnedTextCaches();
  scope.postMessage({before,after,final:ck.HEAPU8.byteLength,pointer,overPointer,limit:LIMITS.wasmBytes,denied,deniedRects,emptyRects,glyphs});
}catch(error){scope.postMessage({error:String(error)});}
finally{scope.close();}
