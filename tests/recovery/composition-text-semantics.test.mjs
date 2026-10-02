// Source-only schema19 successor. These semantic fixtures do not fabricate or
// qualify a schema18 executable, rollback archive, migration, or restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {mkdir,readFile,writeFile,readdir,chmod} from 'node:fs/promises';
import {rootFor} from '../store/helpers.mjs';
import {assertEditorSemanticCompatibility} from '../../dist/local/server/storage/schema.js';
import {emptyComposition,serialize} from '../../dist/local/src/composition/core.js';
import {exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {newV45Draft} from '../../dist/local/src/request/family.js';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const bytes=value=>Buffer.from(JSON.stringify(value));
const ref=(value,mediaType='application/json')=>{const b=Buffer.isBuffer(value)?value:bytes(value);return {hash:hash(b),byteLength:String(b.length),mediaType};};
const unsupported=error=>error.code==='UNSUPPORTED_STORAGE';
function reviewedExport(){
 const c=emptyComposition(1024,1024,'source_for_schema19');c.scene='Exact reviewed scene';const p=serialize(c,[],{});
 c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:p.dependencies,boxes:p.boxes,prompt:ref(Buffer.from(p.prompt),'text/plain')};
 return {composition:c,...exportCompositionText(c,[],{})};
}
async function put(root,value,mediaType='application/json'){
 const b=Buffer.isBuffer(value)?value:bytes(value),r=ref(b,mediaType),path=join(root,'objects','sha256',r.hash.slice(7,9),r.hash.slice(7));await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,b,{mode:0o600});return r;
}
function dbFor(t,table='image_edit_reviews'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT`);return db;
}
const set=(db,value,table='image_edit_reviews')=>{db.prepare(`DELETE FROM ${table}`).run();db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('fixture',JSON.stringify(value));};

test('ordinary V45 remains readable at its established schema18 boundary',async t=>{
 const root=await rootFor(t),db=dbFor(t),ordinary=newV45Draft(ref(Buffer.from('Ordinary V45 text'),'text/plain'));set(db,ordinary);const before=db.prepare('SELECT json FROM image_edit_reviews').get().json;assert.doesNotThrow(()=>assertEditorSemanticCompatibility(db,root,18));assert.equal(db.prepare('SELECT json FROM image_edit_reviews').get().json,before);
});

test('inline Composition text review requires schema19 without rewriting its metadata',async t=>{
 const root=await rootFor(t),db=dbFor(t),exported=reviewedExport();set(db,exported.review);const before=db.prepare('SELECT json FROM image_edit_reviews').get().json;
 for(const version of [0,17,18])assert.throws(()=>assertEditorSemanticCompatibility(db,root,version),unsupported);
 assert.doesNotThrow(()=>assertEditorSemanticCompatibility(db,root,19));assert.equal(db.prepare('SELECT json FROM image_edit_reviews').get().json,before);
});

test('typed retained Composition text projection is read through its wrapper and cannot be mislabeled18',async t=>{
 const root=await rootFor(t),db=dbFor(t),projection=await put(root,reviewedExport().review),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,prompt:{mode:'composition-text',projection}});set(db,{kind:'request-text-treatment-1',plan});
 assert.throws(()=>assertEditorSemanticCompatibility(db,root,18),unsupported);assert.doesNotThrow(()=>assertEditorSemanticCompatibility(db,root,19));
 const path=join(root,'objects','sha256',projection.hash.slice(7,9),projection.hash.slice(7));assert.equal(hash(await readFile(path)),projection.hash);
});

test('a caption projection cannot occupy the Composition text typed edge',async t=>{
 const root=await rootFor(t),db=dbFor(t),projection=await put(root,reviewedExport().review.sourceProjection),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,prompt:{mode:'composition-text',projection}});set(db,{kind:'request-text-treatment-1',plan});assert.throws(()=>assertEditorSemanticCompatibility(db,root,19),unsupported);
});

test('future Composition text serializers refuse even within schema19',async t=>{
 const root=await rootFor(t),db=dbFor(t),future={...reviewedExport().review,serializer:'composition-text-2'};set(db,future);assert.throws(()=>assertEditorSemanticCompatibility(db,root,19),unsupported);
 const projection=await put(root,future),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,prompt:{mode:'composition-text',projection}});set(db,{kind:'request-text-treatment-1',plan});assert.throws(()=>assertEditorSemanticCompatibility(db,root,19),unsupported);
});

test('Composition text marker words and unattached caption bytes remain authored content',async t=>{
 const root=await rootFor(t),db=dbFor(t,'assets'),blob=await put(root,reviewedExport().review,'text/plain');set(db,{id:'caption_asset',purpose:'caption',blob,name:'composition-text-1 composition-text-2 request-text-treatment-1'},'assets');assert.doesNotThrow(()=>assertEditorSemanticCompatibility(db,root,18));
});

test('frozen SaveCopy feature12 and feature13 captures require schema19 and preserve their exact SQLite source during inspection',async t=>{
 const root=await rootFor(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE portable_preparations(id TEXT PRIMARY KEY,frozen TEXT NOT NULL) STRICT');
 for(const feature of [10,11,12,13,14]){
  const id='capture_'+feature,directory=join(root,'portable',id),path=join(directory,'capture.sqlite');await mkdir(directory,{recursive:true,mode:0o700});const capture=new DatabaseSync(path);
  try{capture.exec('CREATE TABLE portable_features(version INTEGER PRIMARY KEY) STRICT');capture.prepare('INSERT INTO portable_features VALUES (?)').run(feature);}finally{capture.close();}await chmod(path,0o600);
  const before=await readFile(path),names=(await readdir(directory)).sort(),frozen={captureVersion:2,capture:id,captureHash:hash(before),document:{id:'document_1',revision:'1',branchId:'branch_1',width:1,height:1,color:'sRGB',depth:8,orderedLayerIds:[],historyHead:'history_1',checkpoint:null,compositionVersion:null}};
  db.prepare('DELETE FROM portable_preparations').run();db.prepare('INSERT INTO portable_preparations VALUES (?,?)').run(id,JSON.stringify(frozen));
  for(const version of [18,19]){const inspect=()=>assertEditorSemanticCompatibility(db,root,version);if(feature>13||feature>=12&&version<19)assert.throws(inspect,unsupported);else assert.doesNotThrow(inspect);}
  assert.deepEqual(await readFile(path),before);assert.deepEqual((await readdir(directory)).sort(),names);assert.equal(db.prepare('SELECT frozen FROM portable_preparations').get().frozen,JSON.stringify(frozen));
 }
});
