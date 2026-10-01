// One R35 lane is shared by browser preparation and backend verification.
// These are bounded owned allocations, not a claim about process RSS or GC.
const TEXT_CAPACITY = 134217728;
const LAYOUT_CAPACITY = 8388608;
const FIXED_REQUEST = 65536;
const LOAN_METADATA = 65536;
const VERIFICATION_SCRATCH = 2097152;
export type TextCounts = { scalars: number; lines: number; bytes: number };
export type VerificationOptions = { legacy?: boolean; layoutBytes?: number };

function counts(text: string): TextCounts {
 if (typeof text !== 'string' || text.length > 16384) throw Error('TEXT_VERIFICATION_CAPACITY');
 let scalars=0,lines=1,bytes=0;
 for (const scalar of text) {
  const value=scalar.codePointAt(0)!;
  if (value>=0xd800&&value<=0xdfff||value===13) throw Error('TEXT_VERIFICATION_CAPACITY');
  scalars++;if(value===10)lines++;bytes+=value<128?1:value<2048?2:value<65536?3:4;
 }
 if(bytes>16384||lines>256)throw Error('TEXT_VERIFICATION_CAPACITY');
 return {scalars,lines,bytes};
}

/** Quotas bound native export before JS arrays exist; output bytes are separate. */
export function textWorkspaceBudget(textLength:number,indices:TextCounts,width:number,height:number,fontBytes:number,wasmBytes:number) {
 if (![textLength,indices.scalars,indices.lines,indices.bytes,fontBytes,wasmBytes].every(Number.isSafeInteger)||
     textLength<0||textLength>16384||indices.scalars<0||indices.scalars>textLength||indices.bytes<textLength||indices.lines<1||indices.lines>256||indices.bytes>16384||fontBytes<0||fontBytes>67108864||wasmBytes<=0||wasmBytes>33554432||
     ![width,height].every(value=>Number.isFinite(value)&&value>0&&value<=8192)) throw Error('TEXT_VERIFICATION_CAPACITY');
 const glyphs=Math.max(64,8*indices.scalars);
 const runs=Math.min(glyphs,Math.max(64,Math.ceil(indices.scalars/8)));
 const lines=Math.max(indices.lines,Math.min(glyphs,Math.max(64,Math.ceil(indices.scalars/4))));
 const rectangles=glyphs*2;
 // Native visitor arrays: 14G+12R; current glyph-bounds copy: <=16G.
 // Per-run backing stores/typed views/typeface handles and line/metric records
 // have separate conservative allowances. No retained layout object graph.
 const workspace=30*glyphs+1024*runs+512*lines+262144;
 const raster=Math.ceil(width)*Math.ceil(height)*4;
 const indexes=128*(textLength+indices.bytes+indices.scalars+3);
 const startup=33554432+6*wasmBytes+4194304,resident=33554432+2*wasmBytes+4194304;
 // Four font backings cover the combined caller/backend phase. The backend
 // books three; the caller's remaining backing (owned or unowned) stays booked.
 // Chunk->Blob and Blob->hash phases each own <=3L; no whole JSON string or
 // duplicate parsed comparison graphs are retained. Reserve the same capacity
 // before native work and enforce it while streaming every output fragment.
 const available=TEXT_CAPACITY-resident-4*fontBytes-4*raster-indexes-workspace-FIXED_REQUEST-VERIFICATION_SCRATCH-LOAN_METADATA;
 const oldSmallBound=16384+1024*(glyphs+indices.scalars+Math.max(indices.lines,glyphs));
 const layout=Math.min(LAYOUT_CAPACITY,oldSmallBound,Math.floor(available/3));
 if(layout<16384||![workspace,raster,indexes,layout,startup,resident].every(Number.isSafeInteger))throw Error('TEXT_VERIFICATION_CAPACITY');
 return {glyphs,runs,lines,rectangles,workspace,raster,indexes,layout,startup,resident};
}

export function verificationBudget(text:string,width:number,height:number,fontBytes:number,wasmBytes:number,options:VerificationOptions={}) {
 const indices=counts(text);
 if(![fontBytes,wasmBytes].every(Number.isSafeInteger)||fontBytes<0||fontBytes>67108864||wasmBytes<=0||wasmBytes>33554432||![width,height].every(value=>Number.isFinite(value)&&value>0&&value<=8192))throw Error('TEXT_VERIFICATION_CAPACITY');
 if(options.legacy){
  const glyphs=Math.max(64,8*indices.scalars),lines=Math.max(indices.lines,glyphs);
  const estimate=16384+1024*(glyphs+indices.scalars+lines);
  const layout=Math.max(estimate,options.layoutBytes??0),raster=Math.ceil(width)*Math.ceil(height)*4;
  const indexes=128*(text.length+indices.bytes+indices.scalars+3);
  const startup=33554432+6*wasmBytes+4194304,resident=33554432+2*wasmBytes+4194304;
  const request=3*fontBytes+4*raster+6*layout+indexes+FIXED_REQUEST,scratch=2*layout+VERIFICATION_SCRATCH;
  const bytes=Math.max(startup,resident+request)+scratch;
  if(layout>LAYOUT_CAPACITY||!Number.isSafeInteger(bytes)||bytes>TEXT_CAPACITY)throw Error('TEXT_VERIFICATION_CAPACITY');
  return {bytes,startup,resident,request,scratch,layout,workspace:0};
 }
 const plan=textWorkspaceBudget(text.length,indices,width,height,fontBytes,wasmBytes);
 const request=3*fontBytes+4*plan.raster+3*plan.layout+plan.indexes+plan.workspace+FIXED_REQUEST;
 const scratch=VERIFICATION_SCRATCH,bytes=Math.max(plan.startup,plan.resident+request)+scratch;
 // Includes the caller backing and loan metadata, even when no engine is live.
 if(!Number.isSafeInteger(bytes)||bytes+fontBytes+LOAN_METADATA>TEXT_CAPACITY)throw Error('TEXT_VERIFICATION_CAPACITY');
 return {bytes,startup:plan.startup,resident:plan.resident,request,scratch,layout:plan.layout,workspace:plan.workspace};
}
