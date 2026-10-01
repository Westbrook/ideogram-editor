import test from 'node:test';
import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Texts} from '../../dist/local/server/storage/text.js';
import {Rasters} from '../../dist/local/server/storage/raster.js';
const auth={clientId:'client_1',sessionHash:'session_hash',now:Date.now(),expires:Date.now()+60000};
const realm='11111111-1111-4111-8111-111111111111';
async function owners(t){
 const root=ownTestRoot(await mkdtemp(join(await realpath(tmpdir()),'text-phase-'))),db=new DatabaseSync(join(root,'owners.sqlite'));
 db.exec('CREATE TABLE text_admissions(id TEXT PRIMARY KEY,client_id TEXT,session_hash TEXT,epoch TEXT);CREATE TABLE assets(id TEXT,json TEXT);CREATE TABLE deletion_work(path TEXT PRIMARY KEY,document_id TEXT NOT NULL);CREATE TABLE roots(owner TEXT,hash TEXT)');
 let rasters;
 t.after(async()=>{try{await rasters?.close();}finally{db.close();}});
 const texts=new Texts(db,{}, {},'epoch');let diskReservations=0;
 rasters=new Rasters(db,{reserve:()=>{diskReservations++;},capacity:()=>{}},{},root,'epoch',()=>{},()=>{},()=>{},()=>{});
 texts.backendCPU=()=>rasters.reservedBytes;rasters.externalCPU=()=>texts.externalBytes()+texts.reservedCPU;
 const path=join(root,'input.png'),bytes=await readFile(resolve('tests/raster/fixtures/white.png')),ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length)};
 await writeFile(path,bytes,{mode:0o600});
 let serial=0;async function raster(){const directory=join(root,'job-'+serial++);await mkdir(directory,{mode:0o700});return rasters.validatePortable(path,'image/png',ref,directory,'portable:phase_'+serial,()=>{});}
 return {texts,rasters,db,raster,diskReservations:()=>diskReservations};
}
test('text admission books current owners and preserves the old generation on capacity refusal',async t=>{
 const {texts,db}=await owners(t),id=n=>realm+'_'+n+'_70000000';
 texts.admission(id(1),auth);texts.admission(id(2),auth);
 const good=texts.observations.at(-1);assert.equal(good.combined,good.processRSS+good.browserBytes+good.backendBytes);assert.equal(good.browserBytes,134217728);assert(good.admitted);
 texts.backendCPU=()=>536870912;
 assert.throws(()=>texts.admission(id(3),auth),{code:'CAPACITY'});const bad=texts.observations.at(-1);assert(!bad.admitted);assert.equal(bad.backendBytes,536870912);assert(bad.combined>bad.limit);
 assert.deepEqual(db.prepare('SELECT id FROM text_admissions').all().map(r=>r.id),[id(2)]);
 texts.backendCPU=()=>0;texts.admission(id(3),auth);assert.equal(db.prepare('SELECT id FROM text_admissions').get().id,id(3));
 t.diagnostic(JSON.stringify({positive:good,refusal:bad,next:texts.observations.at(-1),reservationControl:'synthetic active backend booking, no allocated-memory or RSS peak claim'}));
});
test('real CP-1 worker rechecks owners at plan escalation without duplicating its own preflight',{timeout:10000},async t=>{
 const {texts,rasters,raster,diskReservations}=await owners(t);
 const first=raster(),outcome=first.then(value=>({value}),error=>({error}));
 // Let directory creation finish and the actual worker start before admitting
 // a browser owner. The promise exposes no native plan until its next message.
 while(!rasters.reservedBytes){const settled=await Promise.race([outcome,new Promise(r=>setImmediate(()=>r(null)))]);if(settled)throw settled.error??Error('Worker finished before reservation was observed');}
 assert.equal(rasters.reservedBytes,134217728);texts.admission(realm+'_1_70000000',auth);await first;
 const allowed=rasters.observations.find(x=>x.phase==='resource-admission');assert(allowed.admitted);assert.equal(allowed.externalCPU,134217728);assert.equal(allowed.replacedCPU,134217728);assert.equal(allowed.combinedReservedBytes,allowed.processRSS+allowed.externalCPU+allowed.plan.cpuBytes);assert.equal(rasters.reservedBytes,0);assert.equal(diskReservations(),1);
 texts.releaseAdmission(realm+'_1_70000000',auth);
 let calls=0;rasters.externalCPU=()=>++calls===1?0:536870912;
 await assert.rejects(raster(),{code:'CAPACITY'});
 const refused=rasters.observations.at(-1);assert.equal(refused.externalCPU,536870912);assert(!refused.admitted);assert.equal(diskReservations(),1);assert.equal(rasters.reservedBytes,0);
 t.diagnostic(JSON.stringify({allowed,refused,liveOverlap:'browser admission during actual CP-1 preflight',refusalControl:'synthetic external reservation introduced after preflight; no physical allocation claim'}));
});
