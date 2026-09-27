import type { EditorClient } from '../state/editor-client.js';
import type { FontVersion } from '../protocol/text.js';
import type { FontInput } from '../text/contracts.js';
import { hashBytes, readSealedAsset } from '../text/contracts.js';
import { textMemory, registerFontBacking } from '../text/memory.js';
import profile from '../text/profile.json';
const urls=import.meta.glob('../../vendor/text/fonts/*',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const licenses=import.meta.glob('../../vendor/text/notices/Noto*-OFL.txt',{eager:true,query:'?raw',import:'default'}) as Record<string,string>;
export const fontChoices=profile.fonts;
export class TextLibrary {
  private owned:{release():void}[]=[];
  constructor(private editor:EditorClient){}
  clear(){for(const lease of this.owned)lease.release();this.owned=[];}
  async bundled(id:string){
    const entry=profile.fonts.find(f=>f.id===id);if(!entry)throw Error('FONT_NOT_BUNDLED');
    const lease=textMemory.reserve(entry.bytes*5+65536);
    try{
      const bytes=await readSealedAsset(new URL(urls['../../vendor/text/'+entry.file],location.href),entry.bytes);
      const record=licenses['../../vendor/text/'+entry.licenseFile];if(!record)throw Error('FONT_LICENSE_UNAVAILABLE');
      const license=new Blob([record]);if(license.size>65536||await hashBytes(bytes)!=='sha256:'+entry.sha256||await hashBytes(license)!==entry.licenseHash)throw Error('FONT_HASH');
      return await this.import(bytes,license,'bundled');
    }finally{lease.release();}
  }
  async import(bytes:Blob,license:Blob,origin:'bundled'|'local-file'){
    if(bytes.size>16777216||!license.size||license.size>65536)throw Error('Font or license exceeds the supported import limit.');
    const source=await this.editor.stageTextBlob(bytes,'application/octet-stream','font'),record=await this.editor.stageTextBlob(license,'text/plain','caption');
    const facts=await this.editor.command({type:'ImportFont',source,license:record,origin,embeddingReviewed:true});
    const fact=facts.find(f=>f.type==='AssetRegistered'&&f.payload.asset.font);if(fact?.type!=='AssetRegistered'||!fact.payload.asset.font)throw Error('FONT_IMPORT_REQUIRED');return fact.payload.asset.font;
  }
  async load(fonts:FontVersion[]):Promise<FontInput[]>{
    this.clear();const assets=await this.editor.fontAssets(),loaded:FontInput[]=[];
    try{for(const font of fonts){
      const asset=assets.find(a=>a.font?.id===font.id);if(!asset)throw Error('Missing exact font registration. Relink the exact font or preview a substitution.');
      const peak=textMemory.reserve(Number(font.bytes.byteLength)*5);
      try{
        const r=await this.editor.session.transport('/api/v1/assets/'+asset.id+'/content');if(!r.ok)throw Error('Missing exact font bytes. Accepted appearance is retained; relink or preview a substitution.');
        const bytes=await r.blob();if(bytes.size!==Number(font.bytes.byteLength)||await hashBytes(bytes)!==font.bytes.hash)throw Error('FONT_HASH');
        const lease=textMemory.reserve(bytes.size);this.owned.push(lease);registerFontBacking(bytes);
        loaded.push({hash:font.bytes.hash,bytes,faceIndex:0,origin:font.origin,license:{hash:font.licenseRecord.hash,embedding:'permitted'}});
      }finally{peak.release();}
    }return loaded;}catch(error){this.clear();throw error;}
  }
}
