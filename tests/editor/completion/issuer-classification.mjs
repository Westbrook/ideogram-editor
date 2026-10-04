import assert from 'node:assert/strict';
import {parseAst} from 'rolldown/parseAst';

// Independently reviewed final network and response-ownership boundaries.
// Delegated request/body cleanup helpers are included with their direct issuers.
// A boundary change requires a new source review, not a rehash.
export const NETWORK_BOUNDARIES=Object.freeze({
 'src/state/recovery-client.ts':'faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd',
 'src/state/session-client.ts':'7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a',
 'src/text/contracts.ts':'08207c5aab6d234ac693fda1d8a0e4f3542bf446d67fc0b8370a5d8b9b024ca3',
 // Correction89: exact profile data read is bounded, same-origin and owned
 // by the existing full Apply stage; its raw bytes stay server-authorized.
 'src/text/durable.ts':'6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52',
 'src/text/engine.ts':'c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830',
 'src/state/editor-client.ts':'050bb6a57153674cff46f14212de0ac3b1321b647d764f55cd1a28c994a37e92',
 'src/observability/adapter-upload-hook.ts':'756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9',
 'src/observability/adapter-upload.ts':'77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba',
 'src/ui/adapter-library.ts':'c36e5c21aa53d940b7fe0507a81185eef5525bb5ee628bb59b9d2a4b91ad366e',
 'src/state/draft-persistence.ts':'677621bcddf8c2edebd9ba703552db3d3e41062a38e22e050dd7c0fd09060bdd',
 'src/state/command-results.ts':'b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b',
 'src/state/control-memory.ts':'80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75',
 'src/observability/model-memory.ts':'79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118',
 'src/observability/prompt-memory.ts':'65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc',
 'src/observability/recovery-memory.ts':'52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492',
 'src/observability/allocations.ts':'31a220cd0df3df7577212c64b5e5db3a21c16dc3c95de99f77721c4c6e77ac06',
 'src/observability/composition-observations.ts':'966cf50aea8c77470a0dad9ffc08accf03ae974f99bb05292b1cefe23de93cfc',
 'src/ui/storage-library.ts':'d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216',
 'src/ui/model-owner.ts':'b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524',
});
const literal=n=>n?.type==='Literal'?n.value:n?.type==='TemplateLiteral'&&n.expressions.length===0?n.quasis[0].value.cooked:undefined;
const key=n=>n.computed?literal(n.key):n.key?.name??literal(n.key);
const expression=source=>parseAst('('+source+')',{lang:'js'},'issuer-expression.js').body[0].expression;
const properties=node=>node?.type==='ObjectExpression'?node.properties:[];
const names=node=>properties(node).map(p=>p.type==='SpreadElement'?'...':key(p)).sort();
const field=(node,name)=>properties(node).find(p=>key(p)===name)?.value;
const sameNames=(node,expected)=>JSON.stringify(names(node))===JSON.stringify([...expected].sort());
const at=row=>row.path+':'+row.at;

