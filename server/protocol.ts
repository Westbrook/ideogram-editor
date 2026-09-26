import { PortableRoutes } from './portable.js';
import { isPortableCommand } from '../src/protocol/portable.js';
import { isHistoryCommand } from '../src/protocol/history.js';
import { AssetRoutes } from './assets.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecoveryContext, SnapshotDescriptor, EventPage, ProtocolContentRef, CommandResult, StreamEnvelope } from '../src/protocol/recovery.js';
import type { LocalErrorDetail } from '../src/protocol/session.js';
import type { Writer } from './storage/writer.js';
import type { StoredContent, StoredSnapshot } from './storage/recovery.js';
import { StoreError } from './storage/errors.js';
import { canonical, isId, isSeq, parseCommand, hashBytes } from './storage/canonical.js';
import { readControlBytes, readSessionRequest, parseControlJSON } from './control-json.js';
import { ProtocolError } from './errors.js';
import type { Session } from './sessions.js';

type Lease = { clientId: string; sessionHash: string; expires: number; absolute: number; start: string; context: RecoveryContext; snapshot: StoredSnapshot | null; released: boolean; descriptor?: SnapshotDescriptor };
type Content = { clientId: string; sessionHash: string; expires: number; absolute: number; recoveryId?: string; stored: StoredContent };
const IDLE = 30 * 60 * 1000;
const PREFIX = '/api/v1/';
export function storeError(error: unknown, mutation = false): ProtocolError {
  if (error instanceof ProtocolError) return error;
  const retry = mutation ? 'same-command' : 'read-or-transfer';
  if (error instanceof StoreError) {
    if (['OWNER_REQUIRED','NOT_FOUND','CONTENT_WITHHELD','STAGING_ID_REUSE','OFFSET_MISMATCH','REVIEW_EXPIRED','MEDIA_TYPE'].includes(error.code)) return new ProtocolError(error.code as ConstructorParameters<typeof ProtocolError>[0],error.detail,error.code==='OFFSET_MISMATCH'?'read-or-transfer':'none');
    if (['MALFORMED_REQUEST','UNSUPPORTED_COMMAND'].includes(error.code)) return new ProtocolError('MALFORMED_REQUEST');
    if (error.code === 'PROTOCOL_VERSION' || error.code === 'PAYLOAD_TOO_LARGE' || error.code === 'COMMAND_ID_REUSE') return new ProtocolError(error.code);
    if (error.code === 'CAPACITY' || error.code === 'STORAGE_FULL') return new ProtocolError('STORAGE_FULL', undefined, retry);
    if (error.code === 'QUEUE_FULL') return new ProtocolError('LOCAL_BUSY', undefined, retry);
    if (['CORRUPT_STORE','CORRUPT_OBJECT','MISSING_OBJECT'].includes(error.code)) return new ProtocolError('RECOVERY_UNAVAILABLE', error.detail, retry);
  }
  return new ProtocolError('SERVER_UNAVAILABLE', undefined, retry);
}
export function sendJSON(response: ServerResponse, status: number, value: unknown) {
  const bytes = Buffer.from(canonical(value));
  if (bytes.length > 65536) throw new ProtocolError('PAYLOAD_TOO_LARGE');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length }); response.end(bytes);
}
function sendCommandResult(response:ServerResponse,result:CommandResult) {
  if(result.kind==='pending')response.setHeader('Location',result.receiptUrl);
  sendJSON(response,result.kind==='unknown'?404:result.kind==='pending'?202:200,result);
}
export class ProtocolRoutes {
  private leases = new Map<string, Lease>();
  private content = new Map<string, Content>();
  private streams = 0;
  private assets: AssetRoutes;
  private portable: PortableRoutes;
  constructor(private writer: Writer, private now: () => number) {this.assets=new AssetRoutes(writer,now);this.portable=new PortableRoutes(writer,now);}
  match(path: string): { allow: string[]; kind: string; id?: string; query: string[] } | null {
    const portable=this.portable.match(path);if(portable)return portable;
    const asset=this.assets.match(path);if(asset)return asset;
    if (path === PREFIX + 'commands') return { allow: ['POST'], kind: 'submit', query: [] };
    if (path === PREFIX + 'events') return { allow: ['GET'], kind: 'events', query: ['after','recoveryId'] };
    if (path === PREFIX + 'events/stream') return { allow: ['GET'], kind: 'stream', query: ['after'] };
    const history=/^\/api\/v1\/documents\/([^/]+)\/(image|history|checkpoints|save-status|closure)$/.exec(path);
    if(history){if(!isId(history[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'document-'+history[2],id:history[1],query:history[2]==='save-status'?['sessionId']:['history','checkpoints','closure'].includes(history[2])?['after']:[]};}
    const imageEdit=/^\/api\/v1\/(image-previews|image-edit-reviews)\/([^/]+)$/.exec(path);
    if(imageEdit){if(!isId(imageEdit[2]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:imageEdit[1],id:imageEdit[2],query:[]};}
    const ui=/^\/api\/v1\/ui\/([^/]+)$/.exec(path);
    if(ui){if(!isId(ui[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET','POST'],kind:'ui',id:ui[1],query:[]};}
    const match = /^\/api\/v1\/(commands|documents|snapshots|protocol-content|recovery|namespace-events)\/([^/]+)(\/release)?$/.exec(path);
    if (!match) return null;
    if (!isId(match[2])) throw new ProtocolError('MALFORMED_REQUEST');
    const kind = match[1];
    if ((kind === 'recovery') !== (match[3] === '/release')) throw new ProtocolError('NOT_FOUND');
    return { allow: kind === 'recovery' ? ['POST'] : kind === 'protocol-content' ? ['GET','HEAD'] : ['GET'],
      kind, id: match[2], query: ['snapshots','protocol-content','namespace-events'].includes(kind) ? ['recoveryId'] : [] };
  }
  private async prune() {
    const now = this.now();
    for (const [id,item] of this.content) if (now >= item.absolute || (item.recoveryId ? !this.leases.has(item.recoveryId) || this.leases.get(item.recoveryId)!.released || now >= this.leases.get(item.recoveryId)!.expires : now >= item.expires)) {
      this.content.delete(id); await this.writer.dropContent(item.stored.handle);
    }
    // Retain released ownership tombstones for idempotent release during this epoch.
    for (const [id,lease] of this.leases) if (now >= lease.absolute || now >= lease.expires || lease.released) this.leases.delete(id);
  }
  private lease(id: string, session: Session): Lease {
    const lease = this.leases.get(id);
    if (!lease) throw new ProtocolError('READ_CONTEXT_EXPIRED', undefined, 'read-or-transfer');
    if (lease.clientId !== session.clientId) throw new ProtocolError('OWNER_REQUIRED');
    // Command provenance survives pairing/renewal; read authority does not.
    if (lease.sessionHash !== session.cookieHash) throw new ProtocolError('READ_CONTEXT_EXPIRED', undefined, 'read-or-transfer');
    if (lease.released || this.now() >= lease.expires || this.now() >= lease.absolute || lease.context.writerEpoch !== this.writer.epoch) throw new ProtocolError('READ_CONTEXT_EXPIRED', undefined, 'read-or-transfer');
    return lease;
  }
  private touch(lease: Lease) {
    lease.expires = Math.min(this.now() + IDLE, lease.absolute); lease.context.expiresAt = new Date(lease.expires).toISOString();
    return { ...lease.context };
  }
  private async register(stored: StoredContent, session: Session, lease?: Lease): Promise<ProtocolContentRef> {
    await this.prune();
    if (this.content.size >= 128) { await this.writer.dropContent(stored.handle); throw new ProtocolError('LOCAL_BUSY', undefined, 'read-or-transfer'); }
    const contentId = randomUUID(); const expires = Math.min(this.now() + IDLE, session.expires);
    this.content.set(contentId, { stored, clientId: session.clientId, sessionHash: session.cookieHash, expires, absolute: session.expires, recoveryId: lease?.context.recoveryId });
    return { contentId, url: PREFIX + 'protocol-content/' + contentId + (lease ? '?recoveryId=' + lease.context.recoveryId : ''),
      blob: stored.blob, encoding: stored.encoding, recordCount: stored.recordCount, expiresAt: new Date(expires).toISOString() };
  }
  private async descriptor(lease: Lease, session: Session): Promise<SnapshotDescriptor> {
    const snapshot = lease.snapshot; if (!snapshot) throw new ProtocolError('RECOVERY_UNAVAILABLE', undefined, 'read-or-transfer');
    if (lease.descriptor) { lease.descriptor.recovery=this.touch(lease); const item=this.content.get(lease.descriptor.content.contentId); if (!item) throw new ProtocolError('READ_CONTEXT_EXPIRED'); item.expires=lease.expires; lease.descriptor.content.expiresAt=lease.context.expiresAt; return lease.descriptor; }
    const content = await this.register(await this.writer.snapshotContent(snapshot.id), session, lease);
    return lease.descriptor = { protocolVersion: 1, snapshotId: snapshot.id, snapshotSeq: snapshot.seq,
      metadataUrl: PREFIX + 'snapshots/' + snapshot.id + '?recoveryId=' + lease.context.recoveryId, recovery: this.touch(lease), content };
  }
  private async page(after: string, recoveryId: string | null, session: Session): Promise<EventPage> {
    if (!isSeq(after) || (recoveryId !== null && !isId(recoveryId))) throw new ProtocolError('MALFORMED_REQUEST');
    await this.prune(); let lease: Lease;
    if (recoveryId) lease = this.lease(recoveryId, session);
    else {
      if (this.leases.size >= 128) throw new ProtocolError('LOCAL_BUSY', undefined, 'read-or-transfer');
      const captured = await this.writer.capture();
      if (BigInt(after) > BigInt(captured.highWater)) throw new ProtocolError('MALFORMED_REQUEST');
      const inside = await this.writer.boundary(after, captured.highWater);
      if (inside) throw new ProtocolError('CURSOR_INSIDE_TRANSACTION', { kind: 'cursor', requestedAfter: after, transactionFrom: inside.fromSeq, transactionTo: inside.toSeq }, 'read-or-transfer');
      const expires = Math.min(this.now() + IDLE, session.expires);
      lease = { clientId: session.clientId, sessionHash: session.cookieHash, expires, absolute: session.expires, start: after, snapshot: captured.snapshot, released: false,
        context: { recoveryId: randomUUID(), writerEpoch: this.writer.epoch, projectionSchema: 3, highWater: captured.highWater, expiresAt: new Date(expires).toISOString() } };
      if (BigInt(captured.highWater) - BigInt(captured.snapshot?.seq ?? '0') > 500n) throw new ProtocolError('RECOVERY_UNAVAILABLE', undefined, 'read-or-transfer');
      this.leases.set(lease.context.recoveryId, lease);
      if (captured.snapshot && BigInt(after) < BigInt(captured.snapshot.seq)) {
        lease.start = captured.snapshot.seq;
        throw new ProtocolError('CURSOR_GAP', { kind: 'cursor-gap', requestedAfter: after, earliestAvailable: captured.snapshot.seq,
          snapshot: await this.descriptor(lease, session) }, 'read-or-transfer');
      }
    }
    if (BigInt(after) < BigInt(lease.start) || BigInt(after) > BigInt(lease.context.highWater)) throw new ProtocolError('MALFORMED_REQUEST');
    const inside = await this.writer.boundary(after, lease.context.highWater);
    if (inside) throw new ProtocolError('CURSOR_INSIDE_TRANSACTION', { kind: 'cursor', requestedAfter: after, transactionFrom: inside.fromSeq, transactionTo: inside.toSeq }, 'read-or-transfer');
    const page: EventPage = { protocolVersion: 1, kind: 'batches', recovery: this.touch(lease), nextCursor: after, more: false, batches: [] };
    // One complete transaction per bounded page. Large transactions have one reference.
    const batch = await this.writer.batch(after, lease.context.highWater);
    if (batch) {
      if ('events' in batch && batch.events) page.batches.push({ kind: 'inline', transactionId: batch.transactionId, fromSeq: batch.fromSeq, toSeq: batch.toSeq, events: batch.events });
      else if ('content' in batch) page.batches.push({ kind: 'transaction-ref', transactionId: batch.transactionId, fromSeq: batch.fromSeq, toSeq: batch.toSeq,
        eventCount: batch.eventCount!, recovery: page.recovery, content: await this.register(batch.content, session, lease) });
      page.nextCursor = batch.toSeq;
    }
    page.more = page.nextCursor !== page.recovery.highWater; return page;
  }
  private async commandResult(id: string, session: Session): Promise<CommandResult> {
    const {record,pending} = await this.writer.commandState(id);
    if (!record) {
      if(pending){if(pending.command.clientId!==session.clientId)throw new ProtocolError('OWNER_REQUIRED');return {protocolVersion:1,kind:'pending',commandId:id,operationId:pending.operationId,phase:pending.phase,receiptUrl:PREFIX+'commands/'+id};}
      return { protocolVersion: 1, kind: 'unknown', commandId: id };
    }
    if (record.command.clientId !== session.clientId) throw new ProtocolError('OWNER_REQUIRED');
    const result: CommandResult = { protocolVersion: 1, kind: 'receipt', receipt: record.receipt };
    if (record.receipt.status === 'rejected') {
      const bytes = await this.writer.readMetadata(record.receipt.details);
      const detail = parseControlJSON(bytes) as LocalErrorDetail;
      if (detail.kind !== 'fields' || canonical(detail) !== Buffer.from(bytes).toString() || hashBytes(bytes) !== record.receipt.details.hash) throw new ProtocolError('RECOVERY_UNAVAILABLE');
      result.rejectionDetails = { kind: 'inline', value: detail };
      if (Buffer.byteLength(canonical(result)) > 65536) result.rejectionDetails = { kind: 'content-ref', content: await this.register(await this.writer.safeJSON('receipt', id), session) };
    }
    return result;
  }
  async handle(request: IncomingMessage, response: ServerResponse, route: NonNullable<ReturnType<ProtocolRoutes['match']>>, params: URLSearchParams,
      authenticate: () => Session, assertRoot: () => Promise<void>) {
    const session = authenticate(); const id = route.id!;
    if (params.has('recoveryId') && !isId(params.get('recoveryId'))) throw new ProtocolError('MALFORMED_REQUEST');
    try {
      await this.prune();
      if (route.kind === 'submit'||route.kind==='asset-finalize') {
        const bytes = await readControlBytes(request); await assertRoot(); const current = authenticate();
        const command = parseCommand(bytes).command;
        if (command.clientId !== current.clientId) throw new ProtocolError('OWNER_REQUIRED');
        // sessionId is original provenance, never an authentication credential.
        // The authenticated client owns the persisted command across renewal.
        if(route.kind==='asset-finalize'&&(command.body.type!=='FinalizeStaging'||command.body.stagingId!==id))throw new ProtocolError('MALFORMED_REQUEST');
        const state = await this.writer.commandState(command.commandId);const previous=state.record??state.pending;
        if (previous && previous.command.clientId !== current.clientId) throw new ProtocolError('OWNER_REQUIRED');
        if(isPortableCommand(command.body.type))await this.writer.portableCommand(bytes,this.assets.auth(current));
        else if('stagingId' in command.body)await this.writer.assetCommand(bytes,this.assets.auth(current));
        else if(['PrepareRaster','ReviewRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(command.body.type))await this.writer.rasterCommand(bytes,this.assets.auth(current));
        else if(isHistoryCommand(command.body.type)&&(command.body.type!=='SaveCheckpoint'||(await this.writer.document(command.documentId!))?.image))await this.writer.historyCommand(bytes,this.assets.auth(current));
        else await this.writer.submit(bytes,this.writer.epoch);
        authenticate();const result=await this.commandResult(command.commandId,current);sendCommandResult(response,result);
      } else if(['bundle','bundle-review','bundle-mapping','bundle-content','portable-inventory'].includes(route.kind)){await this.portable.handle(request,response,route,params,authenticate,assertRoot);
      } else if(route.kind==='image-previews'||route.kind==='image-edit-reviews'){
        const result=route.kind==='image-previews'?await this.writer.imagePreview(id,this.assets.auth(session)):await this.writer.imageEditReview(id,this.assets.auth(session));authenticate();sendJSON(response,200,result);
      } else if(route.kind==='ui'){
        let result;
        if(request.method==='POST'){const bytes=await readControlBytes(request);const value=parseControlJSON(bytes) as any;if(value?.sessionId!==id)throw new ProtocolError('MALFORMED_REQUEST');await assertRoot();result=await this.writer.uiPersist(bytes,this.assets.auth(authenticate()));}
        else result=await this.writer.uiRead(id,this.assets.auth(session));
        authenticate();sendJSON(response,200,result);
      } else if(route.kind.startsWith('document-')){
        const result=route.kind==='document-image'?await this.writer.imageState(id):route.kind==='document-save-status'?await this.writer.saveStatus(id,params.get('sessionId')??'',this.assets.auth(session)):route.kind==='document-closure'?await this.writer.historyClosure(id,params.get('after')??''):await this.writer.historyPage(id,params.get('after')??'',route.kind==='document-history'?'history':'checkpoints');
        authenticate();sendJSON(response,200,result);
      } else if (route.kind === 'commands') {
        const result = await this.commandResult(id, session); authenticate();
        sendCommandResult(response,result);
      } else if(route.kind.startsWith('asset-')) await this.assets.handle(request,response,route,params,authenticate,assertRoot);
      else if (route.kind === 'documents') {
        const view = await this.writer.projection(id); if (!view.document) throw new ProtocolError('NOT_FOUND');
        const result = { protocolVersion: 1, entityVersion: view.document.revision, projectionSchema: 3, highWater: view.highWater,
          projection: { kind: 'inline', value: view.document } as any };
        if (Buffer.byteLength(canonical(result)) > 65536) result.projection = { kind: 'content-ref', content: await this.register(await this.writer.safeJSON('document',id), session) };
        authenticate(); sendJSON(response,200,result);
      } else if (route.kind === 'events') {
        const page = await this.page(params.get('after') ?? '', params.get('recoveryId'), session); authenticate(); sendJSON(response,200,page);
      } else if (route.kind === 'namespace-events') {
        const recoveryId=params.get('recoveryId');if(!recoveryId||!isId(recoveryId))throw new ProtocolError('MALFORMED_REQUEST');
        const lease=this.lease(recoveryId,session),value=await this.writer.namespaceContent(id,lease.context.highWater);
        const content=await this.register(value.content,session,lease);authenticate();this.lease(recoveryId,session);
        sendJSON(response,200,{protocolVersion:1,...value,content,recovery:this.touch(lease)});
      } else if (route.kind === 'snapshots') {
        const recoveryId = params.get('recoveryId'); if (!recoveryId || !isId(recoveryId)) throw new ProtocolError('MALFORMED_REQUEST');
        const lease = this.lease(recoveryId, session);
        if (lease.snapshot?.id !== id) throw new ProtocolError(await this.writer.snapshotKnown(id) ? 'OWNER_REQUIRED' : 'NOT_FOUND');
        const descriptor = await this.descriptor(lease, session); authenticate(); sendJSON(response,200,descriptor);
      } else if (route.kind === 'recovery') {
        await readSessionRequest(request,false); await assertRoot(); authenticate();
        const lease = this.leases.get(id);
        if (lease && lease.clientId !== session.clientId) throw new ProtocolError('OWNER_REQUIRED');
        if (lease && lease.sessionHash !== session.cookieHash) throw new ProtocolError('READ_CONTEXT_EXPIRED');
        if (!lease) { const owner = await this.writer.releasedOwner(id); if (owner !== session.clientId) throw new ProtocolError(owner ? 'OWNER_REQUIRED' : 'READ_CONTEXT_EXPIRED'); }
        await this.writer.release(id,session.clientId); if (lease) lease.released = true; await this.prune(); response.writeHead(204); response.end();
      } else if (route.kind === 'protocol-content') await this.readContent(request,response,id,params.get('recoveryId'),authenticate,assertRoot);
      else if (route.kind === 'stream') await this.stream(request,response,params.get('after') ?? '',authenticate,assertRoot);
    } catch (error) { throw storeError(error, request.method === 'POST'); }
  }
  private async readContent(request: IncomingMessage, response: ServerResponse, id: string, recoveryId: string | null, authenticate: () => Session, assertRoot: () => Promise<void>) {
    const item = this.content.get(id); if (!item) { if (recoveryId) this.lease(recoveryId,authenticate()); throw new ProtocolError('NOT_FOUND'); }
    const check = () => {
      const session = authenticate();
      if (item.clientId !== session.clientId || (item.recoveryId ?? null) !== recoveryId) throw new ProtocolError('OWNER_REQUIRED');
      if (item.sessionHash !== session.cookieHash) throw new ProtocolError('READ_CONTEXT_EXPIRED', undefined, 'read-or-transfer');
      if ((!item.recoveryId && this.now() >= item.expires) || this.now() >= item.absolute) throw new ProtocolError('READ_CONTEXT_EXPIRED');
      return recoveryId ? this.lease(recoveryId,session) : undefined;
    };
    const lease = check(); await this.writer.verifyContent(item.stored.handle); check(); const ref = item.stored.blob; const total = BigInt(ref.byteLength); let start = 0n; let end = total - 1n; let status = 200;
    const etag = '"' + ref.hash + '"'; const range = request.headers.range;
    if ((request.headersDistinct.range?.length ?? 0) > 1 || (request.headersDistinct['if-range']?.length ?? 0) > 1) throw new ProtocolError('MALFORMED_REQUEST');
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { response.setHeader('Content-Range','bytes */'+total); throw new ProtocolError('RANGE_NOT_SATISFIABLE',{ kind:'range',byteLength:ref.byteLength },'read-or-transfer'); }
      if (match[1]) { start = BigInt(match[1]); end = match[2] ? BigInt(match[2]) : end; if (end >= total) end = total - 1n; }
      else { const suffix = BigInt(match[2]); start = suffix < total ? total - suffix : 0n; if (!suffix) start = total; }
      if (start > end || start >= total) { response.setHeader('Content-Range','bytes */'+total); throw new ProtocolError('RANGE_NOT_SATISFIABLE',{ kind:'range',byteLength:ref.byteLength },'read-or-transfer'); }
      status = 206;
      if (request.headers['if-range'] !== undefined && request.headers['if-range'] !== etag) { status = 200; start = 0n; end = total - 1n; }
    }
    response.writeHead(status, { 'Content-Type': ref.mediaType, 'Content-Length': String(end - start + 1n), ETag: etag, 'Accept-Ranges':'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}) });
    if (request.method === 'HEAD') { item.expires = Math.min(this.now()+IDLE,item.absolute); if (lease) this.touch(lease); response.end(); return; }
    for (let at = start; at <= end;) {
      await assertRoot(); check();
      const n = Number(end - at + 1n > 32768n ? 32768n : end - at + 1n);
      const bytes = await this.writer.content(item.stored.handle,String(at),n); check();
      if (response.destroyed) return;
      await new Promise<void>((resolve,reject) => response.write(bytes, error => error ? reject(error) : resolve())); at += BigInt(n);
      item.expires = Math.min(this.now()+IDLE,item.absolute); if (lease) this.touch(lease);
    }
    response.end();
  }
  private async stream(request: IncomingMessage, response: ServerResponse, after: string, authenticate: () => Session, assertRoot: () => Promise<void>) {
    if (!isSeq(after)) throw new ProtocolError('MALFORMED_REQUEST');
    if (this.streams >= 16) throw new ProtocolError('LOCAL_BUSY',undefined,'read-or-transfer');
    let page = await this.page(after,null,authenticate()); authenticate();
    this.streams++; response.writeHead(200,{ 'Content-Type':'text/event-stream; charset=utf-8' }); request.setTimeout(0); response.flushHeaders();
    const send = async (body: StreamEnvelope, id?: string) => {
      const text = canonical(body); if (Buffer.byteLength(text) > 65536) throw new ProtocolError('PAYLOAD_TOO_LARGE');
      await new Promise<void>((resolve,reject) => response.write((id ? `id: ${id}\n` : '') + `data: ${text}\n\n`,e=>e?reject(e):resolve()));
    };
    try {
      while (!response.destroyed) {
        for (const batch of page.batches) {
          authenticate();
          if (batch.kind === 'inline') await send({ protocolVersion:1,kind:'batch-part',transactionId:batch.transactionId,fromSeq:batch.fromSeq,toSeq:batch.toSeq,partIndex:0,partCount:1,events:batch.events }, batch.toSeq);
          else await send({ protocolVersion:1,kind:'transaction-ref',reference:batch },batch.toSeq);
          after = batch.toSeq;
        }
        if (page.more) page = await this.page(after,page.recovery.recoveryId,authenticate());
        else {
          await send({ protocolVersion:1,kind:'checkpoint',highWater:page.recovery.highWater });
          const lease = this.leases.get(page.recovery.recoveryId)!;
          // Reference leases stay valid for downloads after delivery. Empty/inline-only pins can release.
          if (![...this.content.values()].some(v=>v.recoveryId===lease.context.recoveryId)) { lease.released=true; this.leases.delete(lease.context.recoveryId); }
          await delay(250); await assertRoot(); page = await this.page(after,null,authenticate());
        }
      }
    } catch (error) {
      if (!response.destroyed) {
        const safe = storeError(error);
        if (safe.detail?.kind === 'cursor-gap') await send({protocolVersion:1,kind:'gap',detail:safe.detail}).catch(()=>{});
        else await send({protocolVersion:1,kind:'error',error:safe.toWire()}).catch(()=>{});
        response.end();
      }
    } finally { this.streams--; }
  }
}
