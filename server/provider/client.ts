import { refuse } from './contracts.js';
import type { CredentialProvider, QueueAction, QueueIdentity, TransferSink } from './contracts.js';
import { queuePath, resolvePrivacy, validateQueueURL, exactURL } from './policy.js';
import type { PrivacyProfile, PolicyAcknowledgement } from './policy.js';
import { createWireTransport } from './transport.js';
import type { ConnectionPolicy } from './transport.js';
export type CapturedRequest = Readonly<{bytes:Uint8Array;evidence:TransferSink}>;
function captureRequest(request:CapturedRequest,contentType='application/json'):Uint8Array {
  const bytes=Buffer.from(request.bytes);
  try {request.evidence.recordHeaders({'Content-Length':String(bytes.length),'Content-Type':contentType});for(let i=0;i<bytes.length;i+=1024*1024)request.evidence.append(bytes.subarray(i,i+1024*1024));request.evidence.finish(true);return bytes;}
  catch(e){request.evidence.finish(false);throw e;}
}
export type ProviderAttempt = Readonly<{attemptId:string; identity:QueueIdentity; profileId:string; acknowledgement?:PolicyAcknowledgement}>;
export type ProviderBoundary = ReturnType<typeof providerBoundary>;
/** Internal shared protocol; only sealed production or separate fixture construction may instantiate it. */
export function providerBoundary(config: {
  mode:'production'|'fixture'; queueOrigin:string; mediaOrigins:readonly string[]; uploadOrigin?:string;
  profiles:readonly PrivacyProfile[]; credential:CredentialProvider; connection:ConnectionPolicy;
}) {
  const profiles=structuredClone(config.profiles), wire=createWireTransport(config.connection);
  const policy=(attempt:ProviderAttempt)=>{
    const p=profiles.find(p=>p.id===attempt.profileId);
    if(!p||p.mode!==config.mode)refuse('POLICY');
    return resolvePrivacy(p,attempt.identity.endpoint,attempt.attemptId,attempt.acknowledgement);
  };
  return Object.freeze({
    policy,
    queue(attempt:ProviderAttempt,action:QueueAction,sink:TransferSink,request?:CapturedRequest,returnedURL?:string,signal?:AbortSignal){
      if(sink.owner.attemptId!==attempt.attemptId||sink.owner.direction!=='response'||(request&&(request.evidence.owner.attemptId!==attempt.attemptId||request.evidence.owner.direction!=='request')))refuse('IDENTITY');
      const resolved=policy(attempt), path=queuePath(attempt.identity,action);
      const url=validateQueueURL(returnedURL??config.queueOrigin+path,attempt.identity,action,config.queueOrigin);
      if(action==='submit'?!request:request!==undefined)refuse('IDENTITY');
      sink.bindPolicy(resolved.applied);request?.evidence.bindPolicy(resolved.applied);
      const body=request?captureRequest(request):undefined;
      return wire({url,method:action==='submit'?'POST':action==='cancel'?'PUT':'GET',body,sink,signal,
        headers:()=>{const key=config.credential.queueKey();if(!key||/[\r\n]/.test(key))refuse('POLICY');
          return {Authorization:'Key '+key,'Content-Type':'application/json',...resolved.headers};}});
    },
    media(raw:string,sink:TransferSink,options:{expectedHash?:string;expectedBytes?:bigint;resume?:{offset:bigint;etag:string;total:bigint};signal?:AbortSignal}={}){
      const url=exactURL(raw);
      if(!config.mediaOrigins.includes(url.origin))refuse('POLICY');
      return wire({url,method:'GET',headers:()=>({}),sink,...options});
    },
    upload(raw:string,attempt:ProviderAttempt,request:CapturedRequest,sink:TransferSink){
      if(sink.owner.attemptId!==attempt.attemptId||sink.owner.direction!=='response'||request.evidence.owner.attemptId!==attempt.attemptId||request.evidence.owner.direction!=='request')refuse('IDENTITY');
      const resolved=policy(attempt),url=exactURL(raw);
      // No production upload profile is sealed; only the fixture adapter has a route.
      if(config.mode!=='fixture'||!config.uploadOrigin||url.origin!==config.uploadOrigin||url.pathname!=='/upload'||url.search)refuse('POLICY');
      sink.bindPolicy(resolved.applied);request.evidence.bindPolicy(resolved.applied);
      const body=captureRequest(request,'application/octet-stream');
      return wire({url,method:'POST',body,sink,headers:()=>({'Content-Type':'application/octet-stream',Authorization:'Key '+config.credential.queueKey(),...resolved.headers})});
    }
  });
}
