import type { DomainEvent } from '../protocol/store.js';
import type { EventPage, ProtocolContentRef, RecoveryContext, SnapshotDescriptor, TransactionReference, EventBatch, StreamEnvelope } from '../protocol/recovery.js';
import { canonical, parseControlJSON } from '../protocol/json.js';
import { SHA256 } from '../protocol/sha256.js';
import { event as validateEvent, entity, id, seq, keys, requireValue as ok } from '../protocol/validate.js';
import { RecoveryCache } from './recovery-cache.js';
import type { Published } from './recovery-cache.js';
const encode = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
type Transport = (path: string, init?: RequestInit) => Promise<Response>;
function context(value: any): asserts value is RecoveryContext {
  keys(value,['recoveryId','writerEpoch','projectionSchema','highWater','expiresAt']);
  ok(id(value.recoveryId)&&seq(value.writerEpoch)&&seq(value.highWater)&&[2,3].includes(value.projectionSchema)&&Number.isFinite(Date.parse(value.expiresAt)));
}
function sameContext(a: RecoveryContext,b: RecoveryContext) {
  context(a);context(b);ok(a.recoveryId===b.recoveryId&&a.writerEpoch===b.writerEpoch&&a.highWater===b.highWater&&a.projectionSchema===b.projectionSchema,'Recovery context changed');
}
function content(ref: ProtocolContentRef, recovery: RecoveryContext, encoding: ProtocolContentRef['encoding']) {
  keys(ref,['contentId','url','blob','encoding','recordCount','expiresAt']);keys(ref.blob,['hash','byteLength','mediaType']);
  ok(id(ref.contentId)&&ref.url===`/api/v1/protocol-content/${ref.contentId}?recoveryId=${recovery.recoveryId}`&&
    ref.encoding===encoding&&ref.blob.mediaType==='application/x-ndjson'&&/^sha256:[a-f0-9]{64}$/.test(ref.blob.hash)&&seq(ref.blob.byteLength)&&seq(ref.recordCount)&&Number.isFinite(Date.parse(ref.expiresAt)));
}
export class RecoveryConsumer {
  private active = false;
  constructor(readonly cache: RecoveryCache, private transport: Transport = (path,init)=>fetch(path,{...init,credentials:'same-origin',headers:{'X-App-Client':'LP-1',...init?.headers}}), private csrf?: () => string) {}
  async cursor() {return (await this.cache.published()).cursor;}
  async reconnectURL() {return '/api/v1/events/stream?after='+await this.cursor();}
  private async control(response: Response) {
    ok(response.headers.get('content-type')?.startsWith('application/json'));ok(response.body);
    const reader=response.body.getReader();let total=0;const parts:Uint8Array[]=[];
    try {for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;ok(total<=65536);parts.push(value);}}
    finally{await reader.cancel();}
    const bytes=new Uint8Array(total);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return parseControlJSON(bytes) as any;
  }
  private async rows(ref: ProtocolContentRef,recovery:RecoveryContext,encoding:ProtocolContentRef['encoding'],accept:(value:any,index:bigint)=>Promise<void>) {
    content(ref,recovery,encoding);const response=await this.transport(ref.url);
    ok(response.status===200&&response.headers.get('etag')==='"'+ref.blob.hash+'"'&&response.headers.get('content-type')===ref.blob.mediaType&&
      response.headers.get('content-length')===ref.blob.byteLength&&response.body,'Content descriptor mismatch');
    const reader=response.body.getReader();const hash=new SHA256();let bytes=0n;let count=0n;let pending=new Uint8Array(0);
    try {
      for(;;){const {value,done}=await reader.read();if(done)break;
        bytes+=BigInt(value.length);ok(bytes<=BigInt(ref.blob.byteLength));hash.update(value);
        // Consume any network chunk in bounded slices; no whole content buffering.
        for(let at=0;at<value.length;){const n=Math.min(16384,value.length-at);const joined=new Uint8Array(pending.length+n);joined.set(pending);joined.set(value.subarray(at,at+n),pending.length);at+=n;
          let start=0;for(let i=0;i<joined.length;i++)if(joined[i]===10){const line=joined.subarray(start,i);ok(line.length+(encoding==='lp1-snapshot-jsonl'?1:0)<=16384);
            const row=parseControlJSON(line);ok(canonical(row)===decode(line));await accept(row,count++);start=i+1;}
          pending=joined.slice(start);ok(pending.length<=16384);
        }
      }
      ok(pending.length===0&&bytes===BigInt(ref.blob.byteLength)&&String(count)===ref.recordCount&&hash.digest()===ref.blob.hash,'Content integrity check failed');
    } finally {await reader.cancel();}
  }
  private async batch(generation:string,batch:EventBatch|TransactionReference,cursor:string,recovery:RecoveryContext) {
    ok(id(batch.transactionId)&&seq(batch.fromSeq)&&seq(batch.toSeq)&&BigInt(batch.fromSeq)===BigInt(cursor)+1n&&BigInt(batch.toSeq)>=BigInt(batch.fromSeq)&&BigInt(batch.toSeq)<=BigInt(recovery.highWater));
    let count=0n;let commandId:string|undefined;const stage=crypto.randomUUID();
    const accept=async(v:any)=>{validateEvent(v);ok(v.transactionId===batch.transactionId&&BigInt(v.workspaceSeq)===BigInt(batch.fromSeq)+count);
      if(commandId===undefined)commandId=v.commandId;ok(v.commandId===commandId);await this.cache.put(stage,'staged',String(count++),v);};
    try {
      if(batch.kind==='inline') {keys(batch,['kind','transactionId','fromSeq','toSeq','events']);ok(Array.isArray(batch.events));for(const event of batch.events)await accept(event);}
      else {keys(batch,['kind','transactionId','fromSeq','toSeq','eventCount','recovery','content']);sameContext(recovery,batch.recovery);ok(seq(batch.eventCount)&&batch.eventCount===batch.content.recordCount);
        await this.rows(batch.content,recovery,'lp1-events-jsonl',accept);ok(String(count)===batch.eventCount);}
      ok(count===BigInt(batch.toSeq)-BigInt(batch.fromSeq)+1n,'Incomplete transaction');
      await this.cache.applyEvents(generation,stage,count);return batch.toSeq;
    } finally {await this.cache.discard(stage);}
  }
  private async snapshot(generation:string,descriptor:SnapshotDescriptor) {
    keys(descriptor,['protocolVersion','snapshotId','metadataUrl','snapshotSeq','recovery','content']);context(descriptor.recovery);
    ok(descriptor.protocolVersion===1&&id(descriptor.snapshotId)&&seq(descriptor.snapshotSeq)&&BigInt(descriptor.snapshotSeq)<=BigInt(descriptor.recovery.highWater)&&descriptor.metadataUrl===`/api/v1/snapshots/${descriptor.snapshotId}?recoveryId=${descriptor.recovery.recoveryId}`);
    const metadata=await this.transport(descriptor.metadataUrl);ok(metadata.status===200);const actual=await this.control(metadata);
    sameContext(descriptor.recovery,actual.recovery);ok(actual.snapshotId===descriptor.snapshotId&&actual.snapshotSeq===descriptor.snapshotSeq&&canonical(actual.content.blob)===canonical(descriptor.content.blob)&&actual.content.recordCount===descriptor.content.recordCount);
    let count=0n;let expected='';let key='';let previous='';let part=0;let parts=0;let text='';let version='';
    await this.rows(descriptor.content,descriptor.recovery,'lp1-snapshot-jsonl',async(row,index)=>{
      if(index===0n){keys(row,['kind','snapshotId','snapshotSeq','projectionSchema','entityCount']);ok(row.kind==='header'&&row.snapshotId===descriptor.snapshotId&&row.snapshotSeq===descriptor.snapshotSeq&&[2,3].includes(row.projectionSchema)&&seq(row.entityCount));expected=row.entityCount;return;}
      keys(row,['kind','entityType','entityId','entityVersion','partIndex','partCount','utf8Base64']);
      ok(row.kind==='projection-part'&&['asset','document','history','checkpoint'].includes(row.entityType)&&id(row.entityId)&&seq(row.entityVersion)&&Number.isSafeInteger(row.partIndex)&&Number.isSafeInteger(row.partCount)&&row.partCount>0&&typeof row.utf8Base64==='string');
      const next=row.entityType+':'+row.entityId;
      if(!part){ok(next>previous);key=next;parts=row.partCount;version=row.entityVersion;}
      ok(next===key&&parts===row.partCount&&part===row.partIndex&&version===row.entityVersion);
      const raw=atob(row.utf8Base64);ok(btoa(raw)===row.utf8Base64);const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));text+=decode(bytes);
      // Narrow current entities fit64KiB; future owners must extend typed streaming
      // projection storage deliberately instead of accumulating arbitrary JSON.
      ok(encode.encode(text).length<=65536);
      if(++part===parts){const value=parseControlJSON(encode.encode(text));ok(canonical(value)===text&&value.id===row.entityId&&entity(row.entityType,value)===version);
        await this.cache.put(generation,row.entityType,row.entityId,value);count++;previous=key;part=0;text='';}
    });ok(part===0&&String(count)===expected,'Incomplete snapshot');return descriptor.snapshotSeq;
  }
  private async page(generation:string,value:any,cursor:string,pinned?:RecoveryContext) {
    keys(value,['protocolVersion','kind','recovery','nextCursor','more','batches']);context(value.recovery);
    ok(value.protocolVersion===1&&value.kind==='batches'&&seq(value.nextCursor)&&typeof value.more==='boolean'&&Array.isArray(value.batches));
    if(pinned)sameContext(pinned,value.recovery);
    for(const batch of value.batches)cursor=await this.batch(generation,batch,cursor,value.recovery);
    ok(cursor===value.nextCursor&&BigInt(cursor)<=BigInt(value.recovery.highWater)&&value.more===(cursor!==value.recovery.highWater));
    ok(!value.more||value.batches.length>0,'Empty nonterminal page');return cursor;
  }
  async recover() {
    ok(!this.active,'Recovery is already active');this.active=true;const old=await this.cache.published();const generation=crypto.randomUUID();let pinned:RecoveryContext|undefined;
    try {
      let cursor=old.cursor;let response=await this.transport('/api/v1/events?after='+cursor);let value=await this.control(response);
      if(response.status===410&&value.error?.code==='CURSOR_GAP'){
        const detail=value.error.details;ok(detail?.kind==='inline'&&detail.value?.kind==='cursor-gap'&&detail.value.requestedAfter===cursor);
        const descriptor=detail.value.snapshot as SnapshotDescriptor;pinned=descriptor.recovery;cursor=await this.snapshot(generation,descriptor);
        ok(detail.value.earliestAvailable===cursor);
        response=await this.transport('/api/v1/events?after='+cursor+'&recoveryId='+pinned.recoveryId);value=await this.control(response);
      }else{ok(response.status===200);await this.cache.clone(old.generation,generation);}
      for(;;){ok(response.status===200);cursor=await this.page(generation,value,cursor,pinned);pinned??=value.recovery;
        if(!value.more)break;response=await this.transport('/api/v1/events?after='+cursor+'&recoveryId='+pinned!.recoveryId);value=await this.control(response);}
      // Revalidate lease/epoch after downloads before the one publication point.
      const final=await this.transport('/api/v1/events?after='+cursor+'&recoveryId='+pinned!.recoveryId);ok(final.status===200);
      const check=await this.control(final);await this.page(generation,check,cursor,pinned);ok(!check.more&&check.batches.length===0);
      await this.cache.publish({generation,cursor,epoch:pinned!.writerEpoch},old);return cursor;
    }catch(error){await this.cache.discard(generation);throw error;}finally{if(pinned && this.csrf) await this.transport('/api/v1/recovery/'+pinned.recoveryId+'/release',{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':this.csrf()},body:'{"protocolVersion":1}'}).catch(()=>{});this.active=false;}
  }
  async consumeStream(signal?:AbortSignal) {
    ok(!this.active,'Recovery is already active');this.active=true;let old=await this.cache.published();let stage:string|undefined;let generation:string|undefined;
    let transaction:{id:string;from:string;to:string;parts:number;next:number;count:bigint;command?:string}|undefined;
    try {
      const response=await this.transport('/api/v1/events/stream?after='+old.cursor,{signal});ok(response.status===200&&response.headers.get('content-type')?.startsWith('text/event-stream')&&response.body);
      const reader=response.body.getReader();let pending='';const decoder=new TextDecoder('utf-8',{fatal:true});
      const frame=async(text:string)=>{
        const lines=text.split('\n');ok(lines.every(l=>l.startsWith('data: ')||l.startsWith('id: '))&&lines.filter(l=>l.startsWith('data: ')).length===1&&lines.filter(l=>l.startsWith('id: ')).length<=1);
        const body=parseControlJSON(encode.encode(lines.find(l=>l.startsWith('data: '))!.slice(6))) as StreamEnvelope;
        const offered=lines.find(l=>l.startsWith('id: '))?.slice(4);ok(body.protocolVersion===1);
        if(body.kind==='checkpoint'){keys(body,['protocolVersion','kind','highWater']);ok(!transaction&&!offered&&body.highWater===old.cursor);return;}
        if(body.kind==='error'||body.kind==='gap')throw new Error('Stream requires read recovery');
        const to=body.kind==='transaction-ref'?body.reference.toSeq:body.toSeq;
        if(BigInt(to)<=BigInt(old.cursor)){ok(!transaction);return;}
        generation??=crypto.randomUUID();await this.cache.clone(old.generation,generation);
        if(body.kind==='transaction-ref'){
          keys(body,['protocolVersion','kind','reference']);ok(!transaction&&offered===to);const r=body.reference;context(r.recovery);
          await this.batch(generation,r,old.cursor,r.recovery);
          const proof=await this.transport('/api/v1/events?after='+to+'&recoveryId='+r.recovery.recoveryId);ok(proof.status===200);const page=await this.control(proof);sameContext(r.recovery,page.recovery);
          await this.cache.publish({generation,cursor:to,epoch:r.recovery.writerEpoch},old);old=await this.cache.published();generation=undefined;
        }else{
          keys(body,['protocolVersion','kind','transactionId','fromSeq','toSeq','partIndex','partCount','events']);
          ok(id(body.transactionId)&&seq(body.fromSeq)&&seq(body.toSeq)&&Number.isSafeInteger(body.partCount)&&body.partCount>0&&Number.isSafeInteger(body.partIndex)&&Array.isArray(body.events));
          if(!transaction){ok(body.partIndex===0&&BigInt(body.fromSeq)===BigInt(old.cursor)+1n);stage=crypto.randomUUID();transaction={id:body.transactionId,from:body.fromSeq,to:body.toSeq,parts:body.partCount,next:0,count:0n};}
          const tx=transaction;ok(tx.id===body.transactionId&&tx.from===body.fromSeq&&tx.to===body.toSeq&&tx.parts===body.partCount&&tx.next++===body.partIndex);
          for(const e of body.events){validateEvent(e);ok(e.transactionId===tx.id&&BigInt(e.workspaceSeq)===BigInt(tx.from)+tx.count);tx.command??=e.commandId;ok(e.commandId===tx.command);await this.cache.put(stage!,'staged',String(tx.count++),e);}
          if(tx.next===tx.parts){ok(offered===tx.to&&tx.count===BigInt(tx.to)-BigInt(tx.from)+1n);await this.cache.applyEvents(generation,stage!,tx.count);
            await this.cache.publish({generation,cursor:tx.to,epoch:old.epoch},old);old=await this.cache.published();await this.cache.discard(stage!);stage=undefined;generation=undefined;transaction=undefined;
          }else ok(offered===undefined);
        }
      };
      try{for(;;){const {value,done}=await reader.read();if(done)break;
        for(let at=0;at<value.length;at+=16384){pending+=decoder.decode(value.subarray(at,at+16384),{stream:true});let end:number;
          while((end=pending.indexOf('\n\n'))!==-1){const text=pending.slice(0,end);ok(encode.encode(text).length<=65664);pending=pending.slice(end+2);await frame(text);}ok(encode.encode(pending).length<=65664);}
      }pending+=decoder.decode();ok(!pending&&!transaction,'Partial stream transaction');}finally{await reader.cancel();}
    }finally{if(stage)await this.cache.discard(stage);if(generation)await this.cache.discard(generation);this.active=false;}
  }
}
