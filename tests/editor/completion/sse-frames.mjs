import assert from 'node:assert/strict';
import {parseControlJSON} from '../../../dist/local/src/protocol/json.js';

// Only chunks delivered to the original application reader enter this parser.
// Its UTF-8 and framing bounds match RecoveryConsumer.consumeStream.
export class OriginalSSEFrames {
 constructor(){this.decoder=new TextDecoder('utf-8',{fatal:true});this.encoder=new TextEncoder();this.pending='';this.count=0;this.reads=0;this.byteOffset=0;this.ordinal=0;this.frames=[];this.failures=[];}
 push(e,bytes){try{
  assert(!this.ended&&!this.failures.length,'SSE observation is permanently closed on failure');
  assert.equal(e.readerNumber,1);assert.equal(e.reads,++this.reads);assert.equal(e.count,this.count+bytes.length);this.count=e.count;
  for(let at=0;at<bytes.length;at+=16384){this.pending+=this.decoder.decode(bytes.subarray(at,at+16384),{stream:true});let end;
   while((end=this.pending.indexOf('\n\n'))!==-1){const text=this.pending.slice(0,end),length=this.encoder.encode(text).length;assert(length<=65664,'SSE frame bound');this.pending=this.pending.slice(end+2);
    const lines=text.split('\n'),data=lines.filter(l=>l.startsWith('data: ')),ids=lines.filter(l=>l.startsWith('id: '));assert(lines.every(l=>l.startsWith('data: ')||l.startsWith('id: '))&&data.length===1&&ids.length<=1,'Original SSE frame syntax');
    const value=parseControlJSON(this.encoder.encode(data[0].slice(6)));assert.equal(value.protocolVersion,1);
    const frame={...e,kind:'sse-frame',end:e.at,value,offeredId:ids[0]?.slice(4),frameOrdinal:++this.ordinal,byteStart:this.byteOffset,byteEnd:this.byteOffset+length+2,deliveredByRead:e.reads,deliveredCount:e.count,completeFrame:true};this.byteOffset=frame.byteEnd;assert(frame.byteEnd<=this.count);this.frames.push(frame);
   }assert(this.encoder.encode(this.pending).length<=65664,'SSE pending frame bound');
  }
 }catch(error){this.failures.push(String(error));}}
 finish(e){try{assert.equal(e.readerNumber,1);assert.equal(e.reads,this.reads+1);assert.equal(e.count,this.count);this.pending+=this.decoder.decode();assert.equal(this.pending,'','Incomplete SSE frame');this.ended=true;}catch(error){this.failures.push(String(error));}}
}
