// R33 admission counts operate on the complete recoverable draft. They never
// encode, normalize, truncate, or replace the native textarea's string.
export const TEXT_ADMISSION = Object.freeze({layerBytes:16384,layerLines:256,documentBytes:1048576,layers:100});
export type DraftTextUsage={bytes:number;lines:number;scalars:number;validUnicode:boolean;requiresLFConversion:boolean};
export type TextSplitRange={startByte:number;endByte:number;start16:number;end16:number;bytes:number;lines:number};
export function scanDraftText(text:string):DraftTextUsage{
 let bytes=0,lines=1,scalars=0,validUnicode=true,requiresLFConversion=false;
 for(let at=0;at<text.length;){const cp=text.codePointAt(at)!;if(cp>=0xd800&&cp<=0xdfff)validUnicode=false;if(cp===13)requiresLFConversion=true;if(cp===10)lines++;bytes+=cp<128?1:cp<2048?2:cp<65536?3:4;scalars++;at+=cp>65535?2:1;}
 return {bytes,lines,scalars,validUnicode,requiresLFConversion};
}
// This is a proposed, explicitly reviewed partition, not automatic editing or
// a claim that browser ICU is the pinned native shaper. The writer recomputes
// these same ranges; an ICU boundary disagreement refuses the whole command.
export function planTextSplit(text:string,maxParts:number=TEXT_ADMISSION.layers):TextSplitRange[]{
 const usage=scanDraftText(text);
 if(!usage.validUnicode)throw Error('TEXT_SURROGATE');
 if(usage.requiresLFConversion)throw Error('TEXT_REQUIRES_REVIEWED_LF_CONVERSION');
 if(usage.bytes>TEXT_ADMISSION.documentBytes)throw Error('TEXT_DOCUMENT_BYTES');
 if(!text.length)throw Error('TEXT_SPLIT_EMPTY');
 if(!Number.isInteger(maxParts)||maxParts<1||maxParts>TEXT_ADMISSION.layers)throw Error('TEXT_SPLIT_LAYER_LIMIT');
 const full=Symbol('split-layer-limit');
 const partition=(preferLines:boolean):TextSplitRange[]=>{
 const result:TextSplitRange[]=[];
 let start16=0,startByte=0,startLF=0,bytes=0,lineFeeds=0,lastLine16=0,lastLineByte=0,lastLineLF=0;
 const append=(end16:number,endByte:number,endLF:number)=>{
  if(end16<=start16)throw Error('TEXT_SPLIT_GRAPHEME_LIMIT');if(result.length>=maxParts)throw full;
  const range={startByte,endByte,start16,end16,bytes:endByte-startByte,lines:endLF-startLF+1};
  if(range.bytes>TEXT_ADMISSION.layerBytes||range.lines>TEXT_ADMISSION.layerLines)throw Error('TEXT_SPLIT_GRAPHEME_LIMIT');
  result.push(range);start16=end16;startByte=endByte;startLF=endLF;
 };
 for(const part of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)){
  const count=scanDraftText(part.segment),end16=part.index+part.segment.length;
  if(count.bytes>TEXT_ADMISSION.layerBytes||count.lines>TEXT_ADMISSION.layerLines)throw Error('TEXT_SPLIT_GRAPHEME_LIMIT');
  if(bytes+count.bytes-startByte>TEXT_ADMISSION.layerBytes||lineFeeds+count.lines-1-startLF+1>TEXT_ADMISSION.layerLines){
   if(preferLines&&lastLine16>start16)append(lastLine16,lastLineByte,lastLineLF);
   else append(part.index,bytes,lineFeeds);
   // A line-prefix cut can leave a long tail. It still ends only at this
   // actual extended-grapheme boundary and never inserts a synthetic LF.
   if(bytes+count.bytes-startByte>TEXT_ADMISSION.layerBytes||lineFeeds+count.lines-1-startLF+1>TEXT_ADMISSION.layerLines)append(part.index,bytes,lineFeeds);
  }
  bytes+=count.bytes;lineFeeds+=count.lines-1;
  if(count.lines>1){lastLine16=end16;lastLineByte=bytes;lastLineLF=lineFeeds;}
 }
 if(start16<text.length)append(text.length,bytes,lineFeeds);
 return result;
 };
 // Prefer complete logical lines where capacity permits. If that partition
 // wastes the available layer slots, retry packing at grapheme boundaries;
 // this still preserves every scalar/LF and never raises the layer cap.
 try{return partition(true);}catch(error){if(error!==full)throw error;}
 try{return partition(false);}catch(error){if(error===full)throw Error('TEXT_SPLIT_LAYER_LIMIT');throw error;}
}
