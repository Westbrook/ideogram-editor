import { SHA256 } from '../protocol/sha256.js';
import type { Download } from './editor-client.js';
type Sink={write(data:ArrayBuffer):Promise<void>;close():Promise<void>;abort():Promise<void>};
type Destination={createWritable():Promise<Sink>};
export function chooseDestination(name:string):Promise<Destination>|null {
  const picker=(window as unknown as {showSaveFilePicker?:(options:{suggestedName:string})=>Promise<Destination>}).showSaveFilePicker;
  const chosen=picker?picker.call(window,{suggestedName:name}):null;
  // Attach immediately: the UI yields for pending feedback before awaiting it.
  void chosen?.catch(()=>{});return chosen;
}
export async function writeDestination(download:Download,transport:(path:string)=>Promise<Response>,chosen:Promise<Destination>|null){
  let sink:Sink|undefined;let temporary:FileSystemFileHandle|undefined;
  let temporaryRoot:FileSystemDirectoryHandle|undefined,temporaryName:string|undefined;let handedOff=false;
  try{
    if(chosen)sink=await(await chosen).createWritable();
    else{
      // Disk-backed fallback avoids accumulating an entire project in JS memory.
      const root=await navigator.storage.getDirectory();
      const name='ie-download-'+crypto.randomUUID();
      // Refuse a known collision; the attempt owns only its newly created entry.
      try{await root.getFileHandle(name);throw Error('DOWNLOAD_TEMPORARY_COLLISION');}
      catch(error){if(!(error instanceof DOMException)||error.name!=='NotFoundError')throw error;}
      temporary=await root.getFileHandle(name,{create:true});temporaryRoot=root;temporaryName=name;
      sink=await temporary.createWritable();
    }
    const response=await transport(download.path);
    if(!response.ok||!response.body||response.headers.get('etag')!=='"'+download.hash+'"'||response.headers.get('content-length')!==download.bytes)throw Error('DOWNLOAD_UNAVAILABLE');
    const reader=response.body.getReader(),hash=new SHA256();let length=0n;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=BigInt(value.length);if(length>BigInt(download.bytes))throw Error('DOWNLOAD_CHANGED');
      for(let i=0;i<value.length;i+=32768){const part=value.subarray(i,i+32768);hash.update(part);await sink!.write(new Uint8Array(part).buffer);}
    }}finally{await reader.cancel();}
    if(String(length)!==download.bytes||hash.digest()!==download.hash)throw Error('DOWNLOAD_CORRUPT');
    await sink!.close();sink=undefined;
    if(temporary){const url=URL.createObjectURL(await temporary.getFile());const link=document.createElement('a');link.href=url;link.download=download.name;handedOff=true;link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);return 'unconfirmed' as const;}
    return 'confirmed' as const;
  }catch(error){
    const cleanupErrors:unknown[]=[];
    // Settle the writer before unlinking. An uncertain writer leaves the entry
    // intact and reports incomplete cleanup alongside the original failure.
    if(sink){try{await sink.abort();sink=undefined;}catch(failure){cleanupErrors.push(failure);}}
    if(!handedOff&&!sink&&temporaryRoot&&temporaryName){try{await temporaryRoot.removeEntry(temporaryName);}catch(failure){cleanupErrors.push(failure);}}
    if(cleanupErrors.length)throw new AggregateError([error,...cleanupErrors],(error instanceof Error?error.message:String(error))+'; download cleanup incomplete',{cause:error});
    throw error;
  }
}
