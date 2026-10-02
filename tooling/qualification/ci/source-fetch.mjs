import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateCiPlan, digest, sha256} from './plan.mjs';
import {validateBaselinePacket} from './baseline.mjs';
import {verifyImmutablePlan} from './run.mjs';
import {hashFile} from '../developer-campaigns/common.mjs';

const assert=(value,message)=>{if(!value)throw Error(message);};

/** Authenticate the protected controller's selected packet before its historical
 * plan may add Git identities. This is source preparation, not baseline approval
 * or evidence qualification; loadApprovedMain still verifies the full packet. */
async function historicalPlan(descriptor) {
  if(!descriptor)return null;
  const path=resolve(descriptor.packet.path),seal=await hashFile(path),bytes=await readFile(path);
  assert(seal.sha256===descriptor.packet.sha256&&sha256(bytes)===descriptor.packet.sha256,'Protected approved-main packet hash differs before source fetch');
  const plan=validateBaselinePacket(JSON.parse(bytes),descriptor);
  return {path,sha256:descriptor.packet.sha256,plan};
}

/** Fetch only exact commits named by current or authenticated historical plans.
 * The caller fixes the remote and owns cancellation/log retention. No packet
 * URL, path, approval boolean or nested approved-main descriptor adds a fetch. */
export async function fetchImmutableInputs(value,{repository,fetchRevision,signal}) {
  const plan=validateCiPlan(value);
  assert(typeof fetchRevision==='function','Expected the controlled Git fetch callback');
  signal?.throwIfAborted();
  const historical=await historicalPlan(plan.spec.approvedMain);
  const plans=historical?[plan,historical.plan]:[plan],identities=new Map();
  for(const selected of plans)for(const role of ['control','base','candidate']) {
    const source=selected.spec[role];if(!source)continue;
    const prior=identities.get(source.commit);
    assert(!prior||digest(prior)===digest(source),'Conflicting sealed Git identity for '+source.commit);
    identities.set(source.commit,source);
  }
  for(const source of identities.values()) {
    signal?.throwIfAborted();await fetchRevision(source.commit);signal?.throwIfAborted();
  }
  // A successful Git command alone is insufficient. Reproduce every source
  // tree/digest and the original base-to-candidate changed-path selection.
  for(const selected of plans){signal?.throwIfAborted();verifyImmutablePlan(repository,selected);}
  if(historical)assert((await hashFile(historical.path)).sha256===historical.sha256,'Protected approved-main packet changed during source fetch');
  signal?.throwIfAborted();
  return {kind:'ci-source-inputs-prepared-1',commits:[...identities.keys()],historicalPlanDigest:historical?.plan.digest??null,qualification:false};
}
