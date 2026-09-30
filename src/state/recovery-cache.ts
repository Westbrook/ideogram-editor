import type { DomainEvent } from '../protocol/store.js';
import { reduceDocument } from './projection.js';
import { requireValue } from '../protocol/validate.js';
export type Published = { generation: string; cursor: string; epoch: string | null };
export class RecoveryPublicationConflict extends Error {
  constructor(){super('Projection changed in another tab');this.name='RecoveryPublicationConflict';}
}
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const done = (tx: IDBTransaction) => new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Cache transaction aborted'));tx.onerror=()=>reject(tx.error);});
export class RecoveryCache {
  private constructor(private db: IDBDatabase) {}
  static async open(name: string) {
    const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('rows');request.result.createObjectStore('meta');};
    return new RecoveryCache(await result(request));
  }
  private async get(store: string,key: IDBValidKey) {const tx=this.db.transaction(store);return result(tx.objectStore(store).get(key));}
  async published(): Promise<Published> { return await this.get('meta','published') ?? {generation:'empty',cursor:'0',epoch:null}; }
  async read(type: string,id: string) {
    // Keep pointer selection and row retrieval in one read lifetime. Another
    // tab may publish and discard the previous generation immediately after it.
    const tx=this.db.transaction(['meta','rows']);
    const completed=done(tx);let value: unknown;
    const pointer=tx.objectStore('meta').get('published');
    pointer.onsuccess=()=>{
      const view: Published=pointer.result??{generation:'empty',cursor:'0',epoch:null};
      const row=tx.objectStore('rows').get([view.generation,type,id]);
      row.onsuccess=()=>{value=row.result;};
    };
    await completed;return value;
  }
  async collect<T>(type:string,include:(value:T)=>boolean):Promise<T[]> {
    // Pin publication and the cursor in one transaction; autosave can publish
    // and discard old generations while a font library lookup is in progress.
    const tx=this.db.transaction(['meta','rows']),completed=done(tx),values:T[]=[];
    const pointer=tx.objectStore('meta').get('published');
    pointer.onsuccess=()=>{const view:Published=pointer.result??{generation:'empty',cursor:'0',epoch:null};
      const cursor=tx.objectStore('rows').openCursor(IDBKeyRange.bound([view.generation,type],[view.generation,type,[]],true,true));
      cursor.onsuccess=()=>{const row=cursor.result;if(row){if(include(row.value))values.push(row.value);row.continue();}};
    };await completed;return values;
  }
  async put(generation: string,type: string,id: string,value: unknown) {
    const tx=this.db.transaction('rows','readwrite');tx.objectStore('rows').put(value,[generation,type,id]);await done(tx);
  }
  async value(generation: string,type: string,id: string) {return this.get('rows',[generation,type,id]);}
  async *rows(generation: string,type: string) {
    // One bounded entity per read; callers may await further IndexedDB reads
    // without keeping a transaction alive or collecting a whole namespace.
    let after: IDBValidKey = [generation,type];
    for (;;) {
      const tx=this.db.transaction('rows');
      const cursor: IDBCursorWithValue | null=await result(tx.objectStore('rows').openCursor(IDBKeyRange.bound(after,[generation,type,[]],true,true)));
      if(!cursor)return;after=cursor.key;
      yield {id:String((cursor.key as string[])[2]),value:cursor.value};
    }
  }
  private range(generation: string) {return IDBKeyRange.bound([generation],[generation,[]]);}
  async clone(from: string,to: string) {
    // Pin base selection and copying together: a competing publication may
    // otherwise discard the selected generation before this transaction starts.
    const tx=this.db.transaction(['meta','rows'],'readwrite');const store=tx.objectStore('rows');let conflict=false;
    const pointer=tx.objectStore('meta').get('published');
    pointer.onsuccess=()=>{
      if((pointer.result?.generation??'empty')!==from){conflict=true;tx.abort();return;}
      const cursor=store.openCursor(this.range(from));
      cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const key=c.key as string[];store.put(c.value,[to,...key.slice(1)]);c.continue();};
    };
    try{await done(tx);}catch(error){if(conflict)throw new RecoveryPublicationConflict();throw error;}
  }
  async discard(generation: string) {
    const tx=this.db.transaction('rows','readwrite');tx.objectStore('rows').delete(this.range(generation));await done(tx);
  }
  async apply(generation: string,event: DomainEvent) {
    // Each staged row is private; only the published pointer exposes a complete view.
    // Read checks and their writes share one transaction. No await crosses its
    // active callbacks, and no event marker survives a failed reducer/write.
    const tx=this.db.transaction('rows','readwrite'),store=tx.objectStore('rows');let validationError:unknown;
    const checks:[string,string][]=[['event',event.eventId]];
    if(event.documentId)checks.push(['document',event.documentId]);
    if(event.type==='AssetRegistered')checks.push(['asset',event.payload.asset.id]);
    if(event.type==='BundleImported')checks.push(['namespace',event.payload.namespaceId]);
    const values=new Map<string,any>();let remaining=checks.length;
    const put=(type:string,id:string,value:unknown)=>store.put(value,[generation,type,id]);
    for(const [type,id] of checks){
      const read=store.get([generation,type,id]);read.onsuccess=()=>{
        values.set(type,read.result);if(--remaining)return;
        try{
          requireValue(!values.get('event'),'Duplicate event identity');
          if(event.type==='DocumentDeleted'){store.delete([generation,'document',event.payload.id]);}
          else if(event.type==='AssetRegistered'){requireValue(!values.get('asset'),'Duplicate asset');put('asset',event.payload.asset.id,event.payload.asset);}
          else if(event.type==='BundleImported'||event.type==='DocumentCreated'||event.type==='CheckpointSaved'||event.type==='ImageEdited'||event.type==='HistoryNavigated'){
            if(event.type==='BundleImported'){
              const hydrated=values.get('namespace');requireValue(hydrated?.eventId===event.eventId&&hydrated?.namespaceHash===event.payload.namespaceHash,'Imported namespace has not been hydrated');
            }
            const next=reduceDocument(values.get('document')??null,event);put('document',next.id,next);
            if(event.type==='DocumentCreated'||event.type==='ImageEdited')put('history',event.payload.history.id,event.payload.history);
            else if(event.type==='CheckpointSaved')put('checkpoint',event.payload.checkpoint.id,event.payload.checkpoint);
          }
          put('event',event.eventId,event.workspaceSeq);
        }catch(error){validationError=error;tx.abort();}
      };
    }
    try{await done(tx);}catch(error){throw validationError??error;}
  }
  async applyEvents(generation: string,eventsStage: string,count: bigint) {
    for(let i=0n;i<count;i++) {const event=await this.value(eventsStage,'staged',String(i));requireValue(event);await this.apply(generation,event);}
  }
  async publish(next: Published,expected: Published) {
    const tx=this.db.transaction('meta','readwrite');const store=tx.objectStore('meta');const request=store.get('published');let conflict=false;
    request.onsuccess=()=>{const current=request.result??{generation:'empty',cursor:'0',epoch:null};
      if(current.generation!==expected.generation||current.cursor!==expected.cursor||current.epoch!==expected.epoch){conflict=true;tx.abort();}else store.put(next,'published');};
    try{await done(tx);}catch(error){if(conflict)throw new RecoveryPublicationConflict();throw error;}
    // Old published data remains intact until the pointer transaction commits.
    await this.discard(expected.generation).catch(()=>{});
  }
  close(){this.db.close();}
}
