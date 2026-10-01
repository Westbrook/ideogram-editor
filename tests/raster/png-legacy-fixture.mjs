// Frozen pre-reusable-row encoder, copied before the streaming producer change.
// Keep the original writes and async iterator: exact IDAT framing is part of
// this comparison. Do not normalize chunk boundaries or import current helpers.
import { createDeflate, crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4, 4, 'ascii'); out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4); return out;
}
export async function encodeLegacyPNG(raw, output, width, height, check) {
  check();
  const target = createWriteStream(output, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
  let targetError;
  target.on('error',error=>{targetError=error;});
  const closed=new Promise(resolve=>target.once('close',resolve));
  const put = async (b) => {
    check();if(targetError)throw targetError;if(target.destroyed)throw Error('RASTER_WRITE');
    if(!target.write(b))await new Promise((resolve,reject)=>{
      const cleanup=()=>{target.off('drain',drained);target.off('error',failed);target.off('close',ended);};
      const drained=()=>{cleanup();resolve();},failed=(error)=>{cleanup();reject(error);},ended=()=>{cleanup();reject(targetError??Error('RASTER_WRITE'));};
      target.once('drain',drained);target.once('error',failed);target.once('close',ended);
    });
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8;ihdr[9]=6;
  async function* rows() {
    let carry = Buffer.alloc(0), count = 0;
    for await (const bytes of createReadStream(raw, { highWaterMark: 65536 })) {
      check(); carry = Buffer.concat([carry, bytes]);
      while (carry.length >= width * 4) { yield Buffer.from([0]); yield carry.subarray(0, width * 4); carry = carry.subarray(width * 4); count++; }
    }
    if (carry.length || count !== height) throw new Error('RASTER_LENGTH');
  }
  let zip,producing;
  try {
    await put(PNG_SIGNATURE); await put(chunk('IHDR', ihdr)); await put(chunk('sRGB', Buffer.from([0])));
    zip=createDeflate({level:6,chunkSize:65536});producing=pipeline(Readable.from(rows()),zip);producing.catch(()=>{});
    for await(const data of zip)await put(chunk('IDAT',data));
    await producing;await put(chunk('IEND',Buffer.alloc(0)));target.end();await closed;if(targetError)throw targetError;
  }catch(error){target.destroy();zip?.destroy();if(producing)await Promise.allSettled([producing]);await closed;throw error;}
}
