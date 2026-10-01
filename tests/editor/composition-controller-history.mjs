// Opt-in historical diagnostic, excluded from *.test.mjs discovery.
// Run explicitly with the pinned Node toolchain and all three exact historical
// source paths. This entry also runs the current controller regressions through
// their exported harness; it never substitutes invented historical snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
for(const key of ['COMPOSITION_OLD_SOURCE','COMPOSITION_REVIEWED_SOURCE','COMPOSITION_RESTORE_SOURCE'])assert(process.env[key],'Historical diagnostic requires '+key);
const {load,fixture,flush,deferred,event,changeOwner,inline,restoring,rawResponse}=await import('./composition-controller.test.mjs');
const Old=await load(process.env.COMPOSITION_OLD_SOURCE),Reviewed=await load(process.env.COMPOSITION_REVIEWED_SOURCE),BeforeRestoreFix=await load(process.env.COMPOSITION_RESTORE_SOURCE);

for(const [label,Controller,expected]of [['saved original',Old,'Original raw']])test('actual '+label+' controller saves its rendered Scene during pending raw inspection',async()=>{const f=fixture(Controller);await f.initial();const {completion}=await f.hold();await f.input(f.scene().values.at(-1),'Desired');assert.equal(f.saved.at(-1).graph.composition.scene,expected);await f.finish(completion);assert.equal(f.saved.at(-1).graph.composition.scene,expected);assert.equal(f.instance.c.scene,expected);});

for(const [name,Controller,kept]of [['reviewed first patch',Reviewed,false]])test(name+' resolves queued real Scene proposal before clean sync replacement',async()=>{
 const f=fixture(Controller);await f.initial();const callback=f.scene().values.at(-1),model=f.instance.c,base=f.instance.base,gate=deferred();
 f.editor.view.document={...f.editor.view.document,revision:'2'};f.editor.json=()=>gate.promise;const pending=f.instance.sync();
 const accepted=structuredClone(f.value);accepted.scene='New accepted';gate.resolve({composition:accepted,layers:[],bindings:{},revision:'2'});
 callback(event('Queued desired'));await pending;await flush();
 assert.equal(f.saved.length,kept?1:0);assert.equal(f.instance.accepted.scene,'New accepted');
 if(kept){assert.equal(f.instance.c,model);assert.equal(f.instance.base,base);assert.equal(f.saved[0].graph.composition.scene,'Queued desired');assert.equal(f.saved[0].revision,'1');assert.equal(f.scene().values[2],'Queued desired');assert.equal(f.instance.dirty,true);assert.throws(()=>f.instance.validate(),/Review the current document/);}
 else assert.equal(f.instance.c.scene,'New accepted');
});

test('reviewed first patch demonstrates foreign raw follow-up and publication before successor sync',async()=>{const f=fixture(Reviewed);await f.initial();const {completion}=await f.hold();changeOwner(f,'owner');f.pending.shift().resolve(rawResponse());await flush();assert.equal(f.pending.length,1);f.pending.shift().resolve(rawResponse());await completion;assert.equal(f.instance.rawText,'{}');});

test('reviewed first patch demonstrates foreign inline Prompt source save',async()=>{const f=fixture(Reviewed);await f.initial();const callback=inline(f,'prompt');changeOwner(f,'owner');await f.input(callback,'composition');assert.equal(f.saved.length,1);assert.equal(f.saved[0].graph.view,'composition');});

for(const [name,Controller,kept]of [['prior corrected candidate',BeforeRestoreFix,false]])test(name+' retains queued rendered Scene at saved-draft replacement',async()=>{const {f,gate,completion,result}=await restoring(Controller),model=f.instance.c,base=f.instance.base,accepted=JSON.stringify(f.instance.accepted);gate.resolve(result);f.scene().values.at(-1)(event('Edit during restore'));await completion;await flush();assert.equal(f.saved.length,kept?1:0);assert.equal(JSON.stringify(f.instance.accepted),accepted);if(kept){assert.equal(f.instance.c,model);assert.equal(f.instance.base,base);assert.equal(f.saved[0].revision,'2');assert.equal(f.saved[0].graph.composition.scene,'Edit during restore');assert.equal(f.scene().values[2],'Edit during restore');}else assert.equal(f.instance.c.scene,'Saved stale draft');});
