import test from 'node:test';
import assert from 'node:assert/strict';
import {runVerification} from '../../dist/local/server/text/supervisor.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
const module=new URL('./verifier-modes.mjs',import.meta.url);
test('native verifier supervisor refuses crash, false result, deadline and stale authority; subsequent lane works',async()=>{
 for(const mode of ['crash','false-result','hang'])await assert.rejects(runVerification({mode},()=>{},module,300),e=>['TEXT_VERIFICATION_FAILED','TEXT_VERIFICATION_DEADLINE'].includes(e.reason));
 let live=true;const pending=runVerification({mode:'hang'},()=>{if(!live)throw Error('STALE_SESSION');},module);setTimeout(()=>{live=false;},100);await assert.rejects(pending,/STALE_SESSION/);
 await runVerification({mode:'valid'},()=>{},module);
});
test('combined verifier budget has usable CJK headroom and refuses oversized requests',()=>{
 const budget=verificationBudget('中文',120,70,16437364,4979358);assert(budget.bytes<=100514328);assert(budget.bytes+16472991<=134217728);
 assert.throws(()=>verificationBudget('A'.repeat(16384),8192,8192,67108864,4979358),/TEXT_VERIFICATION_CAPACITY/);
});
