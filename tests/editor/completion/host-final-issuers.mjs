import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {isAbsolute,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {syntaxInventory} from './issuer-syntax.mjs';
export {syntaxInventory} from './issuer-syntax.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
import {classifyIssuers,NETWORK_BOUNDARIES} from './issuer-classification.mjs';
import {emittedClosure} from './issuer-closure.mjs';
import {auditApplicationIdentity,loadApplicationIdentity} from './application-identity.mjs';
export function loadHostIssuers({env=process.env,read=readFileSync}={}){
 const path=env.COMPLETION_ISSUER_MANIFEST;if(path!==undefined)assert(typeof path==='string'&&isAbsolute(path),'Explicit absolute completion issuer manifest');
 return JSON.parse(read(path??new URL('./host-final-issuers.json',import.meta.url)));
}
export function auditHostIssuers(manifest,{read=p=>readFileSync(p),list=p=>readdirSync(p),applicationIdentity=loadApplicationIdentity()}={}){
 assert.equal(manifest.kind,'SOURCE-BOUND-APPLICATION-ISSUERS-1');const pins=manifest.pins;assert(pins.length>0);assert.equal(new Set(pins.map(f=>f.path)).size,pins.length);
 for(const f of pins){const b=read(f.path);assert.equal(b.length,f.bytes,'Issuer input length '+f.path);assert.equal(digest(b),f.sha256,'Issuer input changed '+f.path);}
 assert.deepEqual(list('dist/app/assets').sort(),manifest.assetFiles,'Complete emitted asset set');
 for(const name of manifest.assetFiles)assert(pins.some(pin=>pin.path==='dist/app/assets/'+name),'Every emitted asset is pinned');
 assert.deepEqual(manifest.modules.map(module=>module.path).sort(),pins.filter(pin=>/\.(js|mjs|ts)$/.test(pin.path)).map(pin=>pin.path).sort(),'Every pinned module is inventoried exactly once');
 const closure=emittedClosure({read,pins});assert.deepEqual(closure.documentEdges,manifest.documentEdges);assert.deepEqual(closure.cssEdges,manifest.cssEdges);assert.deepEqual(closure.css,manifest.closure.css);assert.equal(closure.entryPath,manifest.closure.entryPath);
 const identity=auditApplicationIdentity(applicationIdentity,{read});assert.equal(manifest.applicationIdentitySHA256,digest(JSON.stringify(applicationIdentity)));
 for(const [path,sha256]of Object.entries(NETWORK_BOUNDARIES))assert.equal(digest(read(path)),sha256,'Independently reviewed network boundary '+path);
 const maps=new Map(manifest.modules.map(m=>[m.path,m]));for(const m of maps.values()){
  const found=syntaxInventory(m.path,read(m.path).toString());assert.deepEqual(found,m.syntax,'Full module/injection syntax inventory');
  for(const edge of found.edges)if(m.path.startsWith('dist/app/')){assert(edge.value.startsWith('.'),'Local emitted module edge');assert(maps.has(posix.normalize(posix.join(posix.dirname(m.path),edge.value))),'Closed emitted dynamic/static edge');}
  for(const asset of found.assets){if(m.path==='tests/editor/completion/host-final-issuers.mjs'){assert.deepEqual(found.assets,manifest.nodeOnlyMetadataAssets);continue;}if(m.path==='tests/editor/original-font-reader.ts'&&asset==='/assets/'){assert.deepEqual(manifest.computedAssetPrefixes,[{path:m.path,prefix:asset,source:'sealedBrowserFonts exact profile hash and unique emitted font basename'}]);assert(manifest.pins.filter(p=>/dist\/app\/assets\/Noto.*\.(ttf|otf)$/.test(p.path)).length===4);}else assert(pins.some(p=>p.path==='dist/app/'+asset.replace(/^\//,'')),'Closed emitted binary/font/worker asset '+m.path+' '+asset);}
 }
 const network=classifyIssuers(manifest.modules,{read,workerPath:'dist/app'+applicationIdentity.expected.workerPath,entryPath:closure.entryPath});for(const key of ['directBrowserNetworking','classifiedNetworking','workerFallbacks'])assert.deepEqual(network[key],manifest[key],'Recomputed issuer classifications '+key);
 assert.equal(manifest.browserBodyIssuers.length,4);assert.deepEqual(manifest.browserBodyIssuers.map(x=>x.kind),['session-json','application-transport','recovery-release','private-native-beacon']);
 assert(manifest.browserBodyIssuers.slice(0,3).every(x=>x.keepalive===false&&x.telemetryCharge===false));assert(manifest.browserBodyIssuers[3].keepalive===true&&manifest.browserBodyIssuers[3].maximum===32768);
 assert.equal(manifest.unknownIssuers.length,0);assert.equal(manifest.workerFallbacks.length,5);assert(manifest.workerFallbacks.every(x=>x.method==='GET'&&x.body===null&&x.keepalive===false));
 return {applicationIdentity:identity,manifestSHA256:digest(JSON.stringify(manifest)),files:pins.length,modules:maps.size,bodyIssuers:manifest.browserBodyIssuers,workerFallbacks:manifest.workerFallbacks,scope:'Pinned source-derived issuer contract; live routing/CSP/charge capability remains unproved'};
}
