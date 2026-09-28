import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,posix} from 'node:path';
import {parseAst} from 'rolldown/parseAst';
import {digest} from './host-final-core.mjs';
export function syntaxInventory(path,text){
 const ast=parseAst(text,{lang:path.endsWith('.ts')?'ts':'js'},path),edges=[],calls=[],assets=[],keepalive=[];
 const literal=n=>n?.type==='Literal'?n.value:n?.type==='TemplateLiteral'&&n.expressions.length===0?n.quasis[0].value.cooked:undefined;
 function visit(n){if(!n||typeof n!=='object')return;
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type)&&n.source)edges.push({kind:'static',value:literal(n.source)});
  if(n.type==='ImportExpression'){const value=literal(n.source);assert(typeof value==='string','Resolved dynamic module edge');edges.push({kind:'dynamic',value});}
  const value=literal(n);if(typeof value==='string'&&/^\/?assets\//.test(value))assets.push(value);
  if(n.type==='Property'&&(n.key?.name==='keepalive'||n.key?.value==='keepalive'))keepalive.push({at:n.start,value:literal(n.value)??null,expression:text.slice(n.value.start,n.value.end)});
  if(['CallExpression','NewExpression'].includes(n.type)){
   const c=n.callee,name=c?.type==='Identifier'?c.name:c?.type==='MemberExpression'&&!c.computed?c.property.name:undefined;
   if(['fetch','Request','XMLHttpRequest','sendBeacon','Worker','importScripts','transport','json','post','send','open'].includes(name))calls.push({at:n.start,kind:n.type,name,callee:text.slice(c.start,c.end),source:text.slice(n.start,n.end)});
  }
  for(const [k,v]of Object.entries(n))if(!['parent','comments','tokens'].includes(k)){if(Array.isArray(v))for(const x of v)visit(x);else if(v&&typeof v==='object')visit(v);}
 }visit(ast);return {edges,calls,assets:[...new Set(assets)],keepalive};
}
export function auditHostIssuers(manifest,{read=p=>readFileSync(p),list=p=>readdirSync(p)}={}){
 assert.equal(manifest.kind,'PINNED-APPLICATION-ISSUERS-280');const pins=manifest.pins;assert(pins.length>0);assert.equal(new Set(pins.map(f=>f.path)).size,pins.length);
 for(const f of pins){const b=read(f.path);assert.equal(b.length,f.bytes,'Issuer input length '+f.path);assert.equal(digest(b),f.sha256,'Issuer input changed '+f.path);}
 assert.deepEqual(list('dist/app/assets').sort(),manifest.assetFiles,'Complete emitted asset set');
 const documentEdges=[...read('dist/app/index.html').toString().matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(Boolean),cssEdges=[...read('dist/app/assets/index-CKeqbJD0.css').toString().matchAll(/url\(([^)]+)\)/g)].map(m=>m[1]);assert.deepEqual(documentEdges,manifest.documentEdges);assert.deepEqual(cssEdges,manifest.cssEdges);for(const edge of [...documentEdges,...cssEdges])assert(pins.some(p=>p.path==='dist/app'+edge),'Closed HTML/CSS asset');
 const maps=new Map(manifest.modules.map(m=>[m.path,m]));for(const m of maps.values()){
  const found=syntaxInventory(m.path,read(m.path).toString());assert.deepEqual(found,m.syntax,'Full module/injection syntax inventory');
  for(const edge of found.edges)if(m.path.startsWith('dist/app/')){assert(edge.value.startsWith('.'),'Local emitted module edge');assert(maps.has(posix.normalize(posix.join(posix.dirname(m.path),edge.value))),'Closed emitted dynamic/static edge');}
  for(const asset of found.assets){if(m.path==='tests/editor/completion/host-final-issuers.mjs'){assert.deepEqual(found.assets,manifest.nodeOnlyMetadataAssets);continue;}if(m.path==='tests/editor/original-font-reader.ts'&&asset==='/assets/'){assert.deepEqual(manifest.computedAssetPrefixes,[{path:m.path,prefix:asset,source:'sealedBrowserFonts exact profile hash and unique emitted font basename'}]);assert(manifest.pins.filter(p=>/dist\/app\/assets\/Noto.*\.(ttf|otf)$/.test(p.path)).length===4);}else assert(pins.some(p=>p.path==='dist/app/'+asset.replace(/^\//,'')),'Closed emitted binary/font/worker asset '+m.path+' '+asset);}
 }
 assert.equal(manifest.browserBodyIssuers.length,4);assert.deepEqual(manifest.browserBodyIssuers.map(x=>x.kind),['session-json','application-transport','recovery-release','private-native-beacon']);
 assert(manifest.browserBodyIssuers.slice(0,3).every(x=>x.keepalive===false&&x.telemetryCharge===false));assert(manifest.browserBodyIssuers[3].keepalive===true&&manifest.browserBodyIssuers[3].maximum===32768);
 assert.equal(manifest.unknownIssuers.length,0);assert.equal(manifest.workerFallbacks.length,5);assert(manifest.workerFallbacks.every(x=>x.method==='GET'&&x.body===null&&x.keepalive===false));
 return {manifestSHA256:digest(JSON.stringify(manifest)),files:pins.length,modules:maps.size,bodyIssuers:manifest.browserBodyIssuers,workerFallbacks:manifest.workerFallbacks,scope:'Pinned source-derived issuer contract; live routing/CSP/charge capability remains unproved'};
}
