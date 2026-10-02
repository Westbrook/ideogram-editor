import {supportsProjectionSchema,projectionEntity,projectionEvent} from '../protocol/projection-schema.js';
import {RecoveryWorkspace,RecoveryEntityBuffer,RecoveryCleanupError} from '../observability/recovery-memory.js';
import type { Document, DomainEvent } from '../protocol/store.js';
import type { EventPage, ProtocolContentRef, RecoveryContext, SnapshotDescriptor, TransactionReference, EventBatch, StreamEnvelope } from '../protocol/recovery.js';
import { canonical, parseControlJSON } from '../protocol/json.js';
import { SHA256 } from '../protocol/sha256.js';
import { id, seq, keys, requireValue as ok } from '../protocol/validate.js';
import { RecoveryCache } from './recovery-cache.js';
import type { Published } from './recovery-cache.js';
const encode = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
type Transport = (path: string, init?: RequestInit) => Promise<Response>;
function context(value: any): asserts value is RecoveryContext {
  keys(value,['recoveryId','writerEpoch','projectionSchema','highWater','expiresAt']);
  ok(id(value.recoveryId)&&seq(value.writerEpoch)&&seq(value.highWater)&&supportsProjectionSchema(value.projectionSchema)&&Number.isFinite(Date.parse(value.expiresAt)));
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
  private active = false;private workspace?:RecoveryWorkspace;private operation?:Promise<unknown>;private releaseFailure?:unknown;
  private begin<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    ok(!this.active,'Recovery is already active');if(this.releaseFailure)throw this.releaseFailure;
    const workspace=new RecoveryWorkspace(signal);this.workspace=workspace;this.active=true;
    const pending=Promise.resolve().then(work).finally(async()=>{try{await workspace.release();}catch(error){this.releaseFailure=error;throw error;}finally{if(this.workspace===workspace&&!this.releaseFailure)this.workspace=undefined;this.active=false;if(this.operation===pending)this.operation=undefined;}});this.operation=pending;return pending;
  }
  cancel(){this.workspace?.cancel();}
  async release(){this.cancel();await this.operation?.catch(error=>{if(error instanceof RecoveryCleanupError)throw error;});if(this.workspace){try{await this.workspace.release();this.workspace=undefined;this.releaseFailure=undefined;}catch(error){this.releaseFailure=error;throw error;}}if(this.releaseFailure)throw this.releaseFailure;}
  get ownership(){return Object.freeze({active:this.active,cleanupFailed:!!this.releaseFailure});}
  private request(path:string,init?:RequestInit){if(!this.workspace)throw Error('RECOVERY_WORKSPACE');return this.workspace.request(this.transport,path,init);}
  recover(signal?:AbortSignal){return this.begin(()=>this.recoverOwned(),signal);}
  consumeStream(signal?:AbortSignal){return this.begin(()=>this.consumeStreamOwned(),signal);}
  constructor(readonly cache: RecoveryCache, private transport: Transport = (path,init)=>fetch(path,{...init,credentials:'same-origin',headers:{'X-App-Client':'LP-1',...init?.headers}}), private csrf?: () => string) {}
  async cursor() {return (await this.cache.published()).cursor;}
  async reconnectURL() {return '/api/v1/events/stream?after='+await this.cursor();}
  private async control(response: Response) {
    ok(response.headers.get('content-type')?.startsWith('application/json'));ok(response.body);
    const bytes=new Uint8Array(65536);let total=0;
    for await(const value of this.workspace!.chunks(response)){ok(value.byteLength<=bytes.length-total);bytes.set(value,total);total+=value.byteLength;}
    return parseControlJSON(bytes.subarray(0,total)) as any;
  }
  private async rows(ref: ProtocolContentRef,recovery:RecoveryContext,encoding:ProtocolContentRef['encoding'],accept:(value:any,index:bigint)=>Promise<void>) {
    content(ref,recovery,encoding);const response=await this.request(ref.url);
    ok(response.status===200&&response.headers.get('etag')==='"'+ref.blob.hash+'"'&&response.headers.get('content-type')===ref.blob.mediaType&&
      response.headers.get('content-length')===ref.blob.byteLength&&response.body,'Content descriptor mismatch');
    const hash=new SHA256(),line=new Uint8Array(16384);let bytes=0n,count=0n,used=0,sliceStart=performance.now();
    for await(const value of this.workspace!.chunks(response)){
      bytes+=BigInt(value.length);ok(bytes<=BigInt(ref.blob.byteLength));
      for(let at=0;at<value.length;){
        const end=Math.min(value.length,at+16384);hash.update(value.subarray(at,end));
        for(;at<end;at++){
          if(value[at]===10){ok(used+(encoding==='lp1-snapshot-jsonl'?1:0)<=16384);const payload=line.subarray(0,used),row=parseControlJSON(payload);ok(canonical(row)===decode(payload));await accept(row,count++);this.workspace!.check();used=0;}
          else{ok(used<line.length);line[used++]=value[at];}
        }
        if(performance.now()-sliceStart>=4){await new Promise<void>(resolve=>setTimeout(resolve,0));this.workspace!.check();sliceStart=performance.now();}
      }
    }
    ok(used===0&&bytes===BigInt(ref.blob.byteLength)&&String(count)===ref.recordCount&&hash.digest()===ref.blob.hash,'Content integrity check failed');
  }
  private async batch(generation:string,batch:EventBatch|TransactionReference,cursor:string,recovery:RecoveryContext) {
    this.workspace!.check();
    ok(id(batch.transactionId)&&seq(batch.fromSeq)&&seq(batch.toSeq)&&BigInt(batch.fromSeq)===BigInt(cursor)+1n&&BigInt(batch.toSeq)>=BigInt(batch.fromSeq)&&BigInt(batch.toSeq)<=BigInt(recovery.highWater));
    let count=0n;let commandId:string|undefined;const stage=crypto.randomUUID();
    const accept=async(v:any)=>{this.workspace!.check();projectionEvent(recovery.projectionSchema,v);ok(v.transactionId===batch.transactionId&&BigInt(v.workspaceSeq)===BigInt(batch.fromSeq)+count);
      if(commandId===undefined)commandId=v.commandId;ok(v.commandId===commandId);await this.cache.put(stage,'staged',String(count++),v);};
    try {
      if(batch.kind==='inline') {keys(batch,['kind','transactionId','fromSeq','toSeq','events']);ok(Array.isArray(batch.events));for(const event of batch.events)await accept(event);}
      else {keys(batch,['kind','transactionId','fromSeq','toSeq','eventCount','recovery','content']);sameContext(recovery,batch.recovery);ok(seq(batch.eventCount)&&batch.eventCount===batch.content.recordCount);
        await this.rows(batch.content,recovery,'lp1-events-jsonl',accept);ok(String(count)===batch.eventCount);}
      ok(count===BigInt(batch.toSeq)-BigInt(batch.fromSeq)+1n,'Incomplete transaction');
      for(let i=0n;i<count;i++){
        this.workspace!.check();
        const event=await this.cache.value(stage,'staged',String(i));ok(event);
        if(event.type==='BundleImported')await this.namespace(generation,event,recovery);
        await this.cache.apply(generation,event);
      }return batch.toSeq;
    } finally {await this.cache.discard(stage);}
  }
  private async namespace(generation:string,event:Extract<DomainEvent,{type:'BundleImported'}>,recovery:RecoveryContext){
    const response=await this.request('/api/v1/namespace-events/'+event.eventId+'?recoveryId='+recovery.recoveryId);ok(response.status===200);
    const descriptor=await this.control(response);keys(descriptor,['protocolVersion','eventId','namespaceId','namespaceHash','workspaceSeq','content','recovery']);
    sameContext(recovery,descriptor.recovery);
    ok(descriptor.protocolVersion===1&&descriptor.eventId===event.eventId&&descriptor.namespaceId===event.payload.namespaceId&&descriptor.namespaceHash===event.payload.namespaceHash&&descriptor.workspaceSeq===event.workspaceSeq);
    const namespace=crypto.randomUUID();
    try {
    let expected='',count=0n,previous='',key='',part=0,parts=0,version='',documents=0;const assembled=new RecoveryEntityBuffer();
    await this.rows(descriptor.content,recovery,'lp1-namespace-jsonl',async(row,index)=>{
      if(index===0n){
        keys(row,['kind','namespaceId','namespaceHash','eventId','workspaceSeq','projectionSchema','entityCount']);
        ok(row.kind==='header'&&row.namespaceId===event.payload.namespaceId&&row.namespaceHash===event.payload.namespaceHash&&row.eventId===event.eventId&&row.workspaceSeq===event.workspaceSeq&&row.projectionSchema===recovery.projectionSchema&&seq(row.entityCount));expected=row.entityCount;return;
      }
      keys(row,['kind','entityType','entityId','entityVersion','partIndex','partCount','utf8Base64']);
      ok(row.kind==='projection-part'&&['asset','checkpoint','document','history'].includes(row.entityType)&&id(row.entityId)&&seq(row.entityVersion)&&Number.isSafeInteger(row.partIndex)&&Number.isSafeInteger(row.partCount)&&row.partCount>0&&typeof row.utf8Base64==='string');
      const next=row.entityType+':'+row.entityId;if(!part){ok(next>previous);key=next;parts=row.partCount;version=row.entityVersion;}
      ok(next===key&&parts===row.partCount&&part===row.partIndex&&version===row.entityVersion);
      assembled.append(row.utf8Base64);
      if(++part===parts){
        const value=parseControlJSON(assembled.value()) as any;ok(canonical(value)===assembled.text()&&value.id===row.entityId&&projectionEntity(recovery.projectionSchema,row.entityType,value)===version);
        ok(!await this.cache.value(generation,row.entityType,row.entityId),'Namespace row collision');
        if(row.entityType==='document'){ok(canonical(value)===canonical(event.payload.document));documents++;}
        else if(row.entityType==='history'||row.entityType==='checkpoint')ok(value.documentId===event.documentId);
        await this.cache.put(namespace,row.entityType,row.entityId,value);
        count++;previous=key;part=0;assembled.clear();
      }
    });
    ok(part===0&&documents===1&&String(count)===expected,'Incomplete imported namespace');
    await this.namespaceLinks(namespace,event.payload.document);
    for(const type of ['asset','checkpoint','history'])for await(const row of this.cache.rows(namespace,type)){this.workspace!.check();await this.cache.put(generation,type,row.id,row.value);}
    // This marker and all hydrated rows are still private to the staged
    // generation. The existing pointer transaction is the only publication.
    await this.cache.put(generation,'namespace',event.payload.namespaceId,{eventId:event.eventId,namespaceHash:event.payload.namespaceHash});
    } finally {await this.cache.discard(namespace);}
  }
  private async namespaceLinks(namespace:string,document:Document) {
    // Resolve only rows delivered for this import, never a coincident ID in
    // an unrelated document or the previously published generation.
    const owned=async(type:string,id:string)=>{
      this.workspace!.check();
      const row=await this.cache.value(namespace,type,id);
      ok(row&&(type==='asset'||row.documentId===document.id),'Missing imported '+type+' link');return row;
    };
    const image=async(value:any)=>{if(value?.compositeAssetId!==null&&value?.compositeAssetId!==undefined)await owned('asset',value.compositeAssetId);};
    const head=await owned('history',document.historyHead);
    if(document.checkpoint)await owned('checkpoint',document.checkpoint);
    if(document.redo){const redo=await owned('history',document.redo);ok(redo.parent===document.historyHead,'Invalid imported redo link');}
    await image(document.image);
    if(head.kind==='image-edit')ok(canonical(head.after)===canonical(document.image),'Invalid imported current history');
    for await(const {value:h} of this.cache.rows(namespace,'history')){
      if(h.parent!==null){const parent=await owned('history',h.parent),before=parent.kind==='image-edit'?parent.after:parent.forward.after.image;
        if(before)ok(canonical(h.before)===canonical(before),'Invalid imported history parent state');}
      await image(h.kind==='image-edit'?h.before:h.forward.after.image);if(h.kind==='image-edit')await image(h.after);
    }
    for await(const {value:c} of this.cache.rows(namespace,'checkpoint')){
      const h=await owned('history',c.historyHead);await image(c.image);
      if(h.kind==='image-edit')ok(canonical(c.image)===canonical(h.after),'Invalid imported checkpoint state');
    }
    for await(const {value:a} of this.cache.rows(namespace,'asset'))for(const id of a.raster?.sourceAssetIds??[])await owned('asset',id);
    // Bounded IndexedDB marks validate every retained branch/dependency,
    // including non-head rows and cycles, without a resident graph or depth cap.
    for(const type of ['history','asset'])for(;;){let remaining=0n,progress=0n;
      for await(const {id,value} of this.cache.rows(namespace,type)){
        this.workspace!.check();
        if(await this.cache.value(namespace,'checked-'+type,id))continue;remaining++;
        const parents=type==='history'?(value.parent===null?[]:[value.parent]):value.raster?.sourceAssetIds??[];
        let ready=true;for(const parent of parents)if(!await this.cache.value(namespace,'checked-'+type,parent)){ready=false;break;}
        if(ready){await this.cache.put(namespace,'checked-'+type,id,true);progress++;}
      }
      if(!remaining)break;ok(progress>0n,'Invalid imported '+type+' graph');
    }
  }
  private async snapshot(generation:string,descriptor:SnapshotDescriptor) {
    keys(descriptor,['protocolVersion','snapshotId','metadataUrl','snapshotSeq','recovery','content']);context(descriptor.recovery);
    ok(descriptor.protocolVersion===1&&id(descriptor.snapshotId)&&seq(descriptor.snapshotSeq)&&BigInt(descriptor.snapshotSeq)<=BigInt(descriptor.recovery.highWater)&&descriptor.metadataUrl===`/api/v1/snapshots/${descriptor.snapshotId}?recoveryId=${descriptor.recovery.recoveryId}`);
    const metadata=await this.request(descriptor.metadataUrl);ok(metadata.status===200);const actual=await this.control(metadata);
    sameContext(descriptor.recovery,actual.recovery);ok(actual.snapshotId===descriptor.snapshotId&&actual.snapshotSeq===descriptor.snapshotSeq&&canonical(actual.content.blob)===canonical(descriptor.content.blob)&&actual.content.recordCount===descriptor.content.recordCount);
    let projectionSchema=0;let count=0n;let expected='';let key='';let previous='';let part=0;let parts=0;let version='';const assembled=new RecoveryEntityBuffer();
    await this.rows(descriptor.content,descriptor.recovery,'lp1-snapshot-jsonl',async(row,index)=>{
      if(index===0n){keys(row,['kind','snapshotId','snapshotSeq','projectionSchema','entityCount']);ok(row.kind==='header'&&row.snapshotId===descriptor.snapshotId&&row.snapshotSeq===descriptor.snapshotSeq&&supportsProjectionSchema(row.projectionSchema)&&(row.projectionSchema<9||descriptor.recovery.projectionSchema===9)&&seq(row.entityCount));projectionSchema=row.projectionSchema;expected=row.entityCount;return;}
      keys(row,['kind','entityType','entityId','entityVersion','partIndex','partCount','utf8Base64']);
      ok(row.kind==='projection-part'&&['asset','document','history','checkpoint'].includes(row.entityType)&&id(row.entityId)&&seq(row.entityVersion)&&Number.isSafeInteger(row.partIndex)&&Number.isSafeInteger(row.partCount)&&row.partCount>0&&typeof row.utf8Base64==='string');
      const next=row.entityType+':'+row.entityId;
      if(!part){ok(next>previous);key=next;parts=row.partCount;version=row.entityVersion;}
      ok(next===key&&parts===row.partCount&&part===row.partIndex&&version===row.entityVersion);
      assembled.append(row.utf8Base64);
      // Current entities fit64KiB; reject before joining an oversized projection.
      if(++part===parts){const value=parseControlJSON(assembled.value());ok(canonical(value)===assembled.text()&&value.id===row.entityId&&projectionEntity(projectionSchema,row.entityType,value)===version);
        await this.cache.put(generation,row.entityType,row.entityId,value);count++;previous=key;part=0;assembled.clear();}
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
  private async recoverOwned() {
    const old=await this.cache.published();const generation=crypto.randomUUID();let pinned:RecoveryContext|undefined;
    try {
      let cursor=old.cursor;let response=await this.request('/api/v1/events?after='+cursor);let value=await this.control(response);
      if(response.status===410&&value.error?.code==='CURSOR_GAP'){
        const detail=value.error.details;ok(detail?.kind==='inline'&&detail.value?.kind==='cursor-gap'&&detail.value.requestedAfter===cursor);
        const descriptor=detail.value.snapshot as SnapshotDescriptor;pinned=descriptor.recovery;cursor=await this.snapshot(generation,descriptor);
        ok(detail.value.earliestAvailable===cursor);
        response=await this.request('/api/v1/events?after='+cursor+'&recoveryId='+pinned.recoveryId);value=await this.control(response);
      }else{ok(response.status===200);await this.cache.clone(old.generation,generation);}
      for(;;){ok(response.status===200);cursor=await this.page(generation,value,cursor,pinned);pinned??=value.recovery;
        if(!value.more)break;response=await this.request('/api/v1/events?after='+cursor+'&recoveryId='+pinned!.recoveryId);value=await this.control(response);}
      // Revalidate lease/epoch after downloads before the one publication point.
      const final=await this.request('/api/v1/events?after='+cursor+'&recoveryId='+pinned!.recoveryId);ok(final.status===200);
      const check=await this.control(final);await this.page(generation,check,cursor,pinned);ok(!check.more&&check.batches.length===0);
      this.workspace!.check();await this.cache.publish({generation,cursor,epoch:pinned!.writerEpoch},old);return cursor;
    }catch(error){await this.cache.discard(generation);throw error;}finally{if(pinned && this.csrf) await this.request('/api/v1/recovery/'+pinned.recoveryId+'/release',{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':this.csrf()},body:'{"protocolVersion":1}'}).catch(()=>{});}
  }
  private async consumeStreamOwned() {
    let old=await this.cache.published();let stage:string|undefined;let generation:string|undefined;
    let transaction:{id:string;from:string;to:string;parts:number;next:number;count:bigint;schema:number;command?:string}|undefined;
    try {
      const response=await this.request('/api/v1/events/stream?after='+old.cursor);ok(response.status===200&&response.headers.get('content-type')?.startsWith('text/event-stream')&&response.body);
      let pending='';const decoder=new TextDecoder('utf-8',{fatal:true});
      const frame=async(text:string)=>{
        const lines=text.split('\n');ok(lines.every(l=>l.startsWith('data: ')||l.startsWith('id: '))&&lines.filter(l=>l.startsWith('data: ')).length===1&&lines.filter(l=>l.startsWith('id: ')).length<=1);
        const body=parseControlJSON(encode.encode(lines.find(l=>l.startsWith('data: '))!.slice(6))) as StreamEnvelope;
        const offered=lines.find(l=>l.startsWith('id: '))?.slice(4);ok(body.protocolVersion===1);
        if(body.kind==='checkpoint'){keys(body,['protocolVersion','kind','highWater']);ok(!transaction&&!offered&&body.highWater===old.cursor);return;}
        if(body.kind==='error'||body.kind==='gap')throw new Error('Stream requires read recovery');
        if(body.kind==='transaction-ref'){
          keys(body,['protocolVersion','kind','reference']);const r=body.reference;context(r.recovery);ok(seq(r.toSeq));const to=r.toSeq;ok(!transaction&&offered===to);
          if(BigInt(to)<=BigInt(old.cursor))return;
          generation??=crypto.randomUUID();await this.cache.clone(old.generation,generation);
          await this.batch(generation,r,old.cursor,r.recovery);
          const proof=await this.request('/api/v1/events?after='+to+'&recoveryId='+r.recovery.recoveryId);ok(proof.status===200);const page=await this.control(proof);sameContext(r.recovery,page.recovery);
          this.workspace!.check();await this.cache.publish({generation,cursor:to,epoch:r.recovery.writerEpoch},old);
          // Publication transfers ownership before any fallible follow-up work.
          generation=undefined;old=await this.cache.published();
        }else{
          ok(body.kind==='batch-part');
          keys(body,['protocolVersion','kind','transactionId','fromSeq','toSeq','partIndex','partCount','events',...(Object.hasOwn(body,'projectionSchema')?['projectionSchema']:[])]);
          const projectionSchema=Object.hasOwn(body,'projectionSchema')?body.projectionSchema:8;ok(supportsProjectionSchema(projectionSchema),'Unsupported projection schema');
          ok(id(body.transactionId)&&seq(body.fromSeq)&&seq(body.toSeq)&&Number.isSafeInteger(body.partCount)&&body.partCount>0&&Number.isSafeInteger(body.partIndex)&&Array.isArray(body.events));
          for(const e of body.events)projectionEvent(projectionSchema,e);
          const to=body.toSeq;if(BigInt(to)<=BigInt(old.cursor)){ok(!transaction);return;}
          if(!transaction){ok(body.partIndex===0&&BigInt(body.fromSeq)===BigInt(old.cursor)+1n);stage=crypto.randomUUID();transaction={id:body.transactionId,from:body.fromSeq,to:body.toSeq,parts:body.partCount,next:0,count:0n,schema:projectionSchema};}
          const tx=transaction;ok(tx.id===body.transactionId&&tx.from===body.fromSeq&&tx.to===body.toSeq&&tx.parts===body.partCount&&tx.schema===projectionSchema&&tx.next++===body.partIndex);
          generation??=crypto.randomUUID();await this.cache.clone(old.generation,generation);
          for(const e of body.events){this.workspace!.check();ok(e.transactionId===tx.id&&BigInt(e.workspaceSeq)===BigInt(tx.from)+tx.count);tx.command??=e.commandId;ok(e.commandId===tx.command);await this.cache.put(stage!,'staged',String(tx.count++),e);}
          if(tx.next===tx.parts){ok(offered===tx.to&&tx.count===BigInt(tx.to)-BigInt(tx.from)+1n);await this.cache.applyEvents(generation,stage!,tx.count);
            this.workspace!.check();await this.cache.publish({generation,cursor:tx.to,epoch:old.epoch},old);
            generation=undefined;old=await this.cache.published();await this.cache.discard(stage!);stage=undefined;transaction=undefined;
          }else ok(offered===undefined);
        }
      };
      for await(const value of this.workspace!.chunks(response)){
        for(let at=0;at<value.length;at+=16384){pending+=decoder.decode(value.subarray(at,at+16384),{stream:true});let end:number;
          while((end=pending.indexOf('\n\n'))!==-1){const text=pending.slice(0,end);ok(encode.encode(text).length<=65664);pending=pending.slice(end+2);await frame(text);this.workspace!.check();}ok(encode.encode(pending).length<=65664);}
      }pending+=decoder.decode();ok(!pending&&!transaction,'Partial stream transaction');
    }finally{try{if(stage)await this.cache.discard(stage);}finally{if(generation)await this.cache.discard(generation);}}
  }
}
