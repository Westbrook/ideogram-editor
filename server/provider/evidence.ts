import { constants, openSync, closeSync, writeSync, readSync, fstatSync, fsyncSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertComponents, assertPrivate, privateDirectory, sameFile, syncDirectory } from '../storage/files.js';
import type { Objects } from '../storage/objects.js';
import { IO_CHUNK, ProviderError, refuse } from './contracts.js';
import type { AppliedPrivacyPolicy, ProtectedBody, TransferReservation, TransferSink, TransferIdentity } from './contracts.js';

export function r31Reservation(objects: Objects, id: string, purpose: TransferReservation['purpose'], check: () => void): TransferReservation {
  let committed = 0n, reservedThrough = 0n, released = false;
  objects.acquire(id);
  return { purpose,
    ensure(total) { check(); if (released || total < committed) refuse('CAPACITY');
      if (total > reservedThrough) { try{objects.reserve(id,total-committed);}catch(e){if((e as {code?:string}).code==='CAPACITY')throw new ProviderError('CAPACITY');throw e;} reservedThrough=total; } },
    committed(total) { check(); if (released || total < committed || total > reservedThrough) refuse('CAPACITY');
      committed=total; objects.reserve(id,reservedThrough-committed,false); },
    release() { if (!released) { released=true; objects.unreserve(id); objects.release(id); } }
  };
}
export function sanitizedHeaders(headers: Record<string, unknown>): Readonly<Record<string,string>> {
  const out: Record<string,string> = {};
  for (const [key,value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue;
    const k=key.toLowerCase();
    if (k==='content-length' && /^(0|[1-9][0-9]{0,19})$/.test(value)) out[k]=value;
    if (k==='content-type' && ['application/json','image/png','image/jpeg','image/webp','application/octet-stream'].includes(value)) out[k]=value;
    if (k==='retry-after' && /^[0-9]{1,8}$/.test(value)) out[k]=value;
  }
  return Object.freeze(out);
}
type Metadata = ProtectedBody & { retainedBytes: string; identity: TransferIdentity|null; headers: Readonly<Record<string,string>>; policy: AppliedPrivacyPolicy };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Not an Objects store: bodies have no domain BlobRef and no generic /assets route. */
export class TransportEvidenceStore {
  readonly directory: string;
  constructor(privateRoot: string) {
    assertComponents(privateRoot); assertPrivate(privateRoot,true);
    this.directory=join(privateRoot,'backend-transport'); privateDirectory(this.directory);
  }
  begin(attemptId: string, direction: 'request'|'response', reservation: TransferReservation,
    policy: AppliedPrivacyPolicy, headers: Record<string,unknown> = {}): TransferSink {
    if (!uuid.test(attemptId) || !['request','response'].includes(direction) || (direction==='request')!==(reservation.purpose==='provider-request')) refuse('IDENTITY');
    return this.writer(attemptId,direction,randomUUID(),reservation,policy,sanitizedHeaders(headers),false);
  }
  resume(recordId: string, reservation: TransferReservation): TransferSink {
    const metadata=this.inspect(recordId);
    if(metadata.completeness!=='partial') refuse('IDENTITY');
    return this.writer(metadata.attemptId,metadata.direction,recordId,reservation,metadata.policy,metadata.headers,true);
  }
  inspect(recordId: string): Metadata {
    if(!uuid.test(recordId)) refuse('IDENTITY');
    assertComponents(this.directory);assertPrivate(this.directory,true);
    const file=join(this.directory,recordId+'.json');assertPrivate(file,false);
    const value=JSON.parse(readFileSync(file,'utf8')) as Metadata;
    if(value.recordId!==recordId || value.class!=='backend-transport') refuse('PROVENANCE');
    return value;
  }
  *read(recordId: string): Generator<Buffer> {
    const meta=this.inspect(recordId), path=join(this.directory,recordId+'.body');
    const identity=assertPrivate(path,false), fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const hash=createHash('sha256');let count=0n;
    try {
      if(!sameFile(identity,fstatSync(fd)))refuse('PROVENANCE');
      for(;;){const chunk=Buffer.alloc(IO_CHUNK), n=readSync(fd,chunk);if(!n)break;count+=BigInt(n);hash.update(chunk.subarray(0,n));yield chunk.subarray(0,n);}
      if(count!==BigInt(meta.retainedBytes)||hash.digest('hex')!==meta.sha256)refuse('PROVENANCE');
    } finally {closeSync(fd);}
  }
  private writer(attemptId: string, direction: 'request'|'response', recordId: string, reservation: TransferReservation,
    policy: AppliedPrivacyPolicy, headers: Readonly<Record<string,string>>, resume: boolean): TransferSink {
    assertComponents(this.directory);assertPrivate(this.directory,true);
    const path=join(this.directory,recordId+'.body');
    const fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW|(resume?0:constants.O_CREAT|constants.O_EXCL),0o600);
    let bytes=0n, closed=false, identity:TransferIdentity|null=resume?this.inspect(recordId).identity:null;const hash=createHash('sha256');
    if(resume) { try {for(const chunk of this.read(recordId)){hash.update(chunk);bytes+=BigInt(chunk.byteLength);}}catch(e){closeSync(fd);reservation.release();throw e;} }
    const initial=bytes, directory=this.directory;
    const persist=(complete:boolean,observed=bytes): ProtectedBody => {
      const value: Metadata={class:'backend-transport',recordId,attemptId,direction,sha256:hash.copy().digest('hex'),
        receivedBytes:String(observed),retainedBytes:String(bytes),identity,completeness:complete?'complete':'partial',access:'backend-only',export:'never',headers,policy};
      if(!closed)fsyncSync(fd);
      const tmp=join(this.directory,recordId+'.'+randomUUID()+'.tmp');
      const metaFD=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {const content=Buffer.from(JSON.stringify(value));let at=0;while(at<content.length){const n=writeSync(metaFD,content,at);if(!n)refuse('CAPACITY');at+=n;}fsyncSync(metaFD);}finally{closeSync(metaFD);}
      renameSync(tmp,join(this.directory,recordId+'.json'));syncDirectory(this.directory);
      return Object.freeze(value);
    };
    try {persist(false);} catch(e){closeSync(fd);reservation.release();throw e;}
    return {
      owner:Object.freeze({attemptId,direction}),
      get bytes(){return bytes;},
      get identity(){return identity;},
      bindPolicy(value){if(bytes!==initial&&JSON.stringify(policy)!==JSON.stringify(value))refuse('POLICY');policy=Object.freeze({...value});persist(false);},
      recordHeaders(value){headers=sanitizedHeaders(value);persist(false);},
      bindIdentity(value){if(identity&&JSON.stringify(identity)!==JSON.stringify(value))refuse('IDENTITY');identity=Object.freeze({...value});persist(false);},
      prepare(total){if(closed||total<bytes)refuse('CAPACITY');reservation.ensure(total-initial);},
      append(chunk){
        if(closed||chunk.byteLength>IO_CHUNK)refuse('CAPACITY');
        assertComponents(directory);if(!sameFile(fstatSync(fd),assertPrivate(path,false)))refuse('PROVENANCE');
        reservation.ensure(bytes-initial+BigInt(chunk.byteLength));
        let at=0;
        try {while(at<chunk.byteLength){const n=writeSync(fd,chunk,at,chunk.byteLength-at,Number(bytes));if(!n)refuse('CAPACITY');hash.update(chunk.subarray(at,at+n));bytes+=BigInt(n);at+=n;}}
        finally {reservation.committed(bytes-initial);persist(false);}
      },
      digest(){return hash.copy().digest('hex');},
      finish(complete,observed){try{return persist(complete,observed);}finally{if(!closed){closeSync(fd);closed=true;reservation.release();}}}
    };
  }
}
