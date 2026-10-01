import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeTransportTemplate} from '../../dist/local/server/storage/queue-transport.js';
import {newDraft,resolve,bodyTemplate,hash} from '../../dist/local/src/request/core.js';

const ref=(digit,mediaType='application/octet-stream')=>({hash:'sha256:'+digit.repeat(64),byteLength:'64',mediaType});
function fixture(){
 const prompt='Literal "loras" inside a prompt must remain a prompt.';
 const d=newDraft({hash:hash(prompt),byteLength:String(Buffer.byteLength(prompt)),mediaType:'text/plain'});d.operation='generate-adapters';d.fields.seed='9007199254740993';
 d.adapters=[{version:'one',hash:ref('b').hash,scale:'0',runtimeAcknowledged:true},{version:'two',hash:ref('b').hash,scale:'4',runtimeAcknowledged:true},{version:'three',hash:ref('c').hash,scale:'1',runtimeAcknowledged:true}];
 const eligible={adapters:new Map(d.adapters.map(a=>[a.version,{hash:a.hash,available:true,profile:'v4-safe-1',runtimeVerified:false}]))};
 const request=resolve(d,'Literal "loras" inside a prompt must remain a prompt.',eligible),template=bodyTemplate(request,'Literal "loras" inside a prompt must remain a prompt.');
 const stages=d.adapters.map((a,index)=>({role:`adapter:${index}`,versionId:a.version,original:ref(index===2?'c':'b'),transport:ref(index===2?'c':'b')}));
 return {request,template,stages,mapping:{'adapter:0':'https://media.example/one','adapter:1':'https://media.example/two','adapter:2':'https://media.example/three'}};
}
test('ordered immutable adapter versions receive positional URLs even when their weights match; zero scale and exact seed survive',()=>{
 const f=fixture(),value=materializeTransportTemplate(f.template,f.request,f.stages,f.mapping);
 assert.match(value,/"seed":9007199254740993/);
 assert.deepEqual(JSON.parse(value).loras,[{path:f.mapping['adapter:0'],scale:0},{path:f.mapping['adapter:1'],scale:4},{path:f.mapping['adapter:2'],scale:1}]);
 assert.equal(JSON.parse(value).prompt,JSON.parse(f.template).prompt);
 assert.equal(JSON.parse(f.template).loras[0].path,'asset:'+ref('b').hash);
});
test('missing, extra, duplicate, stale-version and edited-weight mappings fail without a fallback',()=>{
 const f=fixture();
 for(const [stages,mapping]of [[f.stages,{'adapter:0':f.mapping['adapter:0']}],[f.stages,{...f.mapping,source:'https://media.example/source'}],[[f.stages[0],f.stages[0],f.stages[2]],f.mapping],[[{...f.stages[0],versionId:'stale'},...f.stages.slice(1)],f.mapping],[[{...f.stages[0],transport:ref('d')},...f.stages.slice(1)],f.mapping]])assert.throws(()=>materializeTransportTemplate(f.template,f.request,stages,mapping));
 assert.throws(()=>materializeTransportTemplate(f.template,f.request,[],{}));
 assert.throws(()=>materializeTransportTemplate(f.template.replace('"loras":','"other":'),f.request,f.stages,f.mapping));
});
