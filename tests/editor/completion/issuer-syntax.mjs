import assert from 'node:assert/strict';
import {parseAst} from 'rolldown/parseAst';
export function syntaxInventory(path,text){
 const ast=parseAst(text,{lang:path.endsWith('.ts')?'ts':'js'},path),edges=[],calls=[],assets=[],keepalive=[];
 const literal=n=>n?.type==='Literal'?n.value:n?.type==='TemplateLiteral'&&n.expressions.length===0?n.quasis[0].value.cooked:undefined;
 function visit(n){if(!n||typeof n!=='object')return;
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type)&&n.source)edges.push({kind:'static',value:literal(n.source)});
  if(n.type==='ImportExpression'){const value=literal(n.source);assert(typeof value==='string','Resolved dynamic module edge');edges.push({kind:'dynamic',value});}
  const value=literal(n);if(typeof value==='string'&&/^\/?assets\//.test(value))assets.push(value);
  if(n.type==='Property'&&(n.key?.name==='keepalive'||n.key?.value==='keepalive'))keepalive.push({at:n.start,value:literal(n.value)??null,expression:text.slice(n.value.start,n.value.end)});
  if(['CallExpression','NewExpression'].includes(n.type)){
   const c=n.callee,name=c?.type==='Identifier'?c.name:c?.type==='MemberExpression'?(c.computed?literal(c.property):c.property.name):undefined;
   if(['fetch','Request','XMLHttpRequest','sendBeacon','Worker','SharedWorker','WebSocket','EventSource','WebTransport','importScripts','transport','json','post','send','open'].includes(name))calls.push({at:n.start,kind:n.type,name,callee:text.slice(c.start,c.end),source:text.slice(n.start,n.end)});
  }
  for(const [k,v]of Object.entries(n))if(!['parent','comments','tokens'].includes(k)){if(Array.isArray(v))for(const x of v)visit(x);else if(v&&typeof v==='object')visit(v);}
 }visit(ast);return {edges,calls,assets:[...new Set(assets)],keepalive};
}
