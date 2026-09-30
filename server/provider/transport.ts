import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { CONNECT_DEADLINE_MS, READ_DEADLINE_MS, IO_CHUNK, ProviderError, refuse } from './contracts.js';
import type { TransferReceipt, TransferSink, FailureCode } from './contracts.js';
import { sameAddress, validateAnswers } from './policy.js';

type Answer = { address: string; family: number };
/** Internal transport construction. Production callers only get the sealed factory in index.ts. */
export type ConnectionPolicy = Readonly<{
  mode: 'production' | 'fixture';
  resolve?: (hostname: string) => Promise<Answer[]>;
  fixtureOrigins?: readonly string[];
  fixtureCA?: string;
  connectMs?: number; readMs?: number;
}>;
export type WireRequest = Readonly<{
  url: URL; method: 'GET' | 'POST' | 'PUT';
  headers: () => Readonly<Record<string,string>>;
  body?: Uint8Array; sink: TransferSink;
  expectedHash?: string; expectedBytes?: bigint;
  resume?: Readonly<{ offset: bigint; etag: string; total: bigint }>;
  signal?: AbortSignal;
}>;
function safeCode(error: unknown): FailureCode {
  return error instanceof ProviderError ? error.code : 'INTERRUPTED';
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
export function createWireTransport(policy: ConnectionPolicy) {
  const connectMs = policy.mode === 'fixture' ? policy.connectMs ?? CONNECT_DEADLINE_MS : CONNECT_DEADLINE_MS;
  const readMs = policy.mode === 'fixture' ? policy.readMs ?? READ_DEADLINE_MS : READ_DEADLINE_MS;
  if (![connectMs,readMs].every(n => Number.isSafeInteger(n) && n > 0)) refuse('POLICY');
  return async function transfer(input: WireRequest): Promise<TransferReceipt> {
    const controller = new AbortController();
    let failure: FailureCode | null = null, status: number | null = null, declared: bigint | null = null;
    let etag: string | null = null, received = 0n, socket: net.Socket | undefined;
    let agent: http.Agent | undefined, req: http.ClientRequest | undefined, requestError: unknown;
    const initial = input.sink.bytes, hash = createHash('sha256');
    const abort = () => { failure ??= 'ABORTED'; controller.abort(); req?.destroy(new ProviderError(failure)); };
    input.signal?.addEventListener('abort',abort,{once:true});
    if (input.signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, code: FailureCode) => {
      clearTimeout(timer); timer = setTimeout(() => { failure = code; controller.abort(); req?.destroy(new ProviderError(code)); },ms);
    };
    try {
      if (input.expectedHash && !/^[a-f0-9]{64}$/.test(input.expectedHash)) refuse('HASH');
      if (input.resume && (input.method !== 'GET' || input.resume.offset <= 0n || input.resume.offset !== initial ||
          input.resume.total <= initial || !/^"[^"\r\n]+"$/.test(input.resume.etag))) refuse('IDENTITY');
      if (!input.resume && initial !== 0n) refuse('IDENTITY');
      const urlHash=createHash('sha256').update(input.url.href).digest('hex');
      if(input.resume && (!input.sink.identity || input.sink.identity.urlHash!==urlHash ||
        input.sink.identity.etag!==input.resume.etag || input.sink.identity.totalBytes!==String(input.resume.total))) refuse('IDENTITY');
      arm(connectMs,'CONNECT_TIMEOUT');
      // Race includes DNS. A late resolver cannot create a socket after abort.
      socket = await Promise.race([connectBound(input.url,policy,controller.signal), new Promise<never>((_,reject) => {
        controller.signal.addEventListener('abort',()=>reject(new ProviderError(failure ?? 'ABORTED')),{once:true});
      })]);
      if (controller.signal.aborted) refuse(failure ?? 'ABORTED');
      clearTimeout(timer);
      const secure = input.url.protocol === 'https:';
      agent = secure ? new https.Agent({keepAlive:false}) : new http.Agent({keepAlive:false});
      const connected = socket;
      agent.createConnection = (_options, callback) => { callback?.(null, connected); return connected; };
      const headers: Record<string,string> = { ...input.headers(), 'Accept-Encoding':'identity', Connection:'close' };
      if (input.body) headers['Content-Length'] = String(input.body.byteLength);
      if (input.resume) { headers.Range = `bytes=${input.resume.offset}-`; headers['If-Range'] = input.resume.etag; }
      arm(readMs,'READ_TIMEOUT');
      const response = await new Promise<http.IncomingMessage>((resolve,reject) => {
        req = (secure ? https : http).request({ protocol:input.url.protocol, hostname:input.url.hostname,
          port:input.url.port || (secure ? 443 : 80), path:input.url.pathname+input.url.search,
          method:input.method, headers, agent, setHost:true },resolve);
        req.once('error',error=>{requestError=error;reject(error);});
        req.end(input.body);
      });
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
      const evidence = input.sink.finish(true, initial+received);
      return Object.freeze({outcome:'complete',failure:null,status,receivedBytes:String(received),storedBytes:String(input.sink.bytes-initial),
        etag,declaredBytes:declared === null ? null : String(declared),sha256:evidence.sha256,evidence,providerCancelled:false});
    } catch(error) {
      failure ??= safeCode(error);
      const evidence = input.sink.finish(false, initial+received);
      return Object.freeze({outcome:'interrupted',failure,status,receivedBytes:String(received),storedBytes:String(input.sink.bytes-initial),
        etag,declaredBytes:declared === null ? null : String(declared),sha256:evidence.sha256,evidence,providerCancelled:false});
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort',abort); controller.abort();
      req?.destroy(); socket?.destroy(); agent?.destroy();
    }
  };
}
