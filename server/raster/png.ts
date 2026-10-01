import { createDeflate, crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
export const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
export function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4, 4, 'ascii'); out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4); return out;
}
// Deterministic filter0, zlib level6, one64KiB IDAT per deflate output piece.
// Stream row-major canonical bytes without a second full image allocation.
export async function encodePNG(raw: string, output: string, width: number, height: number, check: () => void): Promise<void> {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw Error('RASTER_LENGTH');
  check();
  const target = createWriteStream(output, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
  let targetError:Error|undefined;
  target.on('error',error=>{targetError=error;});
  // Closing, not the earlier error event, is the boundary at which a caller may
  // safely remove an owned intermediate. Pending open/writev callbacks can
  // otherwise outlive cancellation and access a directory already removed.
  const closed=new Promise<void>(resolve=>target.once('close',resolve));
  const put = async (b: Uint8Array) => {
    check();if(targetError)throw targetError;if(target.destroyed)throw Error('RASTER_WRITE');
    if(!target.write(b))await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{target.off('drain',drained);target.off('error',failed);target.off('close',ended);};
      const drained=()=>{cleanup();resolve();},failed=(error:Error)=>{cleanup();reject(error);},ended=()=>{cleanup();reject(targetError??Error('RASTER_WRITE'));};
      target.once('drain',drained);target.once('error',failed);target.once('close',ended);
    });
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8;ihdr[9]=6;
  async function* rows() {
    let carry=Buffer.alloc(0),count=0;const rowBytes=width*4;
    for await(const bytes of createReadStream(raw,{highWaterMark:65536})){
      check();let at=0;
      if(carry.length){
        const needed=rowBytes-carry.length;
        if(bytes.length<needed){carry=Buffer.concat([carry,bytes]);continue;}
        const row=Buffer.alloc(rowBytes);carry.copy(row);bytes.copy(row,carry.length,0,needed);at=needed;
        yield Buffer.from([0]);yield row;count++;
      }
      // Immutable views keep each stream buffer alive until zlib consumes it.
      // Only a row straddling two reads needs a copy; never copy an entire read
      // merely to prepend the previous read's short remainder. Preserve the
      // retained generator's filter/row yields and stream/flush scheduling.
      while(bytes.length-at>=rowBytes){yield Buffer.from([0]);yield bytes.subarray(at,at+rowBytes);at+=rowBytes;count++;}
      carry=bytes.subarray(at);
    }
    if(carry.length||count!==height)throw Error('RASTER_LENGTH');
  }
  let zip:ReturnType<typeof createDeflate>|undefined,producing:Promise<void>|undefined;
  try {
    await put(PNG_SIGNATURE); await put(chunk('IHDR', ihdr)); await put(chunk('sRGB', Buffer.from([0])));
    zip=createDeflate({level:6,chunkSize:65536});producing=pipeline(Readable.from(rows()),zip);producing.catch(()=>{});
    for await(const data of zip)await put(chunk('IDAT',data));
    await producing;await put(chunk('IEND',Buffer.alloc(0)));target.end();await closed;if(targetError)throw targetError;
  }catch(error){target.destroy();zip?.destroy();if(producing)await Promise.allSettled([producing]);await closed;throw error;}
}
