import type { EditorClient } from '../state/editor-client.js';
import {cloneOwnedModel,modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
import type { FontVersion } from '../protocol/text.js';
import type { FontInput } from '../text/contracts.js';
import { TextFailure, hashBytes, readSealedAsset, readTextAssetResponse, retryTextAssetCleanup, retainTextAssetCleanup, LIMITS } from '../text/contracts.js';
import { textMemory, registerFontBacking } from '../text/memory.js';
import { fonts } from '../text/profile.json';
const urls=import.meta.glob('../../vendor/text/fonts/*',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const licenses=import.meta.glob('../../vendor/text/notices/Noto-OFL.txt',{eager:true,query:'?raw',import:'default'}) as Record<string,string>;
export const fontChoices=fonts;
type FontBacking=Readonly<{bytes:number;release():void;pin():()=>void}>;
function ownBacking(lease:{bytes:number;release():void}):FontBacking{let refs=1,live=true;const unref=()=>{if(!--refs)lease.release();};return {bytes:lease.bytes,release(){if(live){live=false;unref();}},pin(){if(!refs)throw Error('FONT_BACKING_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}};}
export class TextLibrary {
  private owned:FontBacking[]=[];
  private generation=0;private reads=new AbortController();private pending=new Set<Promise<unknown>>();
  private cleanupErrors=new Set<unknown>();
  constructor(private editor:EditorClient){}
  get lifecycle(){return Object.freeze({pendingOperations:this.pending.size,retainedFontBytes:this.owned.reduce((n,lease)=>n+lease.bytes,0)});}
  private track<T>(work:Promise<T>):Promise<T>{this.pending.add(work);void work.catch(error=>{if(error?.code==='TEXT_ASSET_CLEANUP')this.cleanupErrors.add(error);}).finally(()=>this.pending.delete(work));return work;}
  private owner(){
    if(this.cleanupErrors.size)throw Error('TEXT_LIBRARY_CLEANUP');
    const generation=this.generation,signal=this.reads.signal,session=this.editor.session,id=this.editor.sessionId,drafts=this.editor.draftOwner;
    const current=()=>generation===this.generation&&!signal.aborted&&session===this.editor.session&&id===this.editor.sessionId&&drafts===this.editor.draftOwner;
    return {signal,current,check(){if(!current())throw Error('TEXT_LIBRARY_RELEASED');}};
  }
  // A clear also invalidates unsettled readers: their late completion must never
  // repopulate font backing after a document has relinquished its resources.
  invalidate(){this.generation++;this.reads.abort();this.reads=new AbortController();}
  clear(){this.invalidate();for(const lease of this.owned)lease.release();this.owned=[];}
  async releaseDocument(){this.invalidate();await Promise.allSettled([...this.pending]);this.clear();for(const error of this.cleanupErrors){try{if(await retryTextAssetCleanup(error))this.cleanupErrors.delete(error);}catch{}}if(this.cleanupErrors.size)throw new AggregateError([...this.cleanupErrors],'TEXT_LIBRARY_CLEANUP');}
  bundled(id:string){return this.track(this.readBundled(id));}
  private async readBundled(id:string){
    const owner=this.owner(),entry=fonts.find(f=>f.id===id);if(!entry)throw Error('FONT_NOT_BUNDLED');
    let lease:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(entry.bytes*5+65536);
    try{
      const bytes=await readSealedAsset(new URL(urls['../../vendor/text/'+entry.file],location.href),entry.bytes,owner.signal);owner.check();
      let record=licenses['../../vendor/text/'+entry.licenseFile];
      if(!record&&entry.licenseFile==='notices/Noto-CJK-OFL.txt'){
        // Both frozen notices share this complete license body; their full
        // per-font hash still authorizes the exact record before staging.
        const full=licenses['../../vendor/text/notices/Noto-OFL.txt'],prefix='Copyright 2018 The Noto Project Authors (github.com/googlei18n/noto-fonts)\n\n';
        if(full?.startsWith(prefix))record=full.slice(prefix.length);
      }
      if(!record)throw Error('FONT_LICENSE_UNAVAILABLE');
      const license=new Blob([record]);if(license.size>65536||await hashBytes(bytes)!=='sha256:'+entry.sha256||await hashBytes(license)!==entry.licenseHash)throw Error('FONT_HASH');owner.check();
      return await this.importOwned(bytes,license,'bundled',owner);
    }catch(error){if(lease&&retainTextAssetCleanup(error,lease))lease=undefined;throw error;}finally{lease?.release();}
  }
  import(bytes:Blob,license:Blob,origin:'bundled'|'local-file'){return this.track(this.importOwned(bytes,license,origin,this.owner()));}
  private async importOwned(bytes:Blob,license:Blob,origin:'bundled'|'local-file',owner:ReturnType<TextLibrary['owner']>){
    if(bytes.size>16777216||!license.size||license.size>65536)throw Error('Font or license exceeds the supported import limit.');owner.check();
    const source=await this.editor.ownedStageTextBlob(bytes,'application/octet-stream','font',owner.current);
    try{owner.check();const record=await this.editor.ownedStageTextBlob(license,'text/plain','caption',owner.current);
      try{owner.check();return await this.editor.withCommandEvents({type:'ImportFont',source:source.value,license:record.value,origin,embeddingReviewed:true},facts=>{
        owner.check();const fact=facts.find(f=>f.type==='AssetRegistered'&&f.payload.asset.font);if(fact?.type!=='AssetRegistered'||!fact.payload.asset.font)throw Error('FONT_IMPORT_REQUIRED');
        // The command root never escapes. The caller receives an independent,
        // prospectively admitted font version and explicitly owns its release.
        return cloneOwnedModel('text-font-version',fact.payload.asset.font);
      });}finally{record.release();}
    }finally{source.release();}
  }
  load(fonts:FontVersion[]):Promise<OwnedModel<FontInput[]>>{this.clear();return this.track(this.loadOwned(fonts));}
  private async loadOwned(fonts:FontVersion[]):Promise<OwnedModel<FontInput[]>>{
    if(fonts.length>16)throw Error('FONT_SELECTION_LIMIT');
    // Font Blob backings have separate textMemory ownership; this booking owns
    // the exact retained input metadata and one handle per loaded Blob.
    let bytes=0;for(const font of fonts)bytes+=modelPayloadBytes({hash:font.bytes.hash,bytes:null,faceIndex:0,origin:font.origin,license:{hash:font.licenseRecord.hash,embedding:'permitted'}});
    const metadata=reserveModelBytes('font-selection-control',bytes,fonts.length+1);let transferred=false;const backingPins:(()=>void)[]=[];let assetOwner:Awaited<ReturnType<EditorClient['ownedFontAssets']>>|undefined;
    try{
    const owner=this.owner();assetOwner=await this.editor.ownedFontAssets(fonts);const assets=assetOwner.value,loaded:FontInput[]=[];owner.check();
    try{for(const font of fonts){
      const asset=assets.find(a=>a.font?.id===font.id);if(!asset)throw Error('Missing exact font registration. Relink the exact font or preview a substitution.');
      const expected=Number(font.bytes.byteLength);if(!Number.isSafeInteger(expected)||expected<1||expected>LIMITS.faceBytes)throw Error('FONT_BYTES');owner.check();
      let peak:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(expected*5+65536);
      try{
        const r=await this.editor.session.transport('/api/v1/assets/'+asset.id+'/content',{signal:owner.signal});
        // Even a response delivered after abort must drain its reader ownership.
        // The declared font size is enforced while streaming, before Blob/hash.
        let bytes:Blob;try{bytes=await readTextAssetResponse(r,expected,owner.signal);}catch(error){if(error instanceof TextFailure&&error.code==='TEXT_ASSET_LOAD')throw new TextFailure(error.code,{fontHTTPStatus:r.status});throw error;}owner.check();if(await hashBytes(bytes)!==font.bytes.hash)throw Error('FONT_HASH');owner.check();
        const lease=ownBacking(textMemory.reserve(bytes.size));this.owned.push(lease);backingPins.push(lease.pin());registerFontBacking(bytes);
        loaded.push({hash:font.bytes.hash,bytes,faceIndex:0,origin:font.origin,license:{hash:font.licenseRecord.hash,embedding:'permitted'}});
      }catch(error){if(peak&&retainTextAssetCleanup(error,peak))peak=undefined;throw error;}finally{peak?.release();}
    }let refs=1,live=true;const unref=()=>{if(!--refs){for(const release of backingPins)release();metadata.release();}};const result=Object.freeze({value:loaded,release:()=>{if(live){live=false;unref();}},pin:()=>{if(!refs)throw Error('FONT_INPUT_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});transferred=true;return result;}catch(error){if(owner.current())this.clear();throw error;}
    }finally{assetOwner?.release();if(!transferred){for(const release of backingPins)release();metadata.release();}}
  }
}
