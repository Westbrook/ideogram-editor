import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {request} from 'node:http';
import {setup,call,cookieFrom,readHeaders,pair} from '../protocol/helpers.mjs';
import {importRaster,terminal} from '../raster/helpers.mjs';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {document as validateDocument} from '../../dist/local/src/protocol/validate.js';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {ProtocolRoutes} from '../../dist/local/server/protocol.js';
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const rawRead=(origin,path,headers,cancel=false)=>new Promise((resolve,reject)=>{const req=request(new URL(path,origin),{headers},res=>{const chunks=[];res.on('data',b=>{if(cancel){req.destroy();resolve({status:res.statusCode,received:b.length});return;}chunks.push(b);});res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));res.on('error',e=>{if(!cancel)reject(e);});});req.on('error',e=>{if(!cancel)reject(e);});req.end();});

test('typed oversized document GET is exact, bounded and version coherent; metadata guard and content authority stay intact',async t=>{
 let now=Date.now(),counts;const handle=ProtocolRoutes.prototype.handle;
 ProtocolRoutes.prototype.handle=async function(...args){try{return await handle.apply(this,args);}finally{counts={content:this.content.size,leases:this.leases.size};}};t.after(()=>{ProtocolRoutes.prototype.handle=handle;});
 const f=await setup(t,{now:()=>now});await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');
 const ids=Array.from({length:100},(_,i)=>('layer_'+String(i).padStart(3,'0')+'_').padEnd(128,'x'));
 let revision='1';for(const [i,id] of ids.entries()){
  const body=i?{type:'DuplicateLayer',layerId:ids[0],layerVersion:'1',newLayerId:id,name:'Layer '+i,draft:null}:{type:'ImportAsset',assetId:asset.id,layerId:id,name:'Layer 0',draft:null};
  const r=await terminal(f,f.command({expectedDocumentRevision:revision,body}));assert.equal(r.json.receipt.status,'accepted');revision=r.json.receipt.documentRevision;
 }
 const db=new DatabaseSync(join(f.root,'metadata.sqlite')),original=db.prepare("SELECT json FROM documents WHERE id='document_1'").get().json;
 t.after(()=>{db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(original);db.close();});
 const base=JSON.parse(original);validateDocument(base);const initial=await f.read('/api/v1/documents/document_1');assert.equal(initial.status,200);assert.deepEqual(initial.json.projection.value,base);
 const envelope=n=>canonical({...initial.json,entityVersion:'9'.repeat(n),projection:{kind:'inline',value:{...base,revision:'9'.repeat(n)}}});
 const at=Math.floor((65536-Buffer.byteLength(envelope(1)))/2)+1;
 const threshold=[];for(const n of [at,at+1]){const v={...base,revision:'9'.repeat(n)};validateDocument(v);db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(canonical(v));const r=await f.read('/api/v1/documents/document_1');assert.equal(r.status,200);assert(Buffer.byteLength(r.text)<=65536);assert.equal(r.json.projection.kind,n===at?'inline':'content-ref');if(n!==at)assert.equal((await f.read(r.json.projection.content.url)).text,canonical(v));threshold.push({decimalLength:n,inlineBytes:Buffer.byteLength(envelope(n)),responseBytes:Buffer.byteLength(r.text),kind:r.json.projection.kind});}
 // Only the scalar revision is synthetic. All100 layers were accepted through
 // real public commands. This is a typed wire-boundary fixture, NOT a reachable
 // 53,000-digit revision, valid event history at that revision or volume campaign.
 const large={...base,revision:'9'.repeat(53000)};validateDocument(large);const bytes=Buffer.from(canonical(large));assert(bytes.length>65536);
 db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(bytes.toString());
 t.diagnostic(JSON.stringify({fixture:'publicly accepted100-layer document; synthetic53000-digit revision only',documentBytes:bytes.length,inlineEnvelopeBytes:Buffer.byteLength(canonical({...initial.json,entityVersion:large.revision,projection:{kind:'inline',value:large}})),sourceHashes:Object.fromEntries(await Promise.all(['server/protocol.ts','server/storage/recovery.ts','server/storage/objects.ts'].map(async p=>[p,digest(await readFile(p))])))}));
 const result=await f.read('/api/v1/documents/document_1');assert.equal(result.status,200,result.text);assert(Buffer.byteLength(result.text)<=65536);assert.equal(result.json.entityVersion,large.revision);assert.equal(result.json.highWater,initial.json.highWater);assert.equal(result.json.projection.kind,'content-ref');const content=result.json.projection.content;
 assert.equal(content.encoding,'lp1-json');assert.equal(content.recordCount,'1');assert.equal(content.blob.byteLength,String(bytes.length));assert.equal(content.blob.hash,digest(bytes));
 const fetched=await f.read(content.url);assert.equal(fetched.status,200);assert.equal(fetched.text,bytes.toString());assert.equal(fetched.headers.etag,'"'+content.blob.hash+'"');
 const range=await rawRead(f.server.origin,content.url,{...readHeaders(cookieFrom(f.paired)),Range:'bytes=5-45'});assert.equal(range.status,206);assert.equal(range.text,bytes.subarray(5,46).toString());assert.equal((await f.read(content.url,{Range:'bytes=999999999-'})).status,416);
 const objectPath=join(f.root,'objects','sha256',content.blob.hash.slice(7,9),content.blob.hash.slice(7));const retained=await readFile(objectPath);try{const corrupted=Buffer.from(retained);corrupted[0]^=1;await writeFile(objectPath,corrupted);assert.equal((await f.read(content.url)).status,503);}finally{await writeFile(objectPath,retained);}
 const canceled=await rawRead(f.server.origin,content.url,readHeaders(cookieFrom(f.paired)),true);assert(canceled.received>0);assert.equal((await f.read(content.url)).text,bytes.toString());
 const before={...counts},pins=db.prepare('SELECT count(*) n FROM roots').get().n;
 // No giant header is sent: exercise HEAD with canonical >2^53 revision on
 // the same accepted layer projection after the large content read.
 db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(canonical({...base,revision:'9007199254740995'}));
 for(let i=0;i<140;i++){const r=await call(f.server.origin,'/api/v1/documents/document_1',{method:'HEAD',headers:readHeaders(cookieFrom(f.paired))});assert.equal(r.status,200);assert.equal(r.headers['x-app-entity-version'],'9007199254740995');assert.equal(r.text,'');assert.deepEqual(counts,before);assert.equal(db.prepare('SELECT count(*) n FROM roots').get().n,pins);}
 // The old reference remains exactly the captured version after a later source
 // revision; ordinary GET returns the new version without a mixed envelope.
 const newer=await f.read('/api/v1/documents/document_1');assert.equal(newer.json.entityVersion,'9007199254740995');assert.equal(newer.json.projection.value.revision,newer.json.entityVersion);assert.equal((await f.read(content.url)).text,bytes.toString());
 const unrelated=await pair(f.server);assert.equal((await call(f.server.origin,content.url,{headers:readHeaders(cookieFrom(unrelated))})).status,403);assert.equal((await call(f.server.origin,content.url,{headers:{'X-App-Client':'LP-1','Sec-Fetch-Site':'same-origin'}})).status,401);
 assert.equal((await f.read(content.url,{Origin:'https://foreign.invalid'})).status,403);
 // Existing128 live-content limit is enforced before creating another file or
 // handle; expiry then permits a healthy fresh read. No row/history is pruned.
 db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(bytes.toString());let pressure;
 for(let i=0;i<130;i++){pressure=await f.read('/api/v1/documents/document_1');if(pressure.status!==200)break;assert(counts.content<=128);}
 assert.equal(pressure.status,429);assert.equal(pressure.json.error.code,'LOCAL_BUSY');assert.equal(counts.content,128);
 // Existing protocol-content lifetime is bounded and independent of the source.
 now+=29*60*1000;await f.read('/api/v1/session');now+=2*60*1000;const expired=await f.read(content.url);assert.equal(expired.status,404);assert.equal(expired.json.error.code,'NOT_FOUND');
 const recovered=await f.read('/api/v1/documents/document_1');assert.equal(recovered.status,200);assert.equal(counts.content,1);assert.equal((await f.read(recovered.json.projection.content.url)).text,bytes.toString());
 // Generic metadata remains capped. The new typed document path must not
 // bypass that guard for unrelated metadata or change its persisted format.
 const objects=new Objects(f.root,()=>{},()=>{});assert.throws(()=>objects.putMetadata(Buffer.alloc(65537)),e=>e.code==='PAYLOAD_TOO_LARGE');
 t.diagnostic(JSON.stringify({threshold,responseBytes:Buffer.byteLength(result.text),firstContent:before,headCount:140,pins,latest:counts,limits:'Read-boundary correctness only; no full history at synthetic revision or large-envelope qualification.'}));
});
