import { createValueModel } from '@en-reve/primitives/state/value.js';
import {readOwnedJSON,type OwnedModel} from '../observability/model-memory.js';
import {reserveCommandWire} from './control-memory.js';
import {CommandControlReads} from './command-results.js';
import type { SessionView, CapabilitiesView } from '../protocol/session.js';

export type Connection = 'checking' | 'paired' | 'unpaired' | 'offline' | 'error';
export type SessionState = {
  connection: Connection; busy: boolean; message: string;
  capabilities: CapabilitiesView | null; expiresAt: string | null;
};
class RequestError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function createSessionClient() {
  // Neither cookie nor CSRF is projected into a view, DOM, URL or storage.
  let session: SessionView | null = null;
  let sessionOwner:OwnedModel<SessionView>|undefined,capabilitiesOwner:OwnedModel<CapabilitiesView>|undefined;
  const capabilityOwners=new WeakMap<CapabilitiesView,OwnedModel<CapabilitiesView>>(),retiredCapabilities=new Set<OwnedModel<CapabilitiesView>>(),reads=new CommandControlReads();
  let active: AbortController | undefined;
  let generation = 0;
  let actionTask:Promise<void>|undefined,disposal:Promise<void>|undefined;
  let cleanupFailed=false,cleanupFailure:unknown,publicationFailures=0;
  const state = createValueModel<SessionState>({ connection: 'checking', busy: false, message: 'Checking local connection…', capabilities: null, expiresAt: null });
  const set = (patch: Partial<SessionState>) => state.set({ ...state.value.get(), ...patch });
  async function request<T>(path:string,signal:AbortSignal,body?:object):Promise<OwnedModel<T>> {
    const wire=body?reserveCommandWire(body):undefined,unpin=sessionOwner?.pin();
    try{return await reads.run(async signal=>{
      const headers:Record<string,string>=body?{'Content-Type':'application/json'}:{'X-App-Client':'LP-1'};
      if(body&&path!=='session/bootstrap'&&session)headers['X-App-CSRF']=session.csrfToken;
      return readOwnedJSON<T>((url,init)=>fetch(url,{...init,credentials:'same-origin',cache:'no-store',redirect:'error'}),'/api/v1/'+path,{owner:'session-control-response',maxBytes:65536,init:{method:body?'POST':'GET',headers,...(wire?{body:wire.wire}:{}),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}});
    },signal);}finally{unpin?.();wire?.release();}
  }
  function replaceSession(next:OwnedModel<SessionView>|undefined){const prior=sessionOwner;sessionOwner=next;session=next?.value??null;prior?.release();}
  function publishCapabilities(next:OwnedModel<CapabilitiesView>|undefined,patch:Partial<SessionState>){
    const own=generation,failures=publicationFailures,prior=capabilitiesOwner;if(prior&&prior!==next)retiredCapabilities.add(prior);
    if(next){capabilityOwners.set(next.value,next);retiredCapabilities.delete(next);}capabilitiesOwner=next;
    // Install the owner before publishing so reentrant cleanup sees it.
    // Failed publication retains either possible view root until disposal.
    try{set({...patch,capabilities:next?.value??null});}
    catch(error){publicationFailures++;cleanupFailed=true;cleanupFailure=error;throw error;}
    if(own!==generation||failures!==publicationFailures)return;
    for(const held of retiredCapabilities){held.release();retiredCapabilities.delete(held);}
  }
  async function perform(action:'resume'|'bootstrap'|'renew'|'revoke',token:string|undefined,own:number,controller:AbortController) {
    set({ busy: true, message: action === 'renew' ? 'Renewing local connection…' : action === 'revoke' ? 'Disconnecting…' : 'Checking local connection…' });
    if(own!==generation){token=undefined;return;}
    let result:OwnedModel<SessionView>|undefined,capabilities:OwnedModel<CapabilitiesView>|undefined,sessionInstalled=false,capabilitiesInstalled=false,unpin:(()=>void)|undefined;
    try {
      result = action === 'resume' ? await request<SessionView>('session',controller.signal) : await request<SessionView>(`session/${action}`,controller.signal, action === 'bootstrap' ? { protocolVersion: 1, pairingToken: token } : { protocolVersion: 1 });
      token = undefined;
      if (own !== generation) return;
      if (action === 'revoke') {
        replaceSession(undefined);
        publishCapabilities(undefined,{ connection: 'unpaired', expiresAt: null, message: 'Disconnected. Type pair in the launcher terminal to open a fresh connection.' });
      } else {
        const value=result.value;if(!value||value.protocolVersion!==1||typeof value.clientId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.clientId)||typeof value.csrfToken!=='string'||value.csrfToken.length>256||!Number.isFinite(Date.parse(value.sessionExpiresAt))||!Number.isFinite(Date.parse(value.idleExpiresAt)))throw new RequestError('INVALID_RESPONSE');
        unpin=result.pin();replaceSession(result);sessionInstalled=true;
        capabilities = await request<CapabilitiesView>('capabilities',controller.signal);
        if (own !== generation) return;
        if(!capabilities.value||capabilities.value.protocolVersion!==1||!Array.isArray(capabilities.value.limits)||!Array.isArray(capabilities.value.profiles))throw new RequestError('INVALID_RESPONSE');
        capabilitiesInstalled=true;publishCapabilities(capabilities,{connection:'paired',expiresAt:result.value.sessionExpiresAt,message:'Connected to your local workspace.'});
        if(own!==generation)return;
      }
    } catch (error) {
      if (own !== generation) return;
      replaceSession(undefined);
      if(cleanupFailed)throw error;
      const code = error instanceof RequestError ? error.code : error instanceof Error&&['SESSION_REQUIRED','PAIRING_INVALID','CSRF_DENIED'].includes(error.message)?error.message:'NETWORK';
      const unpaired = ['SESSION_REQUIRED', 'PAIRING_INVALID', 'CSRF_DENIED'].includes(code);
      publishCapabilities(undefined,{ connection: unpaired ? 'unpaired' : code === 'NETWORK' ? 'offline' : 'error', expiresAt: null,
        message: unpaired ? 'Connection expired or unavailable. Type pair in the launcher terminal for a fresh link.' : code === 'NETWORK' ? 'The local server is unreachable. Start the launcher, then check the connection. Your draft is still in this tab.' : 'The local server could not complete this request. Check the connection or restart the launcher.' });
      // A lost mutation response is never retried. An explicit check reads the
      // current cookie/session before any later renew or revoke is offered.
    } finally {
      unpin?.();if(!sessionInstalled)result?.release();if(!capabilitiesInstalled)capabilities?.release();
      token = undefined;
      if (own === generation) {active=undefined;set({ busy: false });}
    }
  }
  function run(action:'resume'|'bootstrap'|'renew'|'revoke',token?:string):Promise<void>{
    const requested=generation;
    return (async()=>{
      try{
        if(disposal)await disposal;
        if(requested!==generation)return;
        if(cleanupFailed)throw cleanupFailure;
        if(actionTask||state.value.get().busy)return;
        const own=++generation,controller=new AbortController();active=controller;
        let resolve!:()=>void,reject!:(error:unknown)=>void;
        const work=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});actionTask=work;
        void perform(action,token,own,controller).then(resolve,reject);token=undefined;
        try{await work;}catch(error){if(own===generation){cleanupFailed=true;cleanupFailure=error;}throw error;}finally{if(actionTask===work)actionTask=undefined;}
      }finally{token=undefined;}
    })();
  }
  function dispose():Promise<void>{
    if(disposal)return disposal;
    const previous=actionTask,errors:unknown[]=[];
    // Install the barrier before publishing the disconnected state. Every
    // independent cleanup still runs if a synchronous publication throws.
    const work=Promise.resolve().then(async()=>{
      const outcomes=await Promise.allSettled([reads.release(),previous]);
      for(const outcome of outcomes)if(outcome.status==='rejected')errors.push(outcome.reason);
      if(errors.length)throw new AggregateError(errors,'SESSION_RELEASE_INCOMPLETE');
    });
    disposal=work;
    generation++;const controller=active;active=undefined;
    try{controller?.abort();}catch(error){errors.push(error);}
    try{replaceSession(undefined);}catch(error){errors.push(error);}
    try{publishCapabilities(undefined,{connection:'offline',busy:false,expiresAt:null,message:'Disconnected.'});}catch(error){errors.push(error);}
    void work.then(()=>{if(disposal===work){disposal=undefined;cleanupFailed=false;cleanupFailure=undefined;}},error=>{if(disposal===work){disposal=undefined;cleanupFailed=true;cleanupFailure=error;}});
    return work;
  }
  return {
    state,
    // Authority stays in this closure. Views receive only the nonsecret owner ID.
    identity: () => session?.clientId ?? null,
    csrf: () => session?.csrfToken ?? '',
    transport: (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('X-App-Client', 'LP-1');
      if (init.method && !['GET', 'HEAD'].includes(init.method)) {
        if (!session) return Promise.reject(new RequestError('SESSION_REQUIRED'));
        headers.set('X-App-CSRF', session.csrfToken);
      }
      return fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    },
    start: (token?: string) => run(token ? 'bootstrap' : 'resume', token),
    resume: () => run('resume'), renew: () => run('renew'), revoke: () => run('revoke'),
    renderCapabilities(value:CapabilitiesView|null){if(!value)return [];const model=capabilityOwners.get(value);if(!model)throw Error('SESSION_CAPABILITIES_UNOWNED');return [{value:model.value,pin:()=>model.pin()}];},
    get ownership(){return {...reads.ownership,sessionModels:(sessionOwner?1:0)+(capabilitiesOwner?1:0)+retiredCapabilities.size};},
    release:()=>reads.release(),
    dispose,
  };
}
