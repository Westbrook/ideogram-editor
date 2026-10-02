import { refuse } from './contracts.js';
import type { CredentialProvider, QueueAction, QueueIdentity, TransferSink } from './contracts.js';
import { queuePath, resolvePrivacy, validateQueueURL, exactURL } from './policy.js';
import type { PrivacyProfile, PolicyAcknowledgement } from './policy.js';
import { createWireTransport } from './transport.js';
import type { ConnectionPolicy, StreamingBody } from './transport.js';
export type CapturedRequest = Readonly<{bytes:Uint8Array;evidence:TransferSink;byteLength?:never;chunks?:never}> |
  Readonly<StreamingBody & {evidence:TransferSink;bytes?:never}>;
function captureRequest(request:CapturedRequest,contentType='application/json',headers:Readonly<Record<string,string>>={}):Uint8Array|StreamingBody {
  const body=request.bytes===undefined?{byteLength:request.byteLength,chunks:request.chunks}:Buffer.from(request.bytes);
  try {
    request.evidence.recordHeaders({'Content-Length':String(body.byteLength),'Content-Type':contentType,...headers});
    // Small queue bodies retain their immutable pre-dispatch snapshot. Large uploads
    // are opened once by the transport and captured a bounded chunk at a time.
    if(body instanceof Uint8Array){for(let i=0;i<body.length;i+=1024*1024)request.evidence.append(body.subarray(i,i+1024*1024));request.evidence.finish(true);}
    return body;
  }
  catch(e){request.evidence.finish(false);throw e;}
}
export type ProviderAttempt = Readonly<{attemptId:string; identity:QueueIdentity; profileId:string; acknowledgement?:PolicyAcknowledgement}>;
export type ProviderBoundary = ReturnType<typeof providerBoundary>;
/** Internal shared protocol; only sealed production or separate fixture construction may instantiate it. */
export function providerBoundary(config: {
  mode:'production'|'fixture'; queueOrigin:string; mediaOrigins:readonly string[]; uploadOrigin?:string; allowResultResponseSuffix?:boolean;
  profiles:readonly PrivacyProfile[]; credential:CredentialProvider; connection:ConnectionPolicy;
},wire=createWireTransport(config.connection)) {
  const profiles=structuredClone(config.profiles);
  const policy=(attempt:ProviderAttempt)=>{
    const p=profiles.find(p=>p.id===attempt.profileId);
    if(!p||p.mode!==config.mode)refuse('POLICY');
    return resolvePrivacy(p,attempt.identity.endpoint,attempt.attemptId,attempt.acknowledgement);
  };
  return Object.freeze({
    policy,
    queue(attempt:ProviderAttempt,action:QueueAction,sink:TransferSink,request?:CapturedRequest,returnedURL?:string,signal?:AbortSignal){
      try {
      if(sink.owner.attemptId!==attempt.attemptId||sink.owner.direction!=='response'||(request&&(request.evidence.owner.attemptId!==attempt.attemptId||request.evidence.owner.direction!=='request')))refuse('IDENTITY');
      const resolved=policy(attempt), path=queuePath(attempt.identity,action);
      const url=validateQueueURL(returnedURL??config.queueOrigin+path,attempt.identity,action,config.queueOrigin,config.allowResultResponseSuffix);
      if(action==='submit'?!request:request!==undefined)refuse('IDENTITY');
      sink.bindPolicy(resolved.applied);request?.evidence.bindPolicy(resolved.applied);
      const requestedHeaders={'X-Fal-No-Retry':'1','x-app-fal-disable-fallback':'true',...resolved.headers};
      const body=request?captureRequest(request,'application/json',requestedHeaders):undefined;
      return wire({role:action,url,method:action==='submit'?'POST':action==='cancel'?'PUT':'GET',body,sink,signal,requestEvidence:request?.evidence,
        headers:()=>{const key=config.credential.queueKey();if(!key||/[\r\n]/.test(key))refuse('POLICY');
          return {Authorization:'Key '+key,'Content-Type':'application/json',...requestedHeaders};}});
      }catch(error){try{request?.evidence.finish(false);}finally{sink.finish(false);}throw error;}
    },
    media(raw:string,sink:TransferSink,options:{expectedHash?:string;expectedBytes?:bigint;resume?:{offset:bigint;etag:string;total:bigint};signal?:AbortSignal}={}){
      try {
      const url=exactURL(raw);
      if(!config.mediaOrigins.includes(url.origin))refuse('POLICY');
      return wire({role:'media',url,method:'GET',headers:()=>({}),sink,expectedHash:options.expectedHash,expectedBytes:options.expectedBytes,resume:options.resume,signal:options.signal});
      }catch(error){sink.finish(false);throw error;}
    },
    upload(raw:string,attempt:ProviderAttempt,request:CapturedRequest,sink:TransferSink,signal?:AbortSignal){
      try {
      if(sink.owner.attemptId!==attempt.attemptId||sink.owner.direction!=='response'||request.evidence.owner.attemptId!==attempt.attemptId||request.evidence.owner.direction!=='request')refuse('IDENTITY');
      const resolved=policy(attempt),url=exactURL(raw);
      // No production upload profile is sealed; only the fixture adapter has a route.
      if(config.mode!=='fixture'||!config.uploadOrigin||url.origin!==config.uploadOrigin||url.pathname!=='/upload'||url.search)refuse('POLICY');
      sink.bindPolicy(resolved.applied);request.evidence.bindPolicy(resolved.applied);
      const body=captureRequest(request,'application/octet-stream');
      return wire({role:'upload',url,method:'POST',body,sink,signal,requestEvidence:request.evidence,headers:()=>{
        const key=config.credential.queueKey();if(!key||/[\r\n]/.test(key))refuse('POLICY');
        return {'Content-Type':'application/octet-stream',Authorization:'Key '+key,...resolved.headers};}});
      }catch(error){try{request.evidence.finish(false);}finally{sink.finish(false);}throw error;}
    }
  });
}
