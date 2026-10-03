import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {transformWithOxc} from 'vite';
import {modelMemoryURL,allocationsURL,uiModule} from './module.mjs';
const root=process.env.CANDIDATE_COMPARISON_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export const html=(strings,...values)=>({strings,values});export const svg=html;'),display=data('export const displayImage=value=>value;');
const viewport=await uiModule(root+'/src/ui/comparison-viewport.ts'),view=await uiModule(root+'/src/ui/comparison-view.ts',{'lit':lit,'./comparison-viewport.js':viewport,'./display-image.js':display}),adapter=await uiModule('src/ui/adapters.ts');
let code=(await transformWithOxc(await readFile(root+'/src/ui/candidate-comparison.ts','utf8'),'candidate-comparison.ts')).code;code=code.replace(/import\s+["']\.\/candidate-comparison\.css["'];?/g,'');for(const [specifier,url]of Object.entries({'lit':lit,'../observability/model-memory.js':modelMemoryURL,'./comparison-viewport.js':viewport,'./comparison-view.js':view,'./adapters.js':adapter}))code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(url)).replaceAll("'"+specifier+"'",JSON.stringify(url));
const {CandidateComparison}=await import(data(code)),{allocationLedger}=await import(allocationsURL);
const input={sourceURL:'source',preparedURL:'prepared',beforeURL:'before',afterURL:'after',width:4000,height:3000,documentWidth:4000,documentHeight:3000,placement:'current-document',newDocSameGrid:true};
const event=(value='')=>{const currentTarget={value,isConnected:true};return {currentTarget,composedPath:()=>[currentTarget],defaultPrevented:false};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,5));
function controls(template){const values=[],flatten=value=>{if(value==null)return '';if(Array.isArray(value))return value.map(flatten).join('');if(value.strings)return value.strings.reduce((out,part,i)=>out+part+(i<value.values.length?flatten(value.values[i]):''),'');return '__v'+(values.push(value)-1)+'__';};const markup=flatten(template),resolve=text=>text.replace(/__v(\d+)__/g,(_,i)=>String(values[Number(i)]));return {buttons:[...markup.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,attributes,label])=>({name:resolve(label),click:values[Number(/@click=__v(\d+)__/.exec(attributes)?.[1])]})),fields:[...markup.matchAll(/<en-number-field\b([^>]*)>/g)].map(([,attributes])=>({label:resolve(/label=([^ >]+)/.exec(attributes)?.[1]??''),input:values[Number(/@en-input=__v(\d+)__/.exec(attributes)?.[1])]}))};}
function fixture(){const host={updateComplete:Promise.resolve(true),requestUpdate(){}},controller=new CandidateComparison(host);return {host,controller,render:value=>controls(controller.render('candidate',value??input,()=>true)),state:()=>controller.states.get('candidate')};}
test('shared zoom and numeric pan retain exact originals and invalid value preserves applied view',async()=>{const f=fixture();try{let rendered=f.render();rendered.fields.find(field=>field.label==='Source and prepared shared zoom (% of fit)').input(event('200'));await Promise.resolve();rendered=f.render();rendered.buttons.find(button=>button.name==='Apply shared view').click(event());await turn();assert.deepEqual(f.state().pairs.source.view,{zoom:200,x:0,y:0});rendered=f.render();rendered.buttons.find(button=>button.name==='Pan both right').click(event());await turn();assert.deepEqual(f.state().pairs.source.view,{zoom:200,x:200,y:0});rendered=f.render();rendered.fields.find(field=>field.label==='Source and prepared shared zoom (% of fit)').input(event('0'));await Promise.resolve();rendered=f.render();rendered.buttons.find(button=>button.name==='Apply shared view').click(event());await turn();assert.deepEqual(f.state().pairs.source.view,{zoom:200,x:200,y:0});assert.match(f.state().pairs.source.error,/25 to 1600/);assert.equal(input.width,4000);}finally{await f.controller.dispose();}});
test('late veto and callbacks retained from old candidate input cannot alter current comparison',async()=>{const f=fixture();try{const old=f.render(),button=old.buttons.find(button=>button.name==='Show B: Prepared replacement'),veto=event();button.click(veto);veto.defaultPrevented=true;await turn();assert.equal(f.state().pairs.source.mode,'side-by-side');const next={...input,preparedURL:'successor'};f.render(next);button.click(event());await turn();assert.equal(f.state().pairs.source.mode,'side-by-side');}finally{await f.controller.dispose();}});
test('additional pairs are bounded, unique and participate in actual original-coordinate comparison',async()=>{const f=fixture();try{const pair={id:'native-toggle',heading:'Native layers',label:'Native text',a:{url:'off',width:4000,height:3000,name:'Native off'},b:{url:'on',width:4000,height:3000,name:'Native on'},allowOverlay:true};const controls=f.render({...input,additionalPairs:[pair]});assert(controls.fields.some(field=>field.label==='Native text shared zoom (% of fit)'));assert.throws(()=>f.render({...input,additionalPairs:[pair,pair]}),/CANDIDATE_COMPARISON_PAIR/);assert.throws(()=>f.render({...input,additionalPairs:[pair,pair,pair]}),/CANDIDATE_COMPARISON_LIMIT/);}finally{await f.controller.dispose();}});
test('actual host retirement barrier keeps both old rendered payload and pending action until commit',async()=>{const f=fixture(),before=allocationLedger.snapshot();let release;try{const rendered=f.render();f.host.updateComplete=new Promise(resolve=>{release=resolve;});rendered.buttons.find(button=>button.name==='Show B: Prepared replacement').click(event());f.render({...input,preparedURL:'next'});await turn();assert(f.controller.lifecycle.retired>0);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes);let done=false;const closing=f.controller.dispose().then(()=>{done=true;});await turn();assert.equal(done,false);release(true);await closing;assert.equal(f.controller.lifecycle.renderOwners,0);}finally{release?.(true);await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);});
test('throwing initial disposal render still installs an observed drain and retains owners for retry',async()=>{const f=fixture(),before=allocationLedger.snapshot();f.render();const update=f.host.requestUpdate;try{f.host.requestUpdate=()=>{throw Error('native render failed');};const closing=f.controller.dispose();assert(closing instanceof Promise);await assert.rejects(closing,/CANDIDATE_COMPARISON_RELEASE/);assert(f.controller.lifecycle.retired>0);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes);f.host.requestUpdate=update;await f.controller.dispose();assert.equal(f.controller.lifecycle.retired,0);}finally{f.host.requestUpdate=update;await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);});

