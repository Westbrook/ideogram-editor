import {modelPayloadBytes,reserveModelBytes,type OwnedModel} from './model-memory.js';

// Logical application controls, not an engine-object or physical heap estimate.
// The fixed root includes the owner wrapper and its reference bookkeeping.
export const DISPLAY_CONTROL_ROOT_BYTES=512;
export const DISPLAY_SOURCE_CONTROL_BYTES=2048;
export const DISPLAY_TILE_CONTROL_BYTES=512;
export const DISPLAY_PREVIEW_CONTROL_BYTES=8192;
export const DISPLAY_READ_CONTROL_BYTES=4096;

/** Admit before constructing a bounded display descriptor. A producer reference
 * and each outstanding consumer pin retire independently. No timer or newer
 * viewport can refund a still-referenced older descriptor. */
export function ownDisplayControl<T>(owner:string,allowance:number,create:()=>T):OwnedModel<T>{
 const payload=reserveModelBytes(owner,allowance);
 try{
  const value=create(),bytes=DISPLAY_CONTROL_ROOT_BYTES+modelPayloadBytes(value);
  if(bytes>allowance)throw Error('DISPLAY_CONTROL_ALLOWANCE');
  payload.resize(bytes);
  return Object.freeze({value,release:()=>payload.release(),pin:()=>payload.pin()});
 }catch(error){payload.release();throw error;}
}

export async function readOwnedDisplayControl<T>(owner:string,allowance:number,read:()=>Promise<T>):Promise<OwnedModel<T>>{
 const payload=reserveModelBytes(owner,allowance);
 try{
  const value=await read(),bytes=DISPLAY_CONTROL_ROOT_BYTES+modelPayloadBytes(value);
  if(bytes>allowance)throw Error('DISPLAY_CONTROL_ALLOWANCE');
  payload.resize(bytes);
  return Object.freeze({value,release:()=>payload.release(),pin:()=>payload.pin()});
 }catch(error){payload.release();throw error;}
}
