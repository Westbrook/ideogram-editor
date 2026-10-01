import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertSameInventory, validationPreflight, checkTestSyntax} from '../../tooling/qualification/preflight.mjs';
import {requiredSuiteEnvironment} from '../../tooling/qualification/suite-prerequisites.mjs';
import {consumerInputs} from '../../tooling/consumer-inputs.mjs';
import {createBrowserPlan} from '../../tooling/qualification/container/browser-plan.mjs';

test('inventory refuses missing, extra and duplicate ownership',()=>{
  assertSameInventory(['a','b'],['b','a'],'example');
  for(const assigned of [['a'],['a','b','c'],['a','b','b']]) assert.throws(()=>assertSameInventory(['a','b'],assigned,'example'),/inventory mismatch/);
});
test('current source has complete metadata without running tests',async()=>{
  const result=await validationPreflight(process.cwd());
  assert.ok(result.nodeFiles>300);assert.ok(result.browserFiles>30);
});
test('campaign prerequisites are shared across mixed and focused selections',()=>{
  assert.deepEqual(requiredSuiteEnvironment(['tests/provider/ui.test.mjs']),{});
  assert.deepEqual(requiredSuiteEnvironment(['tests/provider/ui.test.mjs','tests/campaigns/fixtures-product.test.mjs']),{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
});
test('consumer closure rejects missing files before creating an environment',async t=>{
  const root=await mkdtemp(join(tmpdir(),'consumer-closure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{example:'file:vendor/text/example.tgz'}}));
  await writeFile(join(root,'package-lock.json'),JSON.stringify({packages:{'':{dependencies:{example:'file:vendor/text/example.tgz'}}}}));
  await assert.rejects(consumerInputs(root),/Missing or linked consumer input/);
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{example:'file:../outside.tgz'}}));
  await assert.rejects(consumerInputs(root),/Unsafe local dependency/);
});
test('separate browser attempts share fixture paths but never case reports',()=>{
  const first=createBrowserPlan({output:'/tmp/first',fixtureRoot:'/tmp/prepared'}),second=createBrowserPlan({output:'/tmp/second',fixtureRoot:'/tmp/prepared'});
  for(const id of ['projection-chromium','history-chromium','raster-chromium','text-chromium']){
    const a=first.steps.find(s=>s.id===id),b=second.steps.find(s=>s.id===id);
    for(const key of ['IE_RECOVERY_APP','IE_RASTER_APP','TEXT_APP']) if(a.env[key]) assert.equal(a.env[key],b.env[key]);
    for(const key of ['IE_RECOVERY_OUTPUT','IE_RASTER_OUTPUT']) if(a.env[key]) assert.notEqual(a.env[key],b.env[key]);
    assert.notEqual(a.caseReportFile,b.caseReportFile);
  }
  assert.ok(first.steps.slice(0,4).every(s=>!s.config));
});

test('syntax preflight parses TypeScript without running top-level setup',()=>{
 assert.doesNotThrow(()=>checkTestSyntax('fixture.ts','throw new Error("must not execute"); const value:number=1;'));
 assert.doesNotThrow(()=>checkTestSyntax('enum.spec.ts','enum Mode { A, B }; class C { constructor(public mode:Mode) {} }; throw Error("must not execute");'));
 assert.throws(()=>checkTestSyntax('broken.test.mjs','const missing = ;'),/Test syntax broken.test.mjs/);
 assert.throws(()=>checkTestSyntax('broken.spec.ts','if (true) const value=1;'),/Test syntax broken.spec.ts/);
});
