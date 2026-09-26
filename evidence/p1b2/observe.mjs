import { mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir,platform,arch,release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { command,checkpoint,encode,expectedBytes,refFor } from '../../tests/store/helpers.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'ie-p1b2-observe-'));let writer;
try{
 writer=await openWriter({root},{effectCounters:globalThis.__storeNetworkCounters.shared});const ref=await writer.putObject([expectedBytes],refFor(expectedBytes),writer.epoch);
 const first=command(ref);const begin=performance.now();await writer.submit(encode(first),writer.epoch);const firstReceiptMs=performance.now()-begin;
 for(let i=1;i<249;i++)await writer.submit(encode(checkpoint(ref,String(i))),writer.epoch);
 const start=performance.now();await writer.submit(encode(checkpoint(ref,'249')),writer.epoch);const receiptIncludingSnapshotMs=performance.now()-start;
 const captureStart=performance.now();const captured=await writer.capture();const verifiedSnapshotDescriptorMs=performance.now()-captureStart;
 const diagnostics=await writer.diagnostics();await writer.close();const reopen=performance.now();writer=await openWriter({root},{effectCounters:globalThis.__storeNetworkCounters.shared});const reopenMs=performance.now()-reopen;
 const reopened=await writer.diagnostics();const evidence={at:new Date().toISOString(),node:process.versions.node,npm:'12.1.0',os:{platform:platform(),arch:arch(),release:release()},sqlite:diagnostics.sqlite,settings:diagnostics.settings,
  snapshot:{seq:captured.snapshot.seq,hash:captured.snapshot.content.blob.hash,byteLength:captured.snapshot.content.blob.byteLength,records:captured.snapshot.content.recordCount},
  resources:diagnostics.resources,processMemory:diagnostics.processMemory,observations:{firstReceiptMs,receiptIncludingSnapshotMs,verifiedSnapshotDescriptorMs,reopenMs,workerReplayMs:reopened.observations.replayMs},
  projectionDigestBefore:diagnostics.projectionDigest,projectionDigestAfter:reopened.projectionDigest,effects:globalThis.__storeNetworkCounters.read(),qualification:false,
  limits:'Single observations, synthetic empty document plus checkpoints; not W1/W2/PERF or full100k replay. Restart span includes OS ownership and worker startup. No provider transport.'};
 await writeFile('artifacts/p1b2/runtime.json',JSON.stringify(evidence,null,2)+'\n');
}finally{if(writer)await writer.close();await rm(root,{recursive:true,force:true});}
