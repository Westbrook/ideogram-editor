import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {headers} from './app-buffer-core.mjs';
import {networkForEpoch,assertProtocolOwnership} from './protocol-membership.mjs';
import {monitorHarness} from './monitor-harness.mjs';
const prior=readFileSync(process.env.PROTOCOL_OLD_MONITOR,'utf8');
const text=prior.match(/ function networkFor\(e\)\{[^\n]+\}/)?.[0];assert(text);
const oldSelect=network=>runInNewContext('('+text.trim()+')',{network,headers,URL,Set});
const oldGuard=(network,epochs,select)=>{for(const n of network)assert.equal(epochs.filter(e=>select(e).includes(n)).length,1,'Every protocol event owns exactly one epoch');};
const event=(id,url)=>({name:'Network.requestWillBeSent',params:{requestId:id,request:{url}}});
const epoch=origin=>({origin});
const A='http://127.0.0.1:41001',B='http://127.0.0.1:41002',C='http://localhost:41003';
const verdict=fn=>{try{fn();return {passed:true};}catch(e){return {passed:false,name:e.name,message:e.message};}};
function equivalent(network,epochs){
 const original=network.slice(),params=JSON.stringify(network);const old=oldSelect(network),next=e=>networkForEpoch(network,e);
 for(const e of epochs){let a,b;const av=verdict(()=>{a=old(e);}),bv=verdict(()=>{b=next(e);});assert.deepEqual(bv,av);if(av.passed){assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.equal(a[i],b[i]);}}
 assert.deepEqual(verdict(()=>assertProtocolOwnership(network,epochs,next)),verdict(()=>oldGuard(network,epochs,old)));
 assert.equal(network.length,original.length);original.forEach((e,i)=>assert.equal(network[i],e));assert.equal(JSON.stringify(network),params);
}
const cases={
 'three origins':()=>({network:[event('a',A+'/a'),event('b',B+'/b'),event('c',C+'/c')],epochs:[epoch(A),epoch(B),epoch(C)]}),
 'orphan':()=>({network:[event('a',A+'/a'),event('x','http://unknown:80/x')],epochs:[epoch(A)]}),
 'multiple owner':()=>({network:[event('a',A+'/a')],epochs:[epoch(A),epoch(A)]}),
 'repeated same object':()=>{const n=event('a',A+'/a');return {network:[n,n,n],epochs:[epoch(A)]};},
 'distinct equal objects':()=>{const n=event('a',A+'/a');return {network:[n,structuredClone(n)],epochs:[epoch(A)]};},
 'same request different events':()=>({network:[event('a',A+'/a'),{name:'Network.loadingFinished',params:{requestId:'a'}}],epochs:[epoch(A)]}),
 'shared request across origins':()=>({network:[event('a',A+'/a'),event('a',B+'/a')],epochs:[epoch(A),epoch(B)]}),
 'ExtraInfo host':()=>({network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'a',headers:{Host:'127.0.0.1:41001'}}},{name:'Network.loadingFailed',params:{requestId:'a'}}],epochs:[epoch(A)]}),
 'closed IDs':()=>({network:[{name:'Network.loadingFinished',params:{requestId:'a'}}],epochs:[{origin:A,closedNetworkIds:['a','a']}]}),
 'bad URL':()=>({network:[event('a','%%%')],epochs:[epoch(A)]}),
 'bad origin':()=>({network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'a',headers:{host:'x'}}}],epochs:[epoch('bad')]}),
 'missing headers':()=>({network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'a'}}],epochs:[epoch(A)]}),
 'null headers':()=>({network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'a',headers:null}}],epochs:[epoch(A)]}),
 'wrong header value':()=>({network:[{name:'Network.requestWillBeSentExtraInfo',params:{requestId:'a',headers:{host:123}}}],epochs:[epoch(A)]}),
 'empty':()=>({network:[],epochs:[epoch(A),epoch(B),epoch(C)]})
};
for(const [name,make]of Object.entries(cases))test('old/new original-object ownership equivalence: '+name,()=>{const x=make();equivalent(x.network,x.epochs);});
test('distinct equal object outside membership stays orphan',()=>{const a=event('a',A),b=structuredClone(a);assert.throws(()=>assertProtocolOwnership([a,b],[epoch(A)],()=>[a]),/exactly one/);});
test('one epoch counts duplicate membership references only once',()=>{const n=event('a',A);assert.doesNotThrow(()=>assertProtocolOwnership([n,n],[epoch(A)],()=>[n,n,n]));});
test('deterministic once-per-epoch construction and every raw occurrence in order',()=>{
 const a=event('a',A),b=event('b',B),c=event('c',C),raw=[a,a,b,c,a],seen=[],calls=[];
 const input={*[Symbol.iterator](){for(const row of raw){seen.push(row);yield row;}}};
 assertProtocolOwnership(input,[epoch(A),epoch(B),epoch(C)],e=>{calls.push(e.origin);return raw.filter(n=>new URL(n.params.request.url).origin===e.origin);});
 assert.deepEqual(calls,[A,B,C]);assert.deepEqual(seen,raw);assert.equal(seen.length,5);
});
test('fresh final invocation observes additions with no earlier cache',()=>{const network=[event('a',A)];const epochs=[epoch(A)];assertProtocolOwnership(network,epochs,e=>networkForEpoch(network,e));network.push(event('orphan',B));assert.throws(()=>assertProtocolOwnership(network,epochs,e=>networkForEpoch(network,e)),/exactly one/);});
for(let seed=0;seed<24;seed++)test('bounded ordered permutation '+seed,()=>{const origins=[A,B,C],epochs=origins.map(epoch),network=Array.from({length:6},(_,i)=>event(String((i+seed)%5),origins[(i+seed)%3]+'/'+i));if(seed%2)network.push(network[seed%6]);if(seed%3)network.reverse();if(seed%4===0)epochs.push(epoch(A));equivalent(network,epochs);});
test('actual finish refuses orphan arriving in final retained validation',async()=>{const h=await monitorHarness();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();h.onShutdown(()=>h.pageSession.emit('Network.loadingFinished',{requestId:'late-orphan'}));await assert.rejects(()=>h.monitor.finish(true),/Every protocol event owns exactly one epoch/);assert.equal(h.record().complete,false);});
test('actual finish retains successful empty epoch with unchanged final rules',async()=>{const h=await monitorHarness();await h.monitor.closeEpoch();await h.monitor.beforeNavigate();await h.pagehide();await h.monitor.detach();await h.monitor.finish(true);assert.equal(h.record().complete,true);});
