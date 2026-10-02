// Stage for tests/provider after root promotion/build. No live endpoint is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProviderConfiguration,validateProviderRuntimeConfiguration} from '../../dist/local/server/provider/config.js';
import {ProviderRuntime} from '../../dist/local/server/provider/runtime.js';
import {egressAttempts} from './no-egress.mjs';

for(const requestedMode of ['disabled','fal'])test('V45 selector is a blocked nonsecret capability in '+requestedMode+' mode',()=>{
 const read=[];
 const env={IDEOGRAM_PROVIDER_MODE:requestedMode,IDEOGRAM_PROVIDER_MODEL:'ideogram/v4.5'};
 for(const key of ['FAL_KEY','FAL_KEY_FILE','IDEOGRAM_FAL_APPROVAL_FILE'])Object.defineProperty(env,key,{get(){read.push(key);throw Error('Do not read credential or approval');}});
 const config=loadProviderConfiguration(env);assert.deepEqual(config,{mode:'fal-v45-blocked',requestedMode});assert(Object.isFrozen(config));assert.deepEqual(read,[]);
 assert.deepEqual(validateProviderRuntimeConfiguration(config),config);assert.deepEqual(egressAttempts(),[]);
});

test('V45 blocked configuration cannot carry a key, approval or forged dispatch capability',()=>{
 for(const extra of [{key:'secret-sentinel'},{manifest:{}},{dispatchEligible:true},{profileId:'forged'},{requestedMode:'other'}]){
  assert.throws(()=>validateProviderRuntimeConfiguration({mode:'fal-v45-blocked',requestedMode:'fal',...extra}),{code:'PROVIDER_CONFIGURATION_INVALID'});
 }
 assert.throws(()=>loadProviderConfiguration({IDEOGRAM_PROVIDER_MODEL:'ideogram/v4.5/edit'}),{code:'PROVIDER_CONFIGURATION_INVALID'});
});

test('V45 runtime exposes unknown safety, never installs dispatch authority and remains inert through ticks and close',async()=>{
 let installed=0;
 const queue={get authorizeProvider(){return undefined;},set authorizeProvider(_){installed++;throw Error('No V45 authorizer');}};
 const store={epoch:'v45-test-epoch',queue,get candidates(){throw Error('No candidate scheduler');}};
 const runtime=new ProviderRuntime(store,{mode:'fal-v45-blocked',requestedMode:'fal'});
 const view=runtime.view();assert.equal(view.endpoint,'ideogram/v4.5');assert.equal(view.operation,'generate-v45');assert.equal(view.mode,'fal');assert.equal(view.ready,false);assert.equal(view.state,'admission-blocked');assert.equal(view.credentialConfigured,false);assert.equal(view.profile,null);assert.equal(view.limits,null);assert.equal(view.configurationId,null);
 assert.deepEqual(view.admission,{policy:'unknown-withheld-1',state:'blocked',reason:'provider-safety-evidence-unavailable',ordinaryDisplay:false,adoption:false,export:false});
 await runtime.tick();await runtime.tick();await runtime.close();assert.equal(installed,0);assert.deepEqual(egressAttempts(),[]);
});

test('legacy disabled configuration stays unchanged unless the new model is deliberately selected',()=>{
 assert.deepEqual(loadProviderConfiguration({}),{mode:'disabled'});
 assert.deepEqual(loadProviderConfiguration({IDEOGRAM_PROVIDER_MODE:'disabled',IDEOGRAM_PROVIDER_MODEL:'ideogram/v4'}),{mode:'disabled'});
 assert.deepEqual(validateProviderRuntimeConfiguration({mode:'disabled'}),{mode:'disabled'});
});
