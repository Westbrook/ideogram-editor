import assert from 'node:assert/strict';
import test from 'node:test';
import {nodeArguments,suites} from './test-node.mjs';
import {developmentPlan} from './qualification/development-plan.mjs';
test('Node aliases cover all groups and refuse unknown input before execution',()=>{
 assert.equal(suites.length,21);assert.deepEqual(nodeArguments([]),['run','--groups','base']);
 assert.deepEqual(nodeArguments(['store','session','store']),['run','--groups','store,session']);
 assert.throws(()=>nodeArguments(['unknown']),/Unknown Node/);assert.throws(()=>nodeArguments(['base','provider']),/aliases/);
});
test('development selection builds once, retains guards and schedules browsers last',()=>{
 const plan=developmentPlan(process.cwd(),{groups:'all'}),gates=plan.gates;
 assert.equal(gates.filter(g=>g.id==='build-server').length,1);assert.equal(gates.filter(g=>g.id==='build-app').length,1);
 assert.ok(gates.findIndex(g=>g.id==='node:qualification')<gates.findIndex(g=>g.id==='build-app'));
 assert.equal(gates.find(g=>g.id==='node:store').guard,'tests/store/no-network.mjs');
 assert.equal(gates.find(g=>g.id==='node:provider').guard,'tests/provider/no-egress.mjs');
 assert.equal(new Set(plan.selectedFiles).size,plan.selectedFiles.length);
 const firstBrowser=gates.findIndex(g=>g.browserPrerequisites);assert.ok(firstBrowser>0);
 assert.ok(gates.slice(firstBrowser).every(g=>g.browserPrerequisites));
 assert.ok(gates.find(g=>g.id==='node:history:browser').files.includes('tests/history/mask-text-compatibility.test.mjs'));
});
test('build-free tooling plan does not start app/server producers',()=>{
 const plan=developmentPlan(process.cwd(),{groups:'tooling',workers:2});
 assert.ok(plan.gates.every(g=>!g.id.startsWith('build-')));
 assert.ok(plan.gates.find(g=>g.id==='node:qualification').command.includes('--test-concurrency=2'));
 assert.throws(()=>developmentPlan(process.cwd(),{groups:'unknown'}),/Unknown/);
});
