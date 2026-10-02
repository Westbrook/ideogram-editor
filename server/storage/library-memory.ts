import type {CompositionMemory} from './composition-memory.js';
import {StoreError} from './errors.js';

const MiB=1024**2;
// Application-owned logical payload allowances, not measured engine heap.
// Dependency scans:4MiB admitted JSON*12 +3MiB selected asset graph +2MiB IO
// and lookup scratch +3MiB result/clone/serialization overlap =56MiB.
export const STORAGE_OPERATION_BYTES=Object.freeze({summary:2*MiB,assets:8*MiB,dependencies:56*MiB,clear:2*MiB,review:24*MiB,repair:28*MiB});
// 128 cursors*8KiB +32 review authorities*256KiB +64 nonce identities*16KiB
// plus bounded map/clone bookkeeping. This grant contains no active reader.
export const STORAGE_REGISTRY_BYTES=16*MiB;
export type StorageLibraryKind=keyof typeof STORAGE_OPERATION_BYTES;
export type StorageLibraryScope=Readonly<{loanId:string;registryId:string;kind:StorageLibraryKind}>;
export type StorageLibraryLoan=Readonly<{check():void;release():void}>;

/** Sole-writer verifier for the existing main-thread central/mirrored loan.
 * This creates no second budget. Retained maps stay within the registry grant;
 * a request grant remains owned by its main-thread final consumer after release. */
export class StorageLibraryMemory {
  private registry:string|undefined;private active=new Map<string,StorageLibraryKind>();private closed=false;
  constructor(private memory:CompositionMemory){}
  enter(scope:StorageLibraryScope,kind:StorageLibraryKind):StorageLibraryLoan{
    if(!scope||!Object.hasOwn(STORAGE_OPERATION_BYTES,kind)||scope.kind!==kind||scope.loanId===scope.registryId||this.closed||this.active.has(scope.loanId)||this.active.size>=2)throw new StoreError('CAPACITY');
    scope=Object.freeze({loanId:scope.loanId,registryId:scope.registryId,kind:scope.kind});
    if(this.registry!==undefined&&this.registry!==scope.registryId)throw new StoreError('CAPACITY');
    const check=()=>{if(this.closed)throw new StoreError('CLOSED');this.memory.requireLoan(scope.registryId,STORAGE_REGISTRY_BYTES,'storage-registry');this.memory.requireLoan(scope.loanId,STORAGE_OPERATION_BYTES[kind],'storage-read');};
    check();this.registry=scope.registryId;this.active.set(scope.loanId,kind);let live=true;
    return Object.freeze({check:()=>{if(!live)throw new StoreError('CLOSED');check();},release:()=>{if(live){live=false;this.active.delete(scope.loanId);}}});
  }
  /** Exclude only the admitted operation and reader-free persistent map grant. */
  otherBytes(scope:StorageLibraryScope):number{
    if(!scope||this.active.get(scope.loanId)!==scope.kind||!Object.hasOwn(STORAGE_OPERATION_BYTES,scope.kind)||this.registry!==scope.registryId)throw new StoreError('CLOSED');
    this.memory.requireLoan(scope.registryId,STORAGE_REGISTRY_BYTES,'storage-registry');this.memory.requireLoan(scope.loanId,STORAGE_OPERATION_BYTES[scope.kind],'storage-read');
    return this.memory.bytesExcept([scope.loanId,scope.registryId]);
  }
  close(){if(this.active.size)throw new StoreError('CAPACITY');this.closed=true;this.registry=undefined;}
}
