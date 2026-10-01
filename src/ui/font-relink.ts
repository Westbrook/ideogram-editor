import {hashBytes,LIMITS} from '../text/contracts.js';
import {textMemory} from '../text/memory.js';

/** Exact relink hashes local bytes only after the same font/license admission
 * used by import. A file selection is not permission for an unbounded read. */
export async function hashRelinkInputs(font:Blob,license:Blob){
  if(!font.size||font.size>LIMITS.faceBytes||!license.size||license.size>65536)throw Error('Font or license exceeds the supported import limit.');
  // ArrayBuffer plus digest input snapshot; the immutable File backing is not
  // assumed to alias either. Hash sequentially under one conservative lease.
  const lease=textMemory.reserve((font.size+license.size)*3);
  try{return {hash:await hashBytes(font),license:await hashBytes(license)};}finally{lease.release();}
}
