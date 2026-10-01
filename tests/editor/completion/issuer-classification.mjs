import assert from 'node:assert/strict';
import {parseAst} from 'rolldown/parseAst';

// Network boundary review: docs/testing/completion-network-review.md.
// A boundary change requires a new source review, not an automatic rehash.
export const NETWORK_BOUNDARIES=Object.freeze({
 'src/observability/recovery-memory.ts':'52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492',
 'src/state/recovery-client.ts':'43f23b5cfb96db02e99a624ba0fcbe45aef3c1c96bd3db69b18a78aec5eabef4',
 'src/state/session-client.ts':'eed37b101c2f2c5ce9cf948058b918e5dc1995bcee310f0d3384c24884b80f9b',
 'src/text/contracts.ts':'96aa65d78cf834c14def464df88d3b94982193cfeabc8f70b1eaba3d86fae6ec',
 'src/text/engine.ts':'c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830',
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
 assert.equal(direct.filter(c=>c.callee==='fetch').length,8,'Eight reviewed emitted fetch sites');assert.equal(direct.filter(c=>c.callee==='XMLHttpRequest').length,3,'Three reviewed emitted XHR constructors');assert.equal(direct.length,11,'No unclassified direct networking API');
 const worker=emitted.find(m=>m.path===workerPath);assert(worker,'Explicit emitted native Worker entry');
 const classified=[];
 for(const row of direct.filter(c=>c.callee==='fetch')){
  const call=expression(row.source),init=call.arguments[1];assert.equal(call.arguments.length,2,'Reviewed fetch arguments');let kind;
  if(row.path===entryPath&&init?.type==='Identifier')kind='modulepreload';
  else if(sameNames(init,['credentials'])&&literal(field(init,'credentials'))==='same-origin'&&row.path===workerPath)kind='canvaskit-fetch';
  else if(sameNames(init,['credentials','redirect','signal'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'redirect'))==='error'&&field(init,'signal')?.type==='Identifier')kind='sealed-asset';
  else if(sameNames(init,['method','headers','...','credentials','cache','redirect','signal'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'cache'))==='no-store'&&literal(field(init,'redirect'))==='error'&&row.source.includes('AbortSignal.timeout('))kind='session-json';
  else if(sameNames(init,['...','headers','credentials','cache','redirect'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(init,'cache'))==='no-store'&&literal(field(init,'redirect'))==='error'&&field(init,'headers')?.type==='Identifier')kind='application-transport';
  else if(sameNames(init,['...','credentials','headers'])&&literal(field(init,'credentials'))==='same-origin'&&literal(field(field(init,'headers'),'X-App-Client'))==='LP-1')kind='recovery-release';
  assert(kind,'Unclassified emitted fetch '+at(row));classified.push({...row,kind});
 }
 for(const [kind,count]of Object.entries({'modulepreload':1,'canvaskit-fetch':2,'sealed-asset':2,'session-json':1,'application-transport':1,'recovery-release':1}))assert.equal(classified.filter(c=>c.kind===kind).length,count,'Closed '+kind+' issuer count');
 assert.equal(classified.filter(c=>c.kind==='sealed-asset'&&c.path===workerPath).length,1,'One sealed asset read in the worker');
 assert.equal(classified.filter(c=>c.kind==='sealed-asset'&&c.path!==workerPath&&c.path!==entryPath).length,1,'One sealed asset read in the main application');
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
