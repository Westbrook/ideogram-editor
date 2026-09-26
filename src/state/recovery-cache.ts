import type { DomainEvent } from '../protocol/store.js';
import { reduceDocument } from './projection.js';
import { requireValue } from '../protocol/validate.js';
export type Published = { generation: string; cursor: string; epoch: string | null };
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
  async put(generation: string,type: string,id: string,value: unknown) {
    const tx=this.db.transaction('rows','readwrite');tx.objectStore('rows').put(value,[generation,type,id]);await done(tx);
  }
  async value(generation: string,type: string,id: string) {return this.get('rows',[generation,type,id]);}
  private range(generation: string) {return IDBKeyRange.bound([generation],[generation,[]]);}
  async clone(from: string,to: string) {
    const tx=this.db.transaction('rows','readwrite');const store=tx.objectStore('rows');const cursor=store.openCursor(this.range(from));
    cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const key=c.key as string[];store.put(c.value,[to,...key.slice(1)]);c.continue();};await done(tx);
  }
  async discard(generation: string) {
    const tx=this.db.transaction('rows','readwrite');tx.objectStore('rows').delete(this.range(generation));await done(tx);
  }
  async apply(generation: string,event: DomainEvent) {
    // Each staged row is private; only the published pointer exposes a complete view.
    const previous=event.documentId?await this.value(generation,'document',event.documentId)??null:null;
    requireValue(!await this.value(generation,'event',event.eventId),'Duplicate event identity');
    if(event.type==='AssetRegistered'){requireValue(!await this.value(generation,'asset',event.payload.asset.id),'Duplicate asset');await this.put(generation,'asset',event.payload.asset.id,event.payload.asset);}
    else if(event.type==='BundleImported'||event.type==='DocumentCreated'||event.type==='CheckpointSaved'||event.type==='ImageEdited'||event.type==='HistoryNavigated'){
    const next=reduceDocument(previous,event);
    await this.put(generation,'document',next.id,next);
    if((event.type==='DocumentCreated'||event.type==='ImageEdited')) await this.put(generation,'history',event.payload.history.id,event.payload.history);
    else if(event.type==='CheckpointSaved') await this.put(generation,'checkpoint',event.payload.checkpoint.id,event.payload.checkpoint);
    }
    await this.put(generation,'event',event.eventId,event.workspaceSeq);
  }
  async applyEvents(generation: string,eventsStage: string,count: bigint) {
    for(let i=0n;i<count;i++) {const event=await this.value(eventsStage,'staged',String(i));requireValue(event);await this.apply(generation,event);}
  }
  async publish(next: Published,expected: Published) {
    const tx=this.db.transaction('meta','readwrite');const store=tx.objectStore('meta');const request=store.get('published');
    request.onsuccess=()=>{const current=request.result??{generation:'empty',cursor:'0',epoch:null};
      if(current.generation!==expected.generation||current.cursor!==expected.cursor||current.epoch!==expected.epoch)tx.abort();else store.put(next,'published');};await done(tx);
    // Old published data remains intact until the pointer transaction commits.
    await this.discard(expected.generation).catch(()=>{});
  }
  close(){this.db.close();}
}