function xhrFallbacks(worker,read){
 const ast=parseAst(read(worker.path).toString(),{lang:'js'},worker.path),scopes=[],parent=new WeakMap();
 function walk(node,scope){if(!node||typeof node!=='object')return;
  if(['Program','FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){scope={kind:node.type,nodes:[]};scopes.push(scope);}
  scope.nodes.push(node);
  for(const [k,value]of Object.entries(node))if(!['parent','comments','tokens'].includes(k))for(const child of Array.isArray(value)?value:[value])if(child&&typeof child==='object'){parent.set(child,node);walk(child,scope);}
 }walk(ast,null);
 const result=[];
 for(const scope of scopes)for(const node of scope.nodes.filter(n=>n.type==='NewExpression'&&n.callee?.name==='XMLHttpRequest')){
  const owner=parent.get(node),name=owner.type==='VariableDeclarator'&&owner.init===node?owner.id?.name:undefined;
  assert(name&&scope.kind!=='Program','XHR has a declared function-local owner');
  assert.equal(scope.nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name===name).length,1,'One XHR local declaration');
  assert(!scope.nodes.some(n=>n.type==='AssignmentExpression'&&n.left?.type==='Identifier'&&n.left.name===name||n.type==='UpdateExpression'&&n.argument?.name===name),'XHR local owner is not reassigned');
  for(const use of scope.nodes.filter(n=>n.type==='Identifier'&&n.name===name)){
   const context=parent.get(use);
   assert(context?.type==='VariableDeclarator'&&context.id===use||context?.type==='MemberExpression'&&context.object===use||context?.type==='Property'&&!context.computed&&!context.shorthand&&context.key===use,'XHR local owner cannot escape its reviewed methods');
  }
  for(const write of scope.nodes.filter(n=>n.type==='AssignmentExpression'&&n.left?.type==='MemberExpression'&&n.left.object?.name===name)){
   const member=write.left.computed?literal(write.left.property):write.left.property.name;
   assert(['responseType','onload','onerror'].includes(member),'XHR writes preserve original open/send methods');
  }
  const calls=scope.nodes.filter(n=>n.type==='CallExpression'&&n.callee?.type==='MemberExpression'&&n.callee.object?.name===name);
  const named=method=>calls.filter(n=>(n.callee.computed?literal(n.callee.property):n.callee.property.name)===method);
  assert(calls.every(n=>['open','send'].includes(n.callee.computed?literal(n.callee.property):n.callee.property.name)),'Only reviewed XHR methods');
  const opens=named('open'),sends=named('send');assert.equal(opens.length,1,'One XHR open per owner');assert.equal(sends.length,1,'One XHR send per owner');
  assert.equal(opens[0].arguments.length,3,'Reviewed XHR open arguments');assert.equal(literal(opens[0].arguments[0]),'GET','XHR fallback GET');assert.equal(sends[0].arguments.length,1);assert.equal(literal(sends[0].arguments[0]),null,'XHR fallback sends null');
  assert(node.start<opens[0].start&&opens[0].start<sends[0].start,'XHR constructed and method fixed before send');
  const row=worker.syntax.calls.find(c=>c.at===sends[0].start);assert(row,'XHR send appears in full syntax inventory');result.push(row);
 }
 assert.equal(result.length,3,'Three declared CanvasKit XHR fallback owners');
 assert.equal(new Set(result.map(row=>row.at)).size,3,'Each XHR owner has a distinct send');
 assert.equal(worker.syntax.calls.filter(c=>c.name==='send').length,3,'No unclassified worker send');
 return result;
}

export function classifyIssuers(modules,{read,workerPath,entryPath}){
 const emitted=modules.filter(m=>m.path.startsWith('dist/app/'));
 const direct=emitted.flatMap(m=>m.syntax.calls.filter(c=>['fetch','XMLHttpRequest','Request','sendBeacon','importScripts','SharedWorker','WebSocket','EventSource','WebTransport'].includes(c.name)).map(c=>({path:m.path,...c})));
 assert.equal(direct.filter(c=>c.callee==='fetch').length,9,'Nine reviewed emitted fetch sites');assert.equal(direct.filter(c=>c.callee==='XMLHttpRequest').length,3,'Three reviewed emitted XHR constructors');assert.equal(direct.length,12,'No unclassified direct networking API');
 const worker=emitted.find(m=>m.path===workerPath);assert(worker,'Explicit emitted native Worker entry');
 const classified=[];
 for(const row of direct.filter(c=>c.callee==='fetch')){
  const call=expression(row.source),init=call.arguments[1];assert.equal(call.arguments.length,2,'Reviewed fetch arguments');let kind;
  if(row.path===entryPath&&init?.type==='Identifier')kind='modulepreload';
  else if(sameNames(init,['credentials'])&&literal(field(init,'credentials'))==='same-origin'&&row.path===workerPath)kind='canvaskit-fetch';
  else if(sameNames(init,['credentials','redirect','signal'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'redirect'))==='error'&&field(init,'signal')?.type==='Identifier')kind='sealed-asset';
  // The reviewed session owner supplies method/headers/body and the original
  // composed signal through readOwnedJSON. Its adapter spreads that init first,
  // then fixes transport policy. The source pins bind that delegated ownership.
  else if(call.arguments[0]?.type==='Identifier'&&sameNames(init,['...','credentials','cache','redirect'])&&properties(init)[0]?.type==='SpreadElement'&&properties(init)[0].argument?.type==='Identifier'&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'cache'))==='no-store'&&literal(field(init,'redirect'))==='error')kind='session-json';
  else if(sameNames(init,['...','headers','credentials','cache','redirect'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'cache'))==='no-store'&&literal(field(init,'redirect'))==='error'&&field(init,'headers')?.type==='Identifier')kind='application-transport';
  else if(sameNames(init,['...','credentials','headers'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(field(init,'headers'),'X-App-Client'))==='LP-1')kind='recovery-release';
  assert(kind,'Unclassified emitted fetch '+at(row));classified.push({...row,kind});
 }
 for(const [kind,count]of Object.entries({'modulepreload':1,'canvaskit-fetch':2,'sealed-asset':3,'session-json':1,'application-transport':1,'recovery-release':1}))assert.equal(classified.filter(c=>c.kind===kind).length,count,'Closed '+kind+' issuer count');
 assert.equal(classified.filter(c=>c.kind==='sealed-asset'&&c.path===workerPath).length,1,'One sealed asset read in the worker');
 assert.equal(classified.filter(c=>c.kind==='sealed-asset'&&c.path!==workerPath&&c.path!==entryPath).length,2,'Two sealed asset reads in the main application');
 assert(classified.filter(c=>['session-json','application-transport','recovery-release'].includes(c.kind)).every(c=>c.path!==workerPath&&c.path!==entryPath),'Body issuers confined to the main application');
 const xhr=xhrFallbacks(worker,read);assert(direct.filter(c=>c.callee==='XMLHttpRequest').every(c=>c.path===workerPath),'XHR constructors confined to reviewed CanvasKit worker');
 const workers=emitted.flatMap(m=>m.syntax.calls.filter(c=>c.name==='Worker').map(c=>({path:m.path,...c})));assert.equal(workers.length,1,'One application Worker constructor');
 const workerCall=expression(workers[0].source),url=workerCall.arguments[0],options=workerCall.arguments[1],base=url?.arguments?.[1];
 const meta=n=>n?.type==='MemberExpression'&&!n.computed&&n.property?.name==='url'&&n.object?.type==='MetaProperty'&&n.object.meta?.name==='import'&&n.object.property?.name==='meta';
 assert(workerCall.type==='NewExpression'&&workerCall.callee?.name==='Worker'&&workerCall.arguments.length===2,'Original Worker constructor shape');
 assert(url?.type==='NewExpression'&&url.callee?.name==='URL'&&url.arguments.length===2&&literal(url.arguments[0])===workerPath.slice('dist/app'.length),'Worker URL refers to adopted emitted worker');
 assert(meta(base)||base?.type==='BinaryExpression'&&base.operator==='+'&&literal(base.left)===''&&meta(base.right),'Worker URL has the original module base');
 assert(sameNames(options,['type','name'])&&literal(field(options,'type'))==='module','Reviewed module Worker options');
 assert(workers[0].path!==workerPath&&workers[0].path!==entryPath,'Worker constructed by the main application');
 for(const m of emitted)assert.equal(m.syntax.keepalive.length,0,'No production keepalive option');
 const workerFallbacks=[...classified.filter(c=>c.kind==='canvaskit-fetch'),...xhr.map(c=>({path:workerPath,...c}))].sort((a,b)=>a.at-b.at).map(c=>({path:c.path,at:c.at,source:c.source,method:'GET',body:null,keepalive:false,scope:'Reviewed CanvasKit loader fallback; bodyless fetch or local XHR GET/send(null), without a reachability claim'}));
 return {directBrowserNetworking:direct,classifiedNetworking:classified.map(({path,at,source,kind})=>({path,at,source,kind})),workerFallbacks};
}