const letteringPairs=()=>[
 {id:'lettering-alone-off',heading:'Returned lettering and native-off comparison',label:'Returned candidate and native-off comparison',a:{url:'bounded-candidate-alone',width:4000,height:3000,name:'Returned candidate alone'},b:{url:'bounded-native-off',width:4000,height:3000,name:'Reviewed native off'},allowOverlay:true},
 {id:'lettering-off-on',heading:'Reviewed native text off and on',label:'Reviewed native off and on',a:{url:'bounded-native-off',width:4000,height:3000,name:'Native off'},b:{url:'bounded-native-on',width:4000,height:3000,name:'Native on'},allowOverlay:true},
];
const pending=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('standalone deferred comparisons use only their actual labels and retain original-coordinate zoom and pan',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs(),original=structuredClone(pairs),render=()=>controls(f.controller.renderPairs('candidate',pairs,()=>true));
 try{
  let view=render();assert.deepEqual(Object.keys(f.state().pairs),['lettering-alone-off','lettering-off-on']);assert.equal(view.buttons.some(button=>button.name.includes('Prepared replacement')),false);assert.equal(view.fields.some(field=>field.label.startsWith('Source and prepared')),false);
  view.fields.find(field=>field.label==='Returned candidate and native-off comparison shared zoom (% of fit)').input(event('200'));await Promise.resolve();view=render();view.buttons.find(button=>button.name==='Apply shared view').click(event());await turn();assert.deepEqual(f.state().pairs['lettering-alone-off'].view,{zoom:200,x:0,y:0});
  view=render();view.buttons.find(button=>button.name==='Pan both right').click(event());await turn();assert.deepEqual(f.state().pairs['lettering-alone-off'].view,{zoom:200,x:200,y:0});assert.deepEqual(f.state().pairs['lettering-off-on'].view,{zoom:100,x:0,y:0});assert.deepEqual(pairs,original);
 }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('standalone pair admission accepts four exact pairs and rejects invalid successors without replacing live owners',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pair=letteringPairs()[0],four=Array.from({length:4},(_,index)=>({...pair,id:'pair-'+index}));
 try{
  f.controller.renderPairs('candidate',four,()=>true);const state=f.state(),owners=f.controller.lifecycle,charged=allocationLedger.snapshot().cpuBytes;assert.equal(Object.keys(state.pairs).length,4);
  for(const value of [[],[...four,{...pair,id:'fifth'}]])assert.throws(()=>f.controller.renderPairs('candidate',value,()=>true),/CANDIDATE_COMPARISON_LIMIT/);
  for(const value of [[pair,pair],[{...pair,id:'Bad ID'}],[{...pair,label:'x'.repeat(129)}]])assert.throws(()=>f.controller.renderPairs('candidate',value,()=>true),/CANDIDATE_COMPARISON_PAIR/);
  assert.equal(f.state(),state);assert.deepEqual(f.controller.lifecycle,owners);assert.equal(allocationLedger.snapshot().cpuBytes,charged);
 }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('standalone pair callbacks cannot cross ownership, successor render or explicit retirement boundaries',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();let owned=true;
 try{
  const first=controls(f.controller.renderPairs('candidate',pairs,()=>owned)),old=first.buttons.find(button=>button.name==='Show B: Reviewed native off');owned=false;old.click(event());await turn();assert.equal(f.state().pairs['lettering-alone-off'].mode,'side-by-side');
  owned=true;const next=structuredClone(pairs);next[0].b.url='successor-native-off';f.controller.renderPairs('candidate',next,()=>owned);const successor=f.state();old.click(event());await turn();assert.equal(f.state(),successor);assert.equal(successor.pairs['lettering-alone-off'].mode,'side-by-side');
  const rendered=controls(f.controller.renderPairs('candidate',next,()=>owned)),stale=rendered.buttons.find(button=>button.name==='Show B: Reviewed native off'),close=f.controller.retirePairs('candidate');assert.equal(f.state(),undefined);stale.click(event());await turn();assert.equal(f.state(),undefined);await close();assert.equal(f.controller.lifecycle.renderOwners,0);
 }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('retiring one pair generation waits for publication and never closes a newer generation with the same key',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),barrier=pending(),update=f.host.requestUpdate;let close;
 try{
  f.controller.renderPairs('candidate',letteringPairs(),()=>true);close=f.controller.retirePairs('candidate');assert.equal(f.controller.lifecycle.states,0);assert.equal(f.controller.lifecycle.renderOwners,0);assert.equal(f.controller.lifecycle.retired,2);
  f.host.requestUpdate=function(){this.updateComplete=barrier.promise;};let settled=false;const closing=close().then(()=>{settled=true;});await turn();assert.equal(settled,false);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes);
  const next=letteringPairs();next[0].b.url='new-reviewed-native-off';f.controller.renderPairs('candidate',next,()=>true);const successor=f.state();assert.equal(f.controller.lifecycle.states,1);assert.equal(f.controller.lifecycle.renderOwners,1);
  barrier.resolve();await closing;assert.equal(f.state(),successor);assert.equal(f.controller.lifecycle.states,1);assert.equal(f.controller.lifecycle.renderOwners,1);assert.equal(f.controller.lifecycle.retired,0);await close();assert.equal(f.state(),successor,'Retrying the old close remains generation-specific');
 }finally{barrier.resolve();f.host.requestUpdate=update;f.host.updateComplete=Promise.resolve(true);await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('a rejected pair-retirement publication keeps captured owners charged until the same close is retried',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),barrier=pending(),update=f.host.requestUpdate;let close;
 try{
  f.controller.renderPairs('candidate',letteringPairs(),()=>true);close=f.controller.retirePairs('candidate');f.host.requestUpdate=function(){this.updateComplete=barrier.promise;};const closing=close(),rejected=assert.rejects(closing,/publication failed/);barrier.reject(Error('publication failed'));await rejected;
  assert.equal(f.controller.lifecycle.retired,2);assert.equal(f.controller.lifecycle.states,0);assert.equal(f.controller.lifecycle.renderOwners,0);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes);
  f.host.requestUpdate=update;f.host.updateComplete=Promise.resolve(true);await close();assert.equal(f.controller.lifecycle.retired,0);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
 }finally{f.host.requestUpdate=update;f.host.updateComplete=Promise.resolve(true);await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('explicit retirement also retries older rendered owners after their publication failed',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),barrier=pending(),update=f.host.requestUpdate,pairs=letteringPairs();
 try{
  f.controller.renderPairs('candidate',pairs,()=>true);f.host.updateComplete=barrier.promise;f.controller.renderPairs('candidate',pairs,()=>true);
  await Promise.resolve();barrier.reject(Error('prior render publication failed'));await turn();assert.equal(f.controller.lifecycle.retired,1);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes);
  f.host.requestUpdate=update;f.host.updateComplete=Promise.resolve(true);const close=f.controller.retirePairs('candidate');await close();
  assert.equal(f.controller.lifecycle.retired,0);assert.equal(f.controller.lifecycle.states,0);assert.equal(f.controller.lifecycle.renderOwners,0);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
 }finally{barrier.resolve();f.host.requestUpdate=update;f.host.updateComplete=Promise.resolve(true);await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});


test('an admitted reveal settles across identical rendering while both original and current ownership remain valid',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs(),barrier=pending();
 try{
  const rendered=controls(f.controller.renderPairs('candidate',pairs,()=>true)),state=f.state();
  rendered.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(event('25'));
  f.host.updateComplete=barrier.promise;f.controller.renderPairs('candidate',structuredClone(pairs),()=>true);
  await Promise.resolve();assert.equal(f.state(),state);assert.equal(state.pairs['lettering-alone-off'].value,'25');assert.equal(state.pairs['lettering-alone-off'].percentage,25);assert.equal(state.pairs['lettering-alone-off'].mode,'reveal');
  assert(f.controller.lifecycle.retired>0);assert(allocationLedger.snapshot().cpuBytes>before.cpuBytes,'The old rendered payload stays charged until publication');
  barrier.resolve(true);await turn();assert.equal(f.controller.lifecycle.retired,0);
 }finally{barrier.resolve(true);f.host.updateComplete=Promise.resolve(true);await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('pending reveal refuses changed pair content, original grid, overlay permission and provenance labels',async()=>{
 for(const change of [pairs=>pairs[0].b.url='new-native-off',pairs=>pairs[0].a.width=2000,pairs=>pairs[0].allowOverlay=false,pairs=>pairs[0].heading='New reviewed provenance']){
  const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();
  try{
   const rendered=controls(f.controller.renderPairs('candidate',pairs,()=>true)),old=f.state();rendered.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(event('25'));
   const next=structuredClone(pairs);change(next);f.controller.renderPairs('candidate',next,()=>true);const current=f.state();assert.notEqual(current,old);await Promise.resolve();
   assert.equal(current.pairs['lettering-alone-off'].mode,'side-by-side');assert.equal(current.pairs['lettering-alone-off'].value,'50');assert.equal(old.pairs['lettering-alone-off'].mode,'side-by-side');
  }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
 }
});

test('identical pending reveal requires the original owner and the latest render owner independently',async()=>{
 for(const retiredOwner of ['original','latest']){
  const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();let original=true;
  try{
   const rendered=controls(f.controller.renderPairs('candidate',pairs,()=>original)),state=f.state();rendered.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(event('25'));
   if(retiredOwner==='original')original=false;
   f.controller.renderPairs('candidate',structuredClone(pairs),()=>retiredOwner!=='latest');await Promise.resolve();assert.equal(f.state(),state);
   assert.equal(state.pairs['lettering-alone-off'].mode,'side-by-side');assert.equal(state.pairs['lettering-alone-off'].value,'50');
  }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
 }
});

test('a callback from a superseded identical render cannot start a new field transaction',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();
 try{
  const old=controls(f.controller.renderPairs('candidate',pairs,()=>true));f.controller.renderPairs('candidate',structuredClone(pairs),()=>true);const pending=f.controller.lifecycle.pending;
  old.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(event('25'));assert.equal(f.controller.lifecycle.pending,pending);await Promise.resolve();
  assert.equal(f.state().pairs['lettering-alone-off'].mode,'side-by-side');assert.equal(f.state().pairs['lettering-alone-off'].value,'50');
 }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

test('identical rendering never bypasses a late veto, disconnected control or explicit retirement',async()=>{
 for(const invalidation of ['veto','disconnect','retire']){
  const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();let close;
  try{
   const rendered=controls(f.controller.renderPairs('candidate',pairs,()=>true)),state=f.state(),proposal=event('25');rendered.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(proposal);
   f.controller.renderPairs('candidate',structuredClone(pairs),()=>true);
   if(invalidation==='veto')proposal.defaultPrevented=true;else if(invalidation==='disconnect')proposal.currentTarget.isConnected=false;else close=f.controller.retirePairs('candidate');
   await Promise.resolve();assert.equal(state.pairs['lettering-alone-off'].mode,'side-by-side');assert.equal(state.pairs['lettering-alone-off'].value,'50');if(close){await close();assert.equal(f.state(),undefined);}
  }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
 }
});

test('a newer accepted proposal on the same control supersedes the pending pre-render proposal',async()=>{
 const f=fixture(),before=allocationLedger.snapshot(),pairs=letteringPairs();
 try{
  const first=controls(f.controller.renderPairs('candidate',pairs,()=>true)),proposal=event('25');first.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input(proposal);
  const next=controls(f.controller.renderPairs('candidate',structuredClone(pairs),()=>true));proposal.currentTarget.value='75';next.fields.find(field=>field.label==='Returned candidate and native-off comparison reveal percentage').input({...proposal});await Promise.resolve();
  assert.equal(f.state().pairs['lettering-alone-off'].mode,'reveal');assert.equal(f.state().pairs['lettering-alone-off'].value,'75');assert.equal(f.state().pairs['lettering-alone-off'].percentage,75);
 }finally{await f.controller.dispose();}assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});
