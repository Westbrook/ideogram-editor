import type { EditorClient } from '../state/editor-client.js';
import { allocationLedger } from '../observability/allocations.js';
import type { FontVersion } from '../protocol/text.js';
import type { FontInput } from '../text/contracts.js';
import { hashBytes, readSealedAsset, readTextAssetResponse, retryTextAssetCleanup, retainTextAssetCleanup, LIMITS } from '../text/contracts.js';
import { textMemory, registerFontBacking } from '../text/memory.js';
import profile from '../text/profile.json';
const urls=import.meta.glob('../../vendor/text/fonts/*',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const licenses=import.meta.glob('../../vendor/text/notices/Noto*-OFL.txt',{eager:true,query:'?raw',import:'default'}) as Record<string,string>;
export const fontChoices=profile.fonts;
export class TextLibrary {
  private owned:{bytes:number;release():void}[]=[];
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
    const owner=this.owner(),entry=profile.fonts.find(f=>f.id===id);if(!entry)throw Error('FONT_NOT_BUNDLED');
    let lease:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(entry.bytes*5+65536);
    try{
      const bytes=await readSealedAsset(new URL(urls['../../vendor/text/'+entry.file],location.href),entry.bytes,owner.signal);owner.check();
      const record=licenses['../../vendor/text/'+entry.licenseFile];if(!record)throw Error('FONT_LICENSE_UNAVAILABLE');
      const license=new Blob([record]);if(license.size>65536||await hashBytes(bytes)!=='sha256:'+entry.sha256||await hashBytes(license)!==entry.licenseHash)throw Error('FONT_HASH');owner.check();
      return await this.importOwned(bytes,license,'bundled',owner);
    }catch(error){if(lease&&retainTextAssetCleanup(error,lease))lease=undefined;throw error;}finally{lease?.release();}
  }
  import(bytes:Blob,license:Blob,origin:'bundled'|'local-file'){return this.track(this.importOwned(bytes,license,origin,this.owner()));}
  private async importOwned(bytes:Blob,license:Blob,origin:'bundled'|'local-file',owner:ReturnType<TextLibrary['owner']>){
    if(bytes.size>16777216||!license.size||license.size>65536)throw Error('Font or license exceeds the supported import limit.');owner.check();
    const source=await this.editor.stageTextBlob(bytes,'application/octet-stream','font',owner.current);owner.check();
    const record=await this.editor.stageTextBlob(license,'text/plain','caption',owner.current);owner.check();
    const facts=await this.editor.command({type:'ImportFont',source,license:record,origin,embeddingReviewed:true});owner.check();
    const fact=facts.find(f=>f.type==='AssetRegistered'&&f.payload.asset.font);if(fact?.type!=='AssetRegistered'||!fact.payload.asset.font)throw Error('FONT_IMPORT_REQUIRED');return fact.payload.asset.font;
  }
  load(fonts:FontVersion[]):Promise<FontInput[]>{this.clear();return this.track(this.loadOwned(fonts));}
  private async loadOwned(fonts:FontVersion[]):Promise<FontInput[]>{
    if(fonts.length>16)throw Error('FONT_SELECTION_LIMIT');
    const metadata=allocationLedger.reserve({owner:'font-selection-control',kind:'control',cpuBytes:fonts.length*65536,handles:1});
    try{
    const owner=this.owner(),assets=await this.editor.fontAssets(fonts),loaded:FontInput[]=[];owner.check();
    try{for(const font of fonts){
      const asset=assets.find(a=>a.font?.id===font.id);if(!asset)throw Error('Missing exact font registration. Relink the exact font or preview a substitution.');
      const expected=Number(font.bytes.byteLength);if(!Number.isSafeInteger(expected)||expected<1||expected>LIMITS.faceBytes)throw Error('FONT_BYTES');owner.check();
      let peak:ReturnType<typeof textMemory.reserve>|undefined=textMemory.reserve(expected*5+65536);
      try{
        const r=await this.editor.session.transport('/api/v1/assets/'+asset.id+'/content',{signal:owner.signal});
        // Even a response delivered after abort must drain its reader ownership.
        // The declared font size is enforced while streaming, before Blob/hash.
        const bytes=await readTextAssetResponse(r,expected,owner.signal);owner.check();if(await hashBytes(bytes)!==font.bytes.hash)throw Error('FONT_HASH');owner.check();
        const lease=textMemory.reserve(bytes.size);this.owned.push(lease);registerFontBacking(bytes);
        loaded.push({hash:font.bytes.hash,bytes,faceIndex:0,origin:font.origin,license:{hash:font.licenseRecord.hash,embedding:'permitted'}});
      }catch(error){if(peak&&retainTextAssetCleanup(error,peak))peak=undefined;throw error;}finally{peak?.release();}
    }return loaded;}catch(error){if(owner.current())this.clear();throw error;}
    }finally{metadata.release();}
  }
}
