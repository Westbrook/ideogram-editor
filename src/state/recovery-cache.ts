import type { DomainEvent } from '../protocol/store.js';
import { reduceDocument } from './projection.js';
import { requireValue } from '../protocol/validate.js';
import { allocationLedger } from '../observability/allocations.js';
import { OwnedIDB } from './idb-ownership.js';
export type Published = { generation: string; cursor: string; epoch: string | null };
export class RecoveryPublicationConflict extends Error {
  constructor(){super('Projection changed in another tab');this.name='RecoveryPublicationConflict';}
}
export class RecoveryCache {
  private constructor(private readonly owned: OwnedIDB) {}
  static async open(name: string) {
    return new RecoveryCache(await OwnedIDB.open(name,'recovery',db=>{db.createObjectStore('rows');db.createObjectStore('meta');}));
  }
  private async get(store: string,key: IDBValidKey) {
    let value:any;
    return this.owned.run(store,'readonly',tx=>{this.owned.request(tx,()=>tx.objectStore(store).get(key),result=>{value=result;});return ()=>value;});
  }
  async published(): Promise<Published> { return await this.get('meta','published') ?? {generation:'empty',cursor:'0',epoch:null}; }
  async read(type: string,id: string) {
    // Keep pointer selection and row retrieval in one read lifetime. Another
    // tab may publish and discard the previous generation immediately after it.
    let value:unknown;
    return this.owned.run(['meta','rows'],'readonly',tx=>{
      this.owned.request(tx,()=>tx.objectStore('meta').get('published'),pointer=>{
        const view:Published=pointer??{generation:'empty',cursor:'0',epoch:null};
        this.owned.request(tx,()=>tx.objectStore('rows').get([view.generation,type,id]),row=>{value=row;});
      });return ()=>value;
    });
  }
  async collect<T>(type:string,include:(value:T)=>boolean,limit:number):Promise<T[]> {
    if(!Number.isSafeInteger(limit)||limit<0||limit>16)throw Error('CACHE_SELECTION_LIMIT');
    if(!limit)return [];
    // The caller owns its <=16 retained selections. This existing one-cursor
    // payload allowance is separate from native request/transaction handles;
    // it does not prove the size of an arbitrary legacy native IDB clone.
    const copy=allocationLedger.reserve({owner:'cache-selection-cursor',kind:'control',cpuBytes:1024*1024,handles:1});
    try{
      const values:T[]=[];
      return await this.owned.run(['meta','rows'],'readonly',tx=>{
        this.owned.request(tx,()=>tx.objectStore('meta').get('published'),pointer=>{
          const view:Published=pointer??{generation:'empty',cursor:'0',epoch:null};
          this.owned.request(tx,()=>tx.objectStore('rows').openCursor(IDBKeyRange.bound([view.generation,type],[view.generation,type,[]],true,true)),row=>{
            if(row){if(include(row.value))values.push(row.value);if(values.length<limit)row.continue();}
          },true);
        });return ()=>values;
      });
    }finally{copy.release();}
  }
  async put(generation: string,type: string,id: string,value: unknown) {
    await this.owned.run('rows','readwrite',tx=>{this.owned.request(tx,()=>tx.objectStore('rows').put(value,[generation,type,id]));return ()=>{};});
  }
  async value(generation: string,type: string,id: string) {return this.get('rows',[generation,type,id]);}
  async *rows(generation: string,type: string) {
    // Never yield a native cursor or suspend with an active transaction. The
    // RecoveryWorkspace/caller retains the row payload under its existing slot.
    let after:IDBValidKey=[generation,type];
    for(;;){
      let selected:{key:IDBValidKey;id:string;value:any}|null=null;
      const row=await this.owned.run('rows','readonly',tx=>{
        this.owned.request(tx,()=>tx.objectStore('rows').openCursor(IDBKeyRange.bound(after,[generation,type,[]],true,true)),cursor=>{
          if(cursor)selected={key:cursor.key,id:String((cursor.key as string[])[2]),value:cursor.value};
        },true);return ()=>selected;
      });
      if(!row)return;after=row.key;yield {id:row.id,value:row.value};
    }
  }
  private range(generation: string) {return IDBKeyRange.bound([generation],[generation,[]]);}
  async clone(from: string,to: string) {
    // Pin base selection and copying in one transaction. Each observed completed
    // write retires its request token; the cursor and transaction stay owned.
    await this.owned.run(['meta','rows'],'readwrite',tx=>{
      const store=tx.objectStore('rows');
      this.owned.request(tx,()=>tx.objectStore('meta').get('published'),pointer=>{
        if((pointer?.generation??'empty')!==from)throw new RecoveryPublicationConflict();
        this.owned.request(tx,()=>store.openCursor(this.range(from)),cursor=>{
          if(!cursor)return;const key=cursor.key as string[];
          this.owned.request(tx,()=>store.put(cursor.value,[to,...key.slice(1)]));cursor.continue();
        },true);
      });return ()=>{};
    });
  }
  async discard(generation: string) {
    await this.owned.run('rows','readwrite',tx=>{this.owned.request(tx,()=>tx.objectStore('rows').delete(this.range(generation)));return ()=>{};});
  }
  async apply(generation: string,event: DomainEvent) {
    // Checks and their writes remain in one transaction. No await crosses its
    // active callbacks; a failed reducer/write cannot publish an event marker.
    await this.owned.run('rows','readwrite',tx=>{
      const store=tx.objectStore('rows'),checks:[string,string][]=[['event',event.eventId]];
      if(event.documentId)checks.push(['document',event.documentId]);
      if(event.type==='AssetRegistered')checks.push(['asset',event.payload.asset.id]);
      if(event.type==='BundleImported')checks.push(['namespace',event.payload.namespaceId]);
      const values=new Map<string,any>();let remaining=checks.length;
      const put=(type:string,id:string,value:unknown)=>this.owned.request(tx,()=>store.put(value,[generation,type,id]));
      for(const [type,id]of checks)this.owned.request(tx,()=>store.get([generation,type,id]),value=>{
        values.set(type,value);if(--remaining)return;
        requireValue(!values.get('event'),'Duplicate event identity');
        if(event.type==='DocumentDeleted'){this.owned.request(tx,()=>store.delete([generation,'document',event.payload.id]));}
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
      });return ()=>{};
    });
  }
  async applyEvents(generation: string,eventsStage: string,count: bigint) {
    for(let i=0n;i<count;i++) {const event=await this.value(eventsStage,'staged',String(i));requireValue(event);await this.apply(generation,event);}
  }
  async publish(next: Published,expected: Published) {
    await this.owned.run('meta','readwrite',tx=>{
      const store=tx.objectStore('meta');
      this.owned.request(tx,()=>store.get('published'),pointer=>{
        const current=pointer??{generation:'empty',cursor:'0',epoch:null};
        if(current.generation!==expected.generation||current.cursor!==expected.cursor||current.epoch!==expected.epoch)throw new RecoveryPublicationConflict();
        this.owned.request(tx,()=>store.put(next,'published'));
      });return ()=>{};
    });
    // Old published data remains intact until the pointer transaction commits.
    await this.discard(expected.generation).catch(()=>{});
  }
  close(){this.owned.close();}
}
