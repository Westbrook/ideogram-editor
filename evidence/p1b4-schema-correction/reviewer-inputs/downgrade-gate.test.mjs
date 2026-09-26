import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const r=JSON.parse(await readFile(new URL('../downgrade-results.json',import.meta.url)));
test('I-R03: an older writer must not accept writes in a store with unrecognized persisted approval semantics',()=>{
 assert.notEqual(r.oldUnrelatedWrite?.status,'accepted','dfa383d opened schema4 with a pending ApproveRaster and accepted an unrelated durable command');
});
test('I-R03: an older writer must preserve an unrecognized pending approval journal without resource-phase mutation',()=>{
 assert.equal(r.afterOld.pending.phase,r.before.pending.phase);
});
