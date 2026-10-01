import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { extent } from '../../src/raster/core.js';
import { BOUNDED_WEBP_NATIVE_BYTES, boundedWebPLibraryPath, verifyBoundedWebP, type BoundedWebPMetrics } from './bounded-webp.js';
import { WEBP_OUTPUT } from './webp-output-platform.js';
import { BOUNDED_WEBP } from './webp-platform.js';
import { LINUX_COLOR } from './linux-color-platform.js';
import { sameWebPSource, type WebPSourceStamp } from './webp-metadata.js';

type NativeFunction = (...args:(number|bigint|Buffer)[])=>number|bigint;
type Library = {getFunctions(definitions:Record<string,{arguments:string[];return:string}>):Record<string,NativeFunction>;getSymbol(name:string):bigint;close():void};
type FFI = {DynamicLibrary:new(path:string)=>Library};
export type WebPOutputMetrics = {outputPeak:number;outputRemaining:number};
export type WebPOutputBridge = {decode:NativeFunction;convert:NativeFunction;close():void};
export function webpOutputLibraryPath():string|null {
  if(process.platform!==WEBP_OUTPUT.platform||process.arch!==WEBP_OUTPUT.arch)return null;
  const require=createRequire(import.meta.url),modules=dirname(dirname(dirname(require.resolve('sharp'))));
  return join(dirname(modules),WEBP_OUTPUT.path);
}
export function verifyWebPOutput():void {
  const path=webpOutputLibraryPath();if(!path||WEBP_OUTPUT.decoderHash!==BOUNDED_WEBP.hash||WEBP_OUTPUT.converterHash!==(LINUX_COLOR?.hash??BOUNDED_WEBP.hash))throw Error('RASTER_CODEC_UNQUALIFIED');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),block=Buffer.alloc(65536),digest=createHash('sha256');
  try{const before=fstatSync(fd);if(!before.isFile()||before.size!==WEBP_OUTPUT.bytes)throw Error('RASTER_CODEC_UNQUALIFIED');let total=0,n;while((n=readSync(fd,block))){total+=n;digest.update(block.subarray(0,n));}if(total!==WEBP_OUTPUT.bytes||'sha256:'+digest.digest('hex')!==WEBP_OUTPUT.hash)throw Error('RASTER_CODEC_UNQUALIFIED');}finally{closeSync(fd);}
}
export async function openWebPOutputBridge():Promise<WebPOutputBridge|null>{
  const path=webpOutputLibraryPath();if(!path)return null;verifyWebPOutput();let library:Library|undefined;
  try{const specifier='node:ffi',ffi=await import(specifier) as FFI;library=new ffi.DynamicLibrary(path);
    const f=library.getFunctions({IEWebPOutputABIVersion:{arguments:[],return:'uint32'},IEWebPDecodeToFile:{arguments:['int32','uint64','int32','int32','int32','uint64','uint64','pointer','pointer','pointer','pointer','pointer'],return:'int32'},IEWebPConvertFileRGBA:{arguments:['int32','uint64','uint32','pointer','uint32','pointer','uint32','pointer','uint32','uint64','pointer','pointer'],return:'int32'}});
    if(f.IEWebPOutputABIVersion()!==WEBP_OUTPUT.abiVersion){library.close();return null;}
    const held=library;return{decode:f.IEWebPDecodeToFile,convert:f.IEWebPConvertFileRGBA,close:()=>held.close()};
  }catch{library?.close();return null;}
}
export function outputMetrics(peak:Buffer,remaining:Buffer,rawBytes:number):WebPOutputMetrics{
  const metrics={outputPeak:Number(peak.readBigUInt64LE()),outputRemaining:Number(remaining.readBigUInt64LE())};
  if(metrics.outputRemaining!==0||metrics.outputPeak>rawBytes+65536)throw Object.assign(Error('RASTER_RESOURCES'),{rasterResourceFailure:metrics});return metrics;
}
export type WebPFileDecoder={decode(input:string,targetFD:number,width:number,height:number,encodedBytes:number,check:()=>void,budget?:number,expectedStamp?:WebPSourceStamp):{metrics:BoundedWebPMetrics&WebPOutputMetrics};close():void};
export async function openWebPFileDecoder():Promise<WebPFileDecoder|null>{
  const path=boundedWebPLibraryPath();if(!path)return null;verifyBoundedWebP();const bridge=await openWebPOutputBridge();if(!bridge)return null;let library:Library|undefined;
  try{const specifier='node:ffi',ffi=await import(specifier) as FFI;library=new ffi.DynamicLibrary(path);const pointer=library.getSymbol('IEWebPDecodeRGBA'),held=library;let busy=false,closed=false;
    return{close(){if(busy)throw Error('RASTER_DECODE_BUSY');if(!closed){closed=true;held.close();bridge.close();}},decode(input,targetFD,width,height,encodedBytes,check,budget=BOUNDED_WEBP_NATIVE_BYTES,expectedStamp){
      extent(width,height);if(closed||busy)throw Error('RASTER_DECODE_BUSY');if(!Number.isSafeInteger(budget)||budget<0||budget>BOUNDED_WEBP_NATIVE_BYTES||!Number.isSafeInteger(encodedBytes)||encodedBytes<0)throw Error('RASTER_RESOURCES');
      busy=true;let source:number|undefined;
      try{check();source=openSync(input,constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(source,{bigint:true});if(!before.isFile()||before.size!==BigInt(encodedBytes)||expectedStamp&&!sameWebPSource(before,expectedStamp))throw Error('RASTER_INPUT_CHANGED');
        const target=fstatSync(targetFD,{bigint:true});if(!target.isFile()||target.size!==0n||target.dev===before.dev&&target.ino===before.ino)throw Error('RASTER_INPUT_CHANGED');
        const peak=Buffer.alloc(8),remaining=Buffer.alloc(8),denied=Buffer.alloc(8),mapped=Buffer.alloc(8),unmapped=Buffer.alloc(8);
        // The external RGBA map belongs to one synchronous native call. No
        // borrowed pointer survives a JS continuation, cancellation or return.
        const status=bridge.decode(source,BigInt(encodedBytes),targetFD,width,height,BigInt(budget),pointer,peak,remaining,denied,mapped,unmapped);
        const metrics={nativeBudget:budget,nativePeak:Number(peak.readBigUInt64LE()),nativeRemaining:Number(remaining.readBigUInt64LE()),nativeDenied:Number(denied.readBigUInt64LE()),...outputMetrics(mapped,unmapped,width*height*4)};
        if(metrics.nativePeak>budget||metrics.nativeRemaining!==0)throw Error('RASTER_RESOURCES');
        if(status===0&&metrics.outputPeak<width*height*4)throw Error('RASTER_RESOURCES');
        if(status!==0)throw Error(status===1||status===3||metrics.nativeDenied?'RASTER_RESOURCES':status===5||status===8?'RASTER_INPUT_CHANGED':status===6?'RASTER_LENGTH':status===7?'RASTER_RESOURCES':'RASTER_DECODE');
        const written=fstatSync(targetFD,{bigint:true});check();if(!sameWebPSource(before,fstatSync(source,{bigint:true})))throw Error('RASTER_INPUT_CHANGED');const after=fstatSync(targetFD,{bigint:true});if(!sameWebPSource(written,after)||after.dev!==target.dev||after.ino!==target.ino||after.size!==BigInt(width*height*4))throw Error('RASTER_INPUT_CHANGED');return{metrics};
      }finally{if(source!==undefined)closeSync(source);busy=false;}
    }};
  }catch{library?.close();bridge.close();return null;}
}
