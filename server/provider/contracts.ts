/** Server-only EF-1 / TP-1 boundaries. No browser routes or submission queue. */
export const IO_CHUNK = 1024 * 1024;
export const CONNECT_DEADLINE_MS = 10_000;
export const READ_DEADLINE_MS = 30_000;
export type FailureCode = 'POLICY' | 'IDENTITY' | 'ADDRESS' | 'PEER' | 'TLS' | 'REDIRECT' |
  'CONNECT_TIMEOUT' | 'READ_TIMEOUT' | 'INTERRUPTED' | 'LENGTH' | 'HASH' | 'CAPACITY' | 'ABORTED' | 'PROVENANCE';
export class ProviderError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'ProviderError'; }
}
export function refuse(code: FailureCode): never { throw new ProviderError(code); }
export type AppliedPrivacyPolicy = Readonly<{
  profileId: string; profileVersion: number; evidenceDigest: string;
  requestedStoreIO: '0'; requestedAccess: 'most-private-compatible';
  appliedLifecycleSeconds: number | null; appliedACL: string | null;
  enforcement: 'documented' | 'observed' | 'unknown'; fallbackAcknowledgementId: string | null;
}>;
export type QueueIdentity = Readonly<{ endpoint: string; requestId?: string }>;
export type QueueAction = 'submit' | 'status' | 'result' | 'cancel';
/** Observed transport completion, never provider success or adapter qualification. */
export type ProviderWireExecution = Readonly<{
  kind:'provider-wire-provenance-1'; boundary:'sealed-fal-production-1'|'loopback-fixture-1';
  role:QueueAction|'media'|'upload'; method:'GET'|'POST'|'PUT'; origin:string; pathname:string; urlHash:string;
  httpStatus:number; attemptId:string; direction:'request'|'response'; recordId:string; completed:true;
  requestRecordId:string|null; requestSha256:string|null;
}>;
export type ProviderWireBodyIdentity=Readonly<{kind:'provider-wire-body-identity-1';dev:string;ino:string;size:string;mtimeNs:string;ctimeNs:string}>;
export type ProtectedBody = Readonly<{
  class: 'backend-transport'; recordId: string; attemptId: string; direction: 'request' | 'response';
  sha256: string; receivedBytes: string; completeness: 'complete' | 'partial';
  access: 'backend-only'; export: 'never';
  wireExecution?: ProviderWireExecution;
  wireBodyIdentity?: ProviderWireBodyIdentity;
}>;
/** Optional old records stay unverified; a present malformed claim fails closed. */
export function validateWireExecution(value:unknown,body:Pick<ProtectedBody,'recordId'|'attemptId'|'direction'|'completeness'>):asserts value is ProviderWireExecution {
  const keys=['kind','boundary','role','method','origin','pathname','urlHash','httpStatus','attemptId','direction','recordId','completed','requestRecordId','requestSha256'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))refuse('PROVENANCE');
  const v=value as ProviderWireExecution,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const methods:Record<string,string>={submit:'POST',status:'GET',result:'GET',cancel:'PUT',media:'GET',upload:'POST'};
  if(v.kind!=='provider-wire-provenance-1'||!['sealed-fal-production-1','loopback-fixture-1'].includes(v.boundary)||!Object.hasOwn(methods,v.role)||methods[v.role]!==v.method||v.completed!==true||body.completeness!=='complete'||v.recordId!==body.recordId||v.attemptId!==body.attemptId||v.direction!==body.direction||!uuid.test(v.recordId)||!uuid.test(v.attemptId)||!['request','response'].includes(v.direction))refuse('PROVENANCE');
  if(!Number.isInteger(v.httpStatus)||v.httpStatus<100||v.httpStatus>599||typeof v.origin!=='string'||v.origin.length>512||typeof v.pathname!=='string'||v.pathname.length>16384||!v.pathname.startsWith('/')||/[?#\s\\\u0000-\u001f\u007f]/.test(v.pathname)||!/^sha256:[a-f0-9]{64}$/.test(v.urlHash))refuse('PROVENANCE');
  let url:URL;try{url=new URL(v.origin);}catch{return refuse('PROVENANCE');}
  if(url.origin!==v.origin||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['http:','https:'].includes(url.protocol))refuse('PROVENANCE');
  if(v.boundary==='sealed-fal-production-1'&&(url.protocol!=='https:'||url.port))refuse('PROVENANCE');
  if(v.boundary==='loopback-fixture-1'&&!['127.0.0.1','localhost'].includes(url.hostname))refuse('PROVENANCE');
  if((v.requestRecordId===null)!==(v.requestSha256===null)||v.requestRecordId!==null&&(!uuid.test(v.requestRecordId)||!/^sha256:[a-f0-9]{64}$/.test(v.requestSha256!)))refuse('PROVENANCE');
  if(v.direction==='request'&&(!['submit','upload'].includes(v.role)||v.requestRecordId!==v.recordId)||v.requestRecordId!==null&&!['submit','upload'].includes(v.role))refuse('PROVENANCE');
}
/** Owner adapts R31 reservations, including purpose, occupancy margin and writer fencing. */
export interface TransferReservation {
  readonly purpose: 'provider-request' | 'provider-response' | 'provider-media' | 'provider-provenance';
  ensure(totalBytes: bigint): void;
  committed(totalBytes: bigint): void;
  release(): void;
}
export type TransferIdentity = Readonly<{ urlHash:string; etag:string; totalBytes:string }>;
export interface TransferSink {
  readonly owner: Readonly<{attemptId:string;direction:'request'|'response';recordId?:string}>;
  readonly bytes: bigint;
  readonly identity: TransferIdentity | null;
  bindIdentity(identity: TransferIdentity): void;
  recordHeaders(headers:Record<string,unknown>):void;
  bindPolicy(policy:AppliedPrivacyPolicy):void;
  prepare(totalBytes: bigint): void;
  append(bytes: Uint8Array): void;
  digest(): string;
  finish(complete: boolean, observedBytes?: bigint, wireCapability?: unknown): ProtectedBody;
}
export type TransferReceipt = Readonly<{
  outcome: 'complete' | 'interrupted'; failure: FailureCode | null;
  status: number | null; receivedBytes: string; storedBytes: string;
  etag: string | null; declaredBytes: string | null; sha256: string;
  evidence: ProtectedBody; providerCancelled: false;
}>;
export interface CredentialProvider { queueKey(): string; }
