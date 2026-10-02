import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { CONNECT_DEADLINE_MS, READ_DEADLINE_MS, IO_CHUNK, ProviderError, refuse, validateWireExecution } from './contracts.js';
import type { TransferReceipt, TransferSink, FailureCode, ProtectedBody, ProviderWireExecution, CredentialProvider } from './contracts.js';
import { sameAddress, validateAnswers, QUEUE_ORIGIN, PRODUCTION_MEDIA_HOSTS } from './policy.js';
import {PRODUCTION_PROFILE} from './production-profile.js';
import {providerBoundary} from './client.js';

type Answer = { address: string; family: number };
/** Internal transport construction. Production callers only get the sealed factory in index.ts. */
export type ConnectionPolicy = Readonly<{
  mode: 'production' | 'fixture';
  resolve?: (hostname: string) => Promise<Answer[]>;
  fixtureOrigins?: readonly string[];
  fixtureCA?: string;
  connectMs?: number; readMs?: number;
}>;
/** One invocation, one pass, with a fixed size reserved before any body bytes leave. */
export type StreamingBody = Readonly<{
  byteLength: bigint;
  chunks: () => Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}>;
export type WireRequest = Readonly<{
  url: URL; method: 'GET' | 'POST' | 'PUT';
  headers: () => Readonly<Record<string,string>>;
  body?: Uint8Array | StreamingBody; sink: TransferSink; requestEvidence?: TransferSink;
  expectedHash?: string; expectedBytes?: bigint;
  resume?: Readonly<{ offset: bigint; etag: string; total: bigint }>;
  signal?: AbortSignal;
  role?: ProviderWireExecution['role'];
}>;
function safeCode(error: unknown): FailureCode {
  return error instanceof ProviderError ? error.code : 'INTERRUPTED';
}
function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if(signal.aborted){void promise.catch(()=>{});return Promise.reject(new ProviderError('ABORTED'));}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('ABORTED'));};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export async function connectBound(url: URL, policy: ConnectionPolicy, signal: AbortSignal): Promise<net.Socket> {
  if (signal.aborted) refuse('ABORTED');
  const fixture = policy.mode === 'fixture';
  if (fixture) {
    if (!policy.fixtureOrigins?.includes(url.origin) || !['127.0.0.1','localhost'].includes(url.hostname)) refuse('POLICY');
  } else if (url.protocol !== 'https:' || url.port) refuse('POLICY');
  const answers = await (policy.resolve ?? (host => lookup(host, { all: true, verbatim: true })))(url.hostname);
  if (signal.aborted) refuse('ABORTED');
  if (fixture) {
    if (!answers.length || answers.some(a => a.address !== '127.0.0.1' || a.family !== 4)) refuse('ADDRESS');
  } else validateAnswers(answers);
  const selected = answers[0]!;
  // The validated numerical address is the actual connect target: no second DNS lookup.
  const socket = net.connect({ host: selected.address, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    family: selected.family, autoSelectFamily: false });
  const abort = () => socket.destroy(new ProviderError('ABORTED'));
  signal.addEventListener('abort', abort, {once:true});
  try {
    await new Promise<void>((resolve,reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, selected.address)) refuse('PEER');
    if (!fixture) validateAnswers([{address:socket.remoteAddress, family:net.isIP(socket.remoteAddress)}]);
    if (url.protocol === 'http:') { if (!fixture) refuse('POLICY'); return socket; }
    const secured = tls.connect({ socket, servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true,
      ca: fixture ? policy.fixtureCA : [...tls.rootCertificates], minVersion: 'TLSv1.2',
      checkServerIdentity: tls.checkServerIdentity });
    const abortTLS = () => secured.destroy(new ProviderError('ABORTED'));
    signal.addEventListener('abort', abortTLS, {once:true});
    secured.once('close', () => signal.removeEventListener('abort',abortTLS));
    try {
      await new Promise<void>((resolve,reject) => {
        secured.once('secureConnect',resolve); secured.once('error',() => reject(new ProviderError('TLS')));
      });
      if (!secured.authorized || tls.checkServerIdentity(url.hostname, secured.getPeerCertificate()) ||
          !secured.remoteAddress || !sameAddress(secured.remoteAddress, selected.address)) refuse('TLS');
      return secured;
    } catch (e) { secured.destroy(); throw e; }
  } catch(e) { socket.destroy(); throw e; }
  finally { signal.removeEventListener('abort', abort); }
}
type WireBinding=Pick<ProtectedBody,'recordId'|'attemptId'|'direction'|'completeness'|'sha256'|'receivedBytes'>;
const wireCapabilities=new WeakMap<object,{sink:TransferSink;claim:ProviderWireExecution;sha256:string;bytes:string}>();
/** Consume only: no public caller can create an accepted capability. */
export function consumeWireExecution(capability:unknown,sink:TransferSink,body:WireBinding):ProviderWireExecution {
  if(!capability||typeof capability!=='object')refuse('PROVENANCE');
  const issued=wireCapabilities.get(capability);wireCapabilities.delete(capability);
  if(!issued||issued.sink!==sink||issued.sha256!==body.sha256||issued.bytes!==body.receivedBytes||issued.bytes!==String(sink.bytes))refuse('PROVENANCE');
  validateWireExecution(issued.claim,body);return issued.claim;
}
function executionCapability(sink:TransferSink,boundary:ProviderWireExecution['boundary'],role:ProviderWireExecution['role'],url:URL,method:WireRequest['method'],status:number,request:TransferSink|undefined,sentDigest:string):object|undefined {
  if(!sink.owner.recordId)return undefined;
  const claim:ProviderWireExecution=Object.freeze({kind:'provider-wire-provenance-1',boundary,role,method,origin:url.origin,pathname:url.pathname,urlHash:'sha256:'+createHash('sha256').update(url.href).digest('hex'),httpStatus:status,attemptId:sink.owner.attemptId,direction:sink.owner.direction,recordId:sink.owner.recordId,completed:true,requestRecordId:request?.owner.recordId??null,requestSha256:request?.owner.recordId?'sha256:'+sentDigest:null});
  validateWireExecution(claim,{...sink.owner,recordId:sink.owner.recordId,completeness:'complete'});
  const token=Object.freeze({});wireCapabilities.set(token,{sink,claim,sha256:sink.digest(),bytes:String(sink.bytes)});return token;
}
/** Low-level construction can never confer sealed production authority. */
export function createWireTransport(policy:ConnectionPolicy){return wireTransport(policy,policy.mode==='fixture'?'loopback-fixture-1':undefined);}
function wireTransport(policy: ConnectionPolicy,boundary:ProviderWireExecution['boundary']|undefined) {
  const connectMs = policy.mode === 'fixture' ? policy.connectMs ?? CONNECT_DEADLINE_MS : CONNECT_DEADLINE_MS;
  const readMs = policy.mode === 'fixture' ? policy.readMs ?? READ_DEADLINE_MS : READ_DEADLINE_MS;
  if (![connectMs,readMs].every(n => Number.isSafeInteger(n) && n > 0)) refuse('POLICY');
  return async function transfer(input: WireRequest): Promise<TransferReceipt> {
    const controller = new AbortController(),wireURL=new URL(input.url.href);
    let failure: FailureCode | null = null, status: number | null = null, declared: bigint | null = null;
    let etag: string | null = null, received = 0n, socket: net.Socket | undefined;
    let agent: http.Agent | undefined, req: http.ClientRequest | undefined, requestError: unknown;
    let sent=0n,requestComplete=false,requestWireProofAttempted=false;
    const initial = input.sink.bytes, hash = createHash('sha256'),sentHash=createHash('sha256');
    const abort = () => { failure ??= 'ABORTED'; controller.abort(); req?.destroy(new ProviderError(failure)); };
    input.signal?.addEventListener('abort',abort,{once:true});
    if (input.signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, code: FailureCode) => {
      clearTimeout(timer); timer = setTimeout(() => { failure = code; controller.abort(); req?.destroy(new ProviderError(code)); },ms);
    };
    try {
      const streaming=input.body!==undefined&&!(input.body instanceof Uint8Array)?input.body:undefined;
      if(streaming){
        if(typeof streaming.byteLength!=='bigint'||streaming.byteLength<0n||typeof streaming.chunks!=='function')refuse('LENGTH');
        if(input.requestEvidence?.bytes!==undefined&&input.requestEvidence.bytes!==0n)refuse('IDENTITY');
        input.requestEvidence?.prepare(streaming.byteLength);
      }
      if (input.expectedHash && !/^[a-f0-9]{64}$/.test(input.expectedHash)) refuse('HASH');
      if (input.resume && (input.method !== 'GET' || input.resume.offset <= 0n || input.resume.offset !== initial ||
          input.resume.total <= initial || !/^"[^"\r\n]+"$/.test(input.resume.etag))) refuse('IDENTITY');
      if (!input.resume && initial !== 0n) refuse('IDENTITY');
      const urlHash=createHash('sha256').update(wireURL.href).digest('hex');
      if(input.resume && (!input.sink.identity || input.sink.identity.urlHash!==urlHash ||
        input.sink.identity.etag!==input.resume.etag || input.sink.identity.totalBytes!==String(input.resume.total))) refuse('IDENTITY');
      arm(connectMs,'CONNECT_TIMEOUT');
      // Race includes DNS. A late resolver cannot create a socket after abort.
      socket = await Promise.race([connectBound(wireURL,policy,controller.signal), new Promise<never>((_,reject) => {
        controller.signal.addEventListener('abort',()=>reject(new ProviderError(failure ?? 'ABORTED')),{once:true});
      })]);
      if (controller.signal.aborted) refuse(failure ?? 'ABORTED');
      clearTimeout(timer);
      const secure = wireURL.protocol === 'https:';
      agent = secure ? new https.Agent({keepAlive:false}) : new http.Agent({keepAlive:false});
      const connected = socket;
      agent.createConnection = (_options, callback) => { callback?.(null, connected); return connected; };
      const headers: Record<string,string> = { ...input.headers(), 'Accept-Encoding':'identity', Connection:'close' };
      if (input.body) headers['Content-Length'] = String(input.body.byteLength);
      if (input.resume) { headers.Range = `bytes=${input.resume.offset}-`; headers['If-Range'] = input.resume.etag; }
      arm(readMs,'READ_TIMEOUT');
      const responseReady = new Promise<http.IncomingMessage>((resolve,reject) => {
        req = (secure ? https : http).request({ protocol:wireURL.protocol, hostname:wireURL.hostname,
          port:wireURL.port || (secure ? 443 : 80), path:wireURL.pathname+wireURL.search,
          method:input.method, headers, agent, setHost:true },resolve);
        req.once('error',error=>{requestError=error;failure??=safeCode(error);controller.abort();reject(error);});
      });
      const send=async()=>{
        if(streaming){
          const source=streaming.chunks(),iterator=Symbol.asyncIterator in source?source[Symbol.asyncIterator]():source[Symbol.iterator]();
          let exhausted=false;
          try {
            for(;;){
              if(controller.signal.aborted)refuse(failure??'ABORTED');
              const next=await whileActive(Promise.resolve(iterator.next()),controller.signal);
              if(controller.signal.aborted)refuse(failure??'ABORTED');
              if(next.done){exhausted=true;break;}
              if(!(next.value instanceof Uint8Array)||next.value.byteLength===0||next.value.byteLength>IO_CHUNK)refuse('LENGTH');
              if(sent+BigInt(next.value.byteLength)>streaming.byteLength)refuse('LENGTH');
              // The snapshot is at most IO_CHUNK; the generator may reuse its own
              // backing buffer only after this write has drained. Evidence records
              // the exact local write, never claiming remote receipt on failure.
              const bytes=Buffer.from(next.value);
              input.requestEvidence?.append(bytes);sentHash.update(bytes);
              await whileActive(new Promise<void>((resolve,reject)=>{
                req!.write(bytes,error=>error?reject(error):resolve());sent+=BigInt(bytes.byteLength);
              }),controller.signal);
              arm(readMs,'READ_TIMEOUT');
            }
            if(sent!==streaming.byteLength)refuse('LENGTH');
          } finally {
            if(!exhausted&&iterator.return){
              const closed=Promise.resolve(iterator.return());
              if(controller.signal.aborted)void closed.catch(()=>{});else await whileActive(closed,controller.signal);
            }
          }
          await whileActive(new Promise<void>(resolve=>req!.end(resolve)),controller.signal);
        }else{
          if(input.body instanceof Uint8Array)sentHash.update(input.body);
          await whileActive(new Promise<void>(resolve=>req!.end(input.body,resolve)),controller.signal);
          sent=BigInt(input.body?.byteLength??0);
        }
        if(controller.signal.aborted)refuse(failure??'ABORTED');
        input.requestEvidence?.finish(true,sent);requestComplete=true;
      };
      // The single writer awaits every write callback: at most one bounded chunk
      // is queued and no source read races ahead of socket backpressure.
      const [response]=await Promise.all([responseReady,send()]);
      status = response.statusCode ?? null;
      input.sink.recordHeaders(response.headers);
      if (status !== null && status >= 300 && status < 400) refuse('REDIRECT');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') refuse('POLICY');
      const length = response.headers['content-length'];
      if (length !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(length)) refuse('LENGTH');
        declared = BigInt(length);
      }
      if (declared !== null) input.sink.prepare(initial+declared);
      etag = typeof response.headers.etag === 'string' && /^"[^"\r\n]+"$/.test(response.headers.etag) ? response.headers.etag : null;
      if (input.resume) {
        const m = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(String(response.headers['content-range']));
        if (status !== 206 || etag !== input.resume.etag || !m || BigInt(m[1]!) !== initial ||
            BigInt(m[3]!) !== input.resume.total || BigInt(m[2]!) !== input.resume.total-1n ||
            (declared !== null && declared !== input.resume.total-initial)) refuse('IDENTITY');
      } else if (status === 206) refuse('IDENTITY');
      else if(etag && declared!==null) input.sink.bindIdentity({urlHash,etag,totalBytes:String(declared)});
      for await (const chunk of response) {
        arm(readMs,'READ_TIMEOUT');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += BigInt(bytes.byteLength); hash.update(bytes);
        if (declared !== null && received > declared) refuse('LENGTH');
        if (input.expectedBytes !== undefined && initial + received > input.expectedBytes) refuse('LENGTH');
        for (let offset=0; offset<bytes.byteLength; offset+=IO_CHUNK) input.sink.append(bytes.subarray(offset,offset+IO_CHUNK));
      }
      if(requestError)throw requestError;
      if (!response.complete || (declared !== null && received !== declared) ||
          (input.expectedBytes !== undefined && initial+received !== input.expectedBytes) ||
          (input.resume && initial+received !== input.resume.total)) refuse('LENGTH');
      // A resume hashes the whole retained stream in its sink; per-connection digest alone cannot prove the object.
      const digest = hash.digest('hex');
      if (input.expectedHash && !input.resume && digest !== input.expectedHash) refuse('HASH');
      if (input.expectedHash && input.sink.digest() !== input.expectedHash) refuse('HASH');
      const sentDigest=sentHash.digest('hex');
      // A captured request may already be locally complete. Only actual writes
      // followed by a complete response can add execution evidence to it.
      if(input.requestEvidence&&(input.requestEvidence.bytes!==sent||input.requestEvidence.digest()!==sentDigest))refuse('PROVENANCE');
      if(boundary&&input.role&&!input.resume&&status!==null){
        if(input.sink.bytes!==received||input.sink.digest()!==digest)refuse('PROVENANCE');
        if(input.sink.owner.direction!=='response')refuse('IDENTITY');
        const request=input.requestEvidence;
        if(request){const capability=executionCapability(request,boundary,input.role,wireURL,input.method,status,request,sentDigest);requestWireProofAttempted=capability!==undefined;request.finish(true,sent,capability);}
      }
      // A resumed stream includes bytes from an earlier incomplete exchange.
      // Keep its usable transfer receipt, without claiming one complete wire run.
      const capability=boundary&&input.role&&!input.resume&&status!==null?executionCapability(input.sink,boundary,input.role,wireURL,input.method,status,input.requestEvidence,sentDigest):undefined;
      const evidence = input.sink.finish(true, initial+received,capability);
      return Object.freeze({outcome:'complete',failure:null,status,receivedBytes:String(received),storedBytes:String(input.sink.bytes-initial),
        etag,declaredBytes:declared === null ? null : String(declared),sha256:evidence.sha256,evidence,providerCancelled:false});
    } catch(error) {
      failure ??= safeCode(error);
      controller.abort();req?.destroy();
      let evidence:TransferReceipt['evidence'];
      try{if(!requestComplete||requestWireProofAttempted)input.requestEvidence?.finish(false,sent);}
      finally{evidence=input.sink.finish(false,initial+received);}
      return Object.freeze({outcome:'interrupted',failure,status,receivedBytes:String(received),storedBytes:String(input.sink.bytes-initial),
        etag,declaredBytes:declared === null ? null : String(declared),sha256:evidence.sha256,evidence,providerCancelled:false});
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort',abort); controller.abort();
      req?.destroy(); socket?.destroy(); agent?.destroy();
    }
  };
}

/** Production has no emulator selection, alternate origin, TLS override or caller-supplied Q09 profiles. */
export function assertProductionConfiguration(config:Record<string,unknown>): void {
  if(Object.keys(config).some(k=>/emulat|fixture|proxy|endpoint|origin|tls|profile/i.test(k)))refuse('POLICY');
}
export function assertProductionEnvironment(environment:NodeJS.ProcessEnv):void {
  if(Object.keys(environment).some(k=>/^(IDEOGRAM_|FAL_|PROVIDER_).*(EMULATOR|FIXTURE)/i.test(k)))refuse('POLICY');
}
export function createProductionProvider(credential:CredentialProvider, config:Record<string,unknown>={}) {
  assertProductionEnvironment(process.env);
  assertProductionConfiguration(config);
  if(Object.keys(config).length)refuse('POLICY');
  return providerBoundary({mode:'production',queueOrigin:QUEUE_ORIGIN,mediaOrigins:PRODUCTION_MEDIA_HOSTS.map(host=>'https://'+host),profiles:[PRODUCTION_PROFILE],credential,allowResultResponseSuffix:true,
    connection:{mode:'production'}},wireTransport({mode:'production'},'sealed-fal-production-1'));
}
