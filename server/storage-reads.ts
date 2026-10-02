import {CompositionReads,type CompositionRead} from './composition-memory.js';
import {STORAGE_OPERATION_BYTES,STORAGE_REGISTRY_BYTES,type StorageLibraryKind,type StorageLibraryScope} from './storage/library-memory.js';
import {StoreError} from './storage/errors.js';

type RPC=(method:string,args:Record<string,unknown>)=>Promise<unknown>;
export type StorageRead<T>=Pick<CompositionRead,'id'|'grow'|'release'>&Readonly<{value:T}>;
/** Reuses the central Composition read loan and sole-writer mirror. Admission
 * precedes native dispatch; no reply graph escapes without its final-consumer
 * lease. Registry ownership lasts until the actual writer exit. */
export class StorageReads {
  private requests:CompositionReads;private registries:CompositionReads;
  private registry:Promise<CompositionRead>|undefined;private ended=false;
  constructor(rpc:RPC){this.requests=new CompositionReads(rpc,'storage-library-read',2,'storage-read');this.registries=new CompositionReads(rpc,'storage-library-registry',1,'storage-registry');}
  private registryRead(){
    if(this.ended)throw new StoreError('CLOSED');
    if(!this.registry){
      const work=(async()=>{const read=await this.registries.open();try{await read.grow(STORAGE_REGISTRY_BYTES-1024**2);return read;}catch(error){try{await read.release();}catch(cleanup){throw new AggregateError([error,cleanup],'STORAGE_REGISTRY_RELEASE');}throw error;}})();
      this.registry=work;void work.catch(()=>{if(this.registry===work)this.registry=undefined;});
    }return this.registry;
  }
  async read<T>(kind:StorageLibraryKind,dispatch:(scope:StorageLibraryScope)=>Promise<T>):Promise<StorageRead<T>>{
    if(this.ended||!Object.hasOwn(STORAGE_OPERATION_BYTES,kind))throw new StoreError('CLOSED');
    const registry=await this.registryRead();if(this.ended)throw new StoreError('CLOSED');
    const read=await this.requests.open();let value:T|undefined,live=true;
    try{
      await read.grow(STORAGE_OPERATION_BYTES[kind]-1024**2);
      if(this.ended)throw new StoreError('CLOSED');
      value=await dispatch(Object.freeze({loanId:read.id,registryId:registry.id,kind}));
      return Object.freeze({id:read.id,grow:read.grow,get value(){if(!live)throw new StoreError('CLOSED');return value!;},release:async()=>{live=false;value=undefined;await read.release();}});
    }catch(error){value=undefined;try{await read.release();}catch(cleanup){throw new AggregateError([error,cleanup],'STORAGE_READ_RELEASE');}throw error;}
  }
  async nativeExited(){
    this.ended=true;this.requests.nativeExited();this.registries.nativeExited();
    const registry=this.registry;this.registry=undefined;
    if(registry){let read:CompositionRead;try{read=await registry;}catch{return;}await read.release();}
  }
}
