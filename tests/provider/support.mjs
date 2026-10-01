import { mkdtempSync, rmSync, chmodSync, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { TransportEvidenceStore } from '../../dist/local/server/provider/evidence.js';
import { ProviderError } from '../../dist/local/server/provider/contracts.js';
import { resolvePrivacy } from '../../dist/local/server/provider/policy.js';
import { fixtureProfile } from './emulator.mjs';
export function storage(t,limit=1n<<40n){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p21-')));chmodSync(root,0o700);
  const store=new TransportEvidenceStore(root),reservations=[],attemptId=randomUUID();
  const policy=resolvePrivacy(fixtureProfile(),'ideogram/v4',randomUUID()).applied;
  function reservation(purpose='provider-response',max=limit){let reserved=0n,committed=0n,released=false;const calls=[];
    const value={purpose,ensure(total){assert.equal(released,false);calls.push(total);if(total>max)throw new ProviderError('CAPACITY');reserved=total>reserved?total:reserved;},
      committed(total){assert.ok(total<=reserved);committed=total;},release(){released=true;},
      state:()=>({reserved,committed,released,calls})};reservations.push(value);return value;}
  const sink=(max=limit)=>store.begin(attemptId,'response',reservation('provider-response',max),policy);
  const request=(text)=>({bytes:Buffer.from(text),evidence:store.begin(attemptId,'request',reservation('provider-request'),policy)});
  t.after(()=>{for(const r of reservations)assert.equal(r.state().released,true,'every reservation released');rmSync(root,{recursive:true});assert.equal(existsSync(root),false,'owned private fixture removed');});
  return {root,store,policy,reservation,sink,request,attemptId};
}
export function capture(sink,bytes){for(let p=0;p<bytes.length;p+=32768)sink.append(bytes.subarray(p,p+32768));return sink.finish(true);}
export function assertCode(fn,code){assert.throws(fn,e=>e.code===code);}
