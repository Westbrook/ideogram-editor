import { TextRenderer } from './client';
import { releasePrepared, textMemory, unownedFontBytes } from './memory';
import type { TextRequest, PreparedText } from './contracts';
import type { BlobRef } from '../protocol/store';
import type { FontVersion, TextCandidate, TextSource } from '../protocol/text';
import { canonical } from '../protocol/json';
import { hashBytes } from './contracts';
import profile from './profile.json';
import {verificationBudget} from '../protocol/text-budget';
import profileRaw from './profile.json?raw';

export type TextStorage = {
  admit(id:string):Promise<void>;
  releaseAdmission(id:string):Promise<void>;
  stage(blob:Blob, mediaType:string):Promise<BlobRef>;
};
let activePreparations=0;
let realm:Promise<{id:string;serial:number;current:string;mirror:ReturnType<typeof textMemory.reserve>;loan?:ReturnType<typeof textMemory.reserve>}>|undefined;
// Mirror the backend's remaining 384MiB in the EXISTING realm ledger. The
// backend books this realm's 128MiB once, including idle engines, loader fonts,
// caller inputs and outputs. These are complementary envelopes, not additive
// independent allowances or measured RSS. Do not refund on timer/disconnect.
async function admission(storage:TextStorage,bytes:number){
  const created=!realm;
  if(!realm){const mirror=textMemory.reserve(384*1024**2,'other');realm=Promise.resolve({id:crypto.randomUUID(),serial:0,current:'',mirror});}
  const current=await realm;if(activePreparations!==1)throw Error('TEXT_REALM_BUSY');
 const id=`${current.id}_${++current.serial}_${bytes}`;try{await storage.admit(id);current.loan?.release();current.loan=undefined;current.current=id;}catch(e){if(created&&activePreparations<=1&&textMemory.snapshot.textBytes===0){current.mirror.release();realm=undefined;}throw e;}return current;
}
// Explicit caller shutdown: the realm stays booked until all loaders, engines,
// requests and retained outputs have released their existing ledger leases.
export async function releaseTextRealm(storage:TextStorage){
 const current=realm&&await realm;if(!current)return;
 if(activePreparations||textMemory.snapshot.textBytes!==(current.loan?.bytes??0)||textMemory.snapshot.cpuBytes!==current.mirror.bytes+(current.loan?.bytes??0))throw Error('TEXT_REALM_STILL_OWNED');
 await storage.releaseAdmission(current.current);current.loan?.release();current.mirror.release();realm=undefined;
}
const identified=async<T extends object>(v:T)=>({...v,id:await hashBytes(new TextEncoder().encode(canonical(v)))});
export async function describePrepared(request:TextRequest,p:PreparedText,fonts:FontVersion[],stage:TextStorage['stage']):Promise<TextCandidate>{
 const put=async(blob:Blob,mediaType:string,hash?:string)=>{const r=await stage(blob,mediaType);if(r.byteLength!==String(blob.size)||r.mediaType!==mediaType||hash&&r.hash!==hash)throw Error('TEXT_STAGING_IDENTITY');return r;};
 if(canonical(request.token)!==canonical(p.token)||p.rendererProfile!==profile.id)throw Error('TEXT_STALE');
 const ordered=p.dependencies.map(d=>{const f=fonts.find(f=>f.bytes.hash===d.hash&&f.licenseRecord.hash===d.licenseHash);if(!f||f.parserProfile!==d.parserProfile||f.format!==d.format||f.fsType!==d.fsType)throw Error('FONT_IMPORT_REQUIRED');return f;});
 const textUtf8=await put(p.textUtf8,'text/plain',p.textHash);
 const manifest=await put(new Blob([profileRaw]),'application/json');
 const text=await identified({schemaVersion:1 as const,textUtf8,style:request.style,frame:request.frame,layoutPolicy:'text-layout-1' as const,fonts:ordered});
 const layout=await put(p.layout,'application/json',p.layoutHash),pixels=await put(p.rgba,'application/x-ideogram-rgba8',p.rasterHash);
 const render=await identified({schemaVersion:1 as const,textVersion:text.id,rendererProfile:{schemaVersion:1 as const,id:p.rendererProfile,manifest},dependencyHash:p.dependencyHash,layout,pixels,width:p.width,height:p.height,overflow:p.overflow,resolvedFonts:ordered.map(f=>f.id)});
 const source:TextSource={schemaVersion:1,text,render};return {schemaVersion:1,token:p.token,source};
}
// Candidate ownership never escapes: success consumes all outputs durably;
// failure/cancel drops only this adapter's result. The caller's request/draft and
// previously committed appearance are untouched. Storage callbacks must retain
// durable command identities for retries, as with all other staging callers.
export class DurableTextPreparation {
 #renderer=new TextRenderer();#generation=0;#closed=false;
 constructor(private storage:TextStorage){}
 cancel(){this.#generation++;this.#renderer.cancel();}
 dispose(){this.#closed=true;this.cancel();this.#renderer.dispose();}
 async prepare(request:TextRequest,fonts:FontVersion[]){
  if(this.#closed)throw Error('TEXT_DISPOSED');activePreparations++;try{const generation=++this.#generation,budget=verificationBudget(request.text,request.frame.width,request.frame.height,request.fonts.reduce((n,f)=>n+f.bytes.size,0),profile.engine.wasm.bytes),owner=await admission(this.storage,budget.bytes),id=owner.current;
  if(generation!==this.#generation||this.#closed)throw Error('TEXT_STALE');
  let value:PreparedText|undefined=await this.#renderer.prepare(request);
  let copyLease:ReturnType<typeof textMemory.reserve>|undefined;
  try{
   // Bounded upload/hash/JSON conversion scratch, with output still booked.
   copyLease=textMemory.reserve(3*1024**2);
   const candidate=await describePrepared(request,value,fonts,async(blob,media)=>{if(generation!==this.#generation||this.#closed)throw Error('TEXT_STALE');return this.storage.stage(blob,media);});
   if(generation!==this.#generation||this.#closed)throw Error('TEXT_STALE');
   // End private native ownership before borrowing this same realm's R35 capacity.
   this.#renderer.dispose();this.#renderer=new TextRenderer();
   releasePrepared(value);value=undefined;copyLease.release();copyLease=undefined;
   owner.loan=textMemory.reserve(budget.bytes+unownedFontBytes(request)+65536);
   const bytes=new Blob([canonical(candidate)],{type:'application/json'}),ref=await this.storage.stage(bytes,'application/json');
   if(generation!==this.#generation||this.#closed)throw Error('TEXT_STALE');return {candidate:ref,admissionId:id,dependencyHash:candidate.source.render.dependencyHash};
  }finally{copyLease?.release();if(value)releasePrepared(value);}
  }finally{activePreparations--;}
 }
}
