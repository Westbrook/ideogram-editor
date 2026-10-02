// SOURCE-ONLY: preserves schema18 boundaries while checking the schema19 successor. Not executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,readdir,chmod,realpath,rm,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {rootFor} from '../store/helpers.mjs';
import {rasterManifest} from '../../dist/local/src/protocol/validate.js';
import {projectionEntity} from '../../dist/local/src/protocol/projection-schema.js';
import {v45PreparedBlack} from '../../dist/local/src/protocol/v45-inputs.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {COMPOSITION_TEXT_SCHEMA19_CAPABILITY_SEAL,COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH,assertCompositionTextSchema19Receipt} from '../../dist/local/server/storage/composition-text-schema.js';
import {editorSQLitePreflight,assertEditorStorageCompatibility,assertEditorSchema18Ready,EDITOR_SCHEMA18_CAPABILITY_SEAL,assertEditorSchema18Receipt,assertEditorSemanticCompatibility,EDITOR_SCHEMA18_CAPABILITY_MANIFEST,EDITOR_SCHEMA18_CAPABILITY_HASH} from '../../dist/local/server/storage/schema.js';
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const ref=(bytes,mediaType='application/json')=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const metadata=value=>Buffer.from(JSON.stringify(value));
const receipt=()=>({from:17,to:18,capability:'editor-contracts-18-v1',capabilityManifest:structuredClone(EDITOR_SCHEMA18_CAPABILITY_MANIFEST),capabilityHash:EDITOR_SCHEMA18_CAPABILITY_HASH});
async function put(root,value,mediaType='application/json'){
 const bytes=Buffer.isBuffer(value)?value:metadata(value),r=ref(bytes,mediaType),path=join(root,'objects','sha256',r.hash.slice(7,9),r.hash.slice(7));
 await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});return r;
}
const doc=(image,extra={})=>({id:'document_1',revision:'1',branchId:'branch_1',width:1,height:1,color:'sRGB',depth:8,orderedLayerIds:[],historyHead:'history_1',checkpoint:null,compositionVersion:null,...(image?{image,redo:null}:{}),...extra});
const image=state=>({state,semanticDigest:hash(metadata({})),compositeAssetId:null});
function dbFor(t,table='documents',column='json'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,${column} TEXT NOT NULL) STRICT`);return db;
}
function add(db,table,value,column='json',id='entry_1'){db.prepare(`INSERT INTO ${table}(id,${column}) VALUES (?,?)`).run(id,JSON.stringify(value));}
function inspect(db,root,version=17){return assertEditorSemanticCompatibility(db,root,version);}

test('exact sorted capability set binds storage18, projection9 and separate PF10/PF11',()=>{
 const r=receipt();assert.doesNotThrow(()=>assertEditorSchema18Receipt(r));assert.equal(r.capabilityManifest.storageVersion,18);assert.equal(r.capabilityManifest.projectionSchema,9);assert.equal(r.capabilityManifest.assetProjectionSchema,3);
 assert.equal(r.capabilityManifest.completePortableFormat,10);assert.equal(r.capabilityManifest.recoveryPortableFormat,11);
 assert.deepEqual(r.capabilityManifest.capabilities,[...new Set(r.capabilityManifest.capabilities)].sort());
});
for(const change of [r=>delete r.capabilityManifest,r=>r.capability='request-family-v45-v1',r=>r.capabilityManifest.capabilities.pop(),r=>r.capabilityManifest.capabilities.push('future-feature-v1'),r=>r.capabilityManifest.capabilities.push(r.capabilityManifest.capabilities[0]),r=>r.capabilityManifest.capabilities.reverse(),r=>r.capabilityManifest.projectionSchema=10,r=>r.capabilityManifest.recoveryPortableFormat=10,r=>r.capabilityHash=hash(Buffer.from('different'))])test('mismatched capability receipt refuses without normalization '+change.toString(),()=>{
 const r=receipt();change(r);assert.throws(()=>assertEditorSchema18Receipt(r),{code:'UNSUPPORTED_STORAGE'});
});

test('version18 mismatched receipt refuses before writable open, WAL, schema repair or epoch',async t=>{
 const root=await rootFor(t),path=join(root,'metadata.sqlite');const db=new DatabaseSync(path);db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,receipt TEXT NOT NULL) STRICT;CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;INSERT INTO meta VALUES('writerEpoch','73');PRAGMA user_version=18");
 const r=receipt();r.capabilityManifest.capabilities.push('unknown-reader-v1');db.prepare('INSERT INTO schema_migrations VALUES (18,?)').run(JSON.stringify(r));db.close();await chmod(path,0o600);
 const bytes=await readFile(path),names=await readdir(root);assert.throws(()=>new StoreDatabase(root,()=>{}),{code:'UNSUPPORTED_STORAGE'});
 assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readdir(root),names);const reader=new DatabaseSync(path,{readOnly:true});try{assert.equal(reader.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value,'73');}finally{reader.close();}
});

const markers=[
 {type:'CreateDocument'},doc(null,{metadata:{schemaVersion:1,name:'Untitled',creationBackground:{kind:'transparent'}}}),
 {kind:'solid-background-v1'},{type:'SaveRecoveryCopy'},{kind:'tp1-sanitized-recovery-v1'},
 {type:'CreateTextFromReturnedDescription'},{kind:'returned-description-review-1'},{kind:'created-text-description-1'},
 {kind:'returned-description-selection-1'},{kind:'text-draft-3',schemaVersion:3},
 {kind:'request-review-text-1'},{kind:'text-treatment-review-intent-1'},{kind:'request-text-treatment-1'},
 {kind:'text-treatment-plan-1'},{kind:'text-treatment-adoption-decision-1'},
 {type:'ReorderLocalQueue'},{type:'EditQueuedJob'},{kind:'local-queue-reorder-1'},{type:'QueueOrderInitialized'},
 {id:'job_1',review:{},attempts:[],local:'accepted-local-queue',ownerClientId:null,order:{origin:'legacy-id-order'}},
 {type:'InspectRasterOriginal'},{type:'PrepareRaster',importPlan:{}},{kind:'raster-import-inspection-v1'},{kind:'decoded-derived-v1'},
 {inputs:{encodedRebuild:{kind:'encoded-adoption-inputs-1'}}},{kind:'request-review-v45-1'},
];
for(const [table,column]of [['documents','json'],['checkpoints','json'],['commands','receipt'],['history_preparations','frozen'],['portable_preparations','frozen']])test('pre18 semantic fence covers '+table+'.'+column,async t=>{
 const root=await rootFor(t),db=dbFor(t,table,column);for(const [i,marker]of markers.entries()){
  add(db,table,marker,column,'entry_'+i);assert.throws(()=>inspect(db,root),{code:'UNSUPPORTED_STORAGE'});db.prepare(`DELETE FROM ${table}`).run();
 }
});

test('marker words in opaque captions and ordinary strings remain content',async t=>{
 const root=await rootFor(t),r=await put(root,{kind:'request-draft-v45-1'}),db=dbFor(t,'assets');
 add(db,'assets',{id:'caption_1',purpose:'caption',blob:r,name:'CreateDocument request-review-text-1 decoded-derived-v1'},undefined,'caption_1');
 assert.doesNotThrow(()=>inspect(db,root));
 db.exec('CREATE TABLE ui_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
 add(db,'ui_receipts',{draft:{kind:'request',assetId:'caption_1',generation:'1',documentId:null,targetLayerId:null,expectedDocumentRevision:null,status:'saved'}});assert.throws(()=>inspect(db,root),{code:'UNSUPPORTED_STORAGE'});
});

test('released historical raster metadata may be absent; live owned metadata may not',async t=>{
 const root=await rootFor(t),missing=ref(Buffer.from('released')),db=dbFor(t,'assets');
 add(db,'assets',{id:'asset_1',raster:{manifest:missing}});assert.doesNotThrow(()=>inspect(db,root));
 db.exec('CREATE TABLE roots(owner TEXT,hash TEXT,media_type TEXT) STRICT');db.prepare('INSERT INTO roots VALUES (?,?,?)').run('document:live',missing.hash,missing.mediaType);
 assert.throws(()=>inspect(db,root),{code:'MISSING_OBJECT'});
});

test('live saved draft requires its asset even if ownership index is damaged',async t=>{
 const root=await rootFor(t),db=dbFor(t,'documents');add(db,'documents',doc(),undefined,'document_1');
 db.exec('CREATE TABLE ui_checkpoints(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');add(db,'ui_checkpoints',{drafts:[{kind:'request',documentId:'document_1',assetId:'missing_draft'}]});
 assert.throws(()=>inspect(db,root),{code:'MISSING_OBJECT'});
 db.prepare('DELETE FROM ui_checkpoints').run();db.exec('CREATE TABLE ui_events(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');add(db,'ui_events',{draft:{kind:'request',documentId:'deleted_document',assetId:'missing_draft'}});
 assert.doesNotThrow(()=>inspect(db,root));
});

test('composition typed edge retains its established 1MiB budget without raising raster/control limits',async t=>{
 const root=await rootFor(t),composition=await put(root,{kind:'composition-version-1',schemaVersion:1,authoredText:'x'.repeat(70000)}),state=await put(root,{schemaVersion:1,width:1,height:1,layers:[],composition:{value:composition}}),db=dbFor(t);
 add(db,'documents',doc(image(state)),undefined,'document_1');assert.doesNotThrow(()=>inspect(db,root));
 const oversized=await put(root,{format:'straight-srgb-rgba8',schemaVersion:1,plan:{kind:'decoded-native'},padding:'x'.repeat(70000)});db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');add(db,'assets',{id:'asset_1',raster:{manifest:oversized}});
 assert.throws(()=>inspect(db,root),{code:'CORRUPT_OBJECT'});
});

test('typed text treatment plan reads beyond64KiB through its512KiB edge only',async t=>{
 const root=await rootFor(t),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,authoredText:'x'.repeat(70000)}),db=dbFor(t,'image_edit_reviews');
 add(db,'image_edit_reviews',{kind:'request-text-treatment-1',plan,planHash:hash(Buffer.from('plan'))});assert.doesNotThrow(()=>inspect(db,root,18));assert.throws(()=>inspect(db,root,17),{code:'UNSUPPORTED_STORAGE'});
 const future=await put(root,{kind:'text-treatment-plan-2',schemaVersion:2,authoredText:'x'.repeat(70000)});db.prepare('DELETE FROM image_edit_reviews').run();add(db,'image_edit_reviews',{kind:'request-text-treatment-1',plan:future});assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
});

for(const kind of ['candidate-text-treatment-1','candidate-text-treatment-preview-1']){
 test(kind+' routes its nested request envelope to the bounded treatment plan without source writes',async t=>{
  const root=await rootFor(t),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,authoredText:'x'.repeat(70000)}),db=dbFor(t,'image_edit_reviews');
  add(db,'image_edit_reviews',{kind,plan:{kind:'request-text-treatment-1',plan,planHash:hash(Buffer.from('plan'))}});
  const path=join(root,'objects','sha256',plan.hash.slice(7,9),plan.hash.slice(7)),bytes=await readFile(path),row=db.prepare('SELECT json FROM image_edit_reviews').get().json,names=await readdir(root),scratch=await scratchNames();
  assert.ok(Number(plan.byteLength)>65536);for(const version of [18,19])assert.doesNotThrow(()=>inspect(db,root,version));
  assert.throws(()=>inspect(db,root,17),{code:'UNSUPPORTED_STORAGE'});
  assert.equal(db.prepare('SELECT json FROM image_edit_reviews').get().json,row);assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readdir(root),names);assert.deepEqual(await scratchNames(),scratch);
 });
 test(kind+' refuses malformed, future and oversized nested treatment references',async t=>{
  const root=await rootFor(t),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1}),future=await put(root,{kind:'text-treatment-plan-2',schemaVersion:2}),db=dbFor(t,'image_edit_reviews');
  const request=ref=>({kind:'request-text-treatment-1',plan:ref,planHash:hash(Buffer.from('plan'))});
  const cases=[['missing envelope',undefined,'CORRUPT_OBJECT'],['flattened reference',plan,'CORRUPT_OBJECT'],['future envelope',{...request(plan),kind:'request-text-treatment-2'},'UNSUPPORTED_STORAGE'],['missing reference',request(undefined),'CORRUPT_OBJECT'],['wrong media',request({...plan,mediaType:'text/plain'}),'CORRUPT_OBJECT'],['over512KiB',request({...plan,byteLength:'524289'}),'CORRUPT_OBJECT'],['future plan',request(future),'UNSUPPORTED_STORAGE']];
  const path=join(root,'objects','sha256',plan.hash.slice(7,9),plan.hash.slice(7)),bytes=await readFile(path),names=await readdir(root),scratch=await scratchNames();
  for(const [name,envelope,code]of cases){
   db.prepare('DELETE FROM image_edit_reviews').run();add(db,'image_edit_reviews',{kind,plan:envelope});const row=db.prepare('SELECT json FROM image_edit_reviews').get().json;
   assert.throws(()=>inspect(db,root,19),{code},name);assert.equal(db.prepare('SELECT json FROM image_edit_reviews').get().json,row,name);assert.deepEqual(await readFile(path),bytes,name);assert.deepEqual(await readdir(root),names,name);assert.deepEqual(await scratchNames(),scratch,name);
  }
 });
}

test('same hash entering generic metadata first still requires every later typed discriminator',async t=>{
 const root=await rootFor(t),r=await put(root,{}),db=dbFor(t,'assets');
 add(db,'assets',{id:'asset_1',retainedMetadata:r,preparedInputs:{manifest:r}});assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
});

async function snapshot(root,projectionSchema,value){
 const entity=Buffer.from(JSON.stringify(value)).toString('base64'),bytes=Buffer.from(JSON.stringify({kind:'header',projectionSchema})+'\n'+JSON.stringify({kind:'projection-part',entityType:'document',entityId:'document_1',partIndex:0,partCount:1,utf8Base64:entity})+'\n');
 return {id:'snapshot_1',seq:'1',content:{encoding:'lp1-snapshot-jsonl',blob:await put(root,bytes,'application/x-ndjson')}};
}
for(const projectionSchema of [8,9,10])test('snapshot projection '+projectionSchema+' enforces document metadata labeling before replay',async t=>{
 const root=await rootFor(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE snapshots(descriptor TEXT NOT NULL) STRICT');
 const descriptor=await snapshot(root,projectionSchema,doc(null,{metadata:{schemaVersion:1,name:'new',creationBackground:{kind:'transparent'}}}));db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(descriptor));
 if(projectionSchema===9)assert.doesNotThrow(()=>inspect(db,root,18));else assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
 assert.throws(()=>inspect(db,root,17),{code:'UNSUPPORTED_STORAGE'});
});

for(const kind of ['raster-import-inspection-v2','request-draft-v46-1','request-text-treatment-2','decoded-derived-v2'])test('unknown future typed discriminator '+kind+' fails even with matching18 semantics',async t=>{
 const root=await rootFor(t),db=dbFor(t,'image_edit_reviews');add(db,'image_edit_reviews',{kind});assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
});

for(const kind of ['text-draft-1','text-draft-2'])test('legacy '+kind+' remains readable',async t=>{
 const root=await rootFor(t),blob=await put(root,{kind,schemaVersion:kind.endsWith('1')?1:2},'text/plain'),db=dbFor(t,'assets');add(db,'assets',{id:'draft_asset',purpose:'text',blob},undefined,'draft_asset');
 db.exec('CREATE TABLE ui_events(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');add(db,'ui_events',{draft:{kind:'text',assetId:'draft_asset',generation:'1',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',status:'saved-unapplied'}});assert.doesNotThrow(()=>inspect(db,root));
});

test('native text ImageLayer source is metadata; its raster asset is never parsed as a UI text draft',async t=>{
 const root=await rootFor(t),source=await put(root,{text:{textUtf8:ref(Buffer.from('literal'),'text/plain')},render:{}}),state=await put(root,{schemaVersion:1,width:1,height:1,layers:[{id:'layer_1',kind:'text',assetId:'render_1',source}]}),db=dbFor(t);
 add(db,'documents',doc(image(state)),undefined,'document_1');db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');add(db,'assets',{id:'render_1',blob:ref(Buffer.from('PNG'),'image/png')},undefined,'render_1');assert.doesNotThrow(()=>inspect(db,root));
});

async function capture(root,rows){
 const id='capture_1',directory=join(root,'portable',id),path=join(directory,'capture.sqlite');await mkdir(directory,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path);db.exec('CREATE TABLE entities(kind TEXT,id TEXT,json TEXT) STRICT;CREATE TABLE events(seq TEXT,json TEXT) STRICT;CREATE TABLE transactions(id TEXT,json TEXT) STRICT;CREATE TABLE payloads(hash TEXT,json TEXT) STRICT;CREATE TABLE portable_features(version INTEGER PRIMARY KEY) STRICT');
 for(const value of rows)db.prepare('INSERT INTO entities VALUES (?,?,?)').run('document','document_1',JSON.stringify(value));db.close();await chmod(path,0o600);return {captureVersion:2,capture:id,captureHash:hash(await readFile(path)),document:doc()};
}
test('pending private capture spool is inspected read-only for frozen-only future observations',async t=>{
 const root=await rootFor(t),frozen=await capture(root,[doc(null,{metadata:{schemaVersion:1,name:'future',creationBackground:{kind:'transparent'}}})]),db=dbFor(t,'portable_preparations','frozen');add(db,'portable_preparations',frozen,'frozen');
 const path=join(root,'portable',frozen.capture,'capture.sqlite'),bytes=await readFile(path),names=await readdir(dirname(path));assert.throws(()=>inspect(db,root),{code:'UNSUPPORTED_STORAGE'});assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readdir(dirname(path)),names);
});

test('collected capture for a deleted document does not block old history recovery',async t=>{
 const root=await rootFor(t),db=dbFor(t,'portable_preparations','frozen');add(db,'portable_preparations',{captureVersion:2,capture:'collected_capture',captureHash:hash(Buffer.from('collected')),document:doc()},'frozen');assert.doesNotThrow(()=>inspect(db,root));
});


test('retained-text raster source edge keeps TextSource type distinct from RasterManifest',async t=>{
 const root=await rootFor(t),source=await put(root,{text:{textUtf8:ref(Buffer.from('literal'),'text/plain')},render:{}}),manifest=await put(root,{schemaVersion:1,format:'straight-srgb-rgba8',plan:{kind:'retained-text',source}}),db=dbFor(t,'assets');
 add(db,'assets',{id:'render_1',raster:{manifest}});assert.doesNotThrow(()=>inspect(db,root));
});

test('V45 prepared black mask metadata receives its own typed future-reader check',async t=>{
 const root=await rootFor(t),mask=await put(root,{schemaVersion:1,format:'straight-srgb-rgba8',plan:{kind:'v45-edit-mask-2'}}),raw=ref(Buffer.alloc(8),'application/x-ideogram-rgba8'),png=ref(Buffer.from('encoded-mask'),'image/png');
 const black={blob:png,pixels:raw,manifest:mask,pixelIdentity:hash(Buffer.from('mask-grid')),width:2,height:1,polarity:'black-edit',sourcePixels:raw,editPixels:1,keepPixels:1};assert.doesNotThrow(()=>v45PreparedBlack(black));
 const manifest=await put(root,{schemaVersion:1,format:'straight-srgb-rgba8',plan:{kind:'v45-edit-inputs-1',mask:black,references:[]}}),db=dbFor(t,'assets');
 add(db,'assets',{id:'asset_1',raster:{manifest}});assert.throws(()=>inspect(db,root,17),{code:'UNSUPPORTED_STORAGE'});assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
 // The known outer kind alone is permitted in18: removing only the future
 // child proves that the nested prepared-black manifest drives the refusal.
 const known=await put(root,{schemaVersion:1,format:'straight-srgb-rgba8',plan:{kind:'v45-edit-mask-v1'}}),parent=await put(root,{schemaVersion:1,format:'straight-srgb-rgba8',plan:{kind:'v45-edit-inputs-1',mask:{...black,manifest:known},references:[]}});db.prepare('DELETE FROM assets').run();add(db,'assets',{id:'asset_1',raster:{manifest:parent}});assert.doesNotThrow(()=>inspect(db,root,18));
});

test('treatment prompt projection has a typed512KiB bound and unknown serializers refuse',async t=>{
 const root=await rootFor(t),projection=await put(root,{serializer:'caption-json-1',metadata:'x'.repeat(70000)}),plan=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,prompt:{projection}}),db=dbFor(t,'image_edit_reviews');
 add(db,'image_edit_reviews',{kind:'request-text-treatment-1',plan});assert.doesNotThrow(()=>inspect(db,root,18));
 const future=await put(root,{serializer:'caption-json-2'}),changed=await put(root,{kind:'text-treatment-plan-1',schemaVersion:1,prompt:{projection:future}});db.prepare('DELETE FROM image_edit_reviews').run();add(db,'image_edit_reviews',{kind:'request-text-treatment-1',plan:changed});assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
});


async function scratchNames(){const parent=join(await realpath(tmpdir()),'ideogram-editor-schema-scans-'+process.getuid());try{return (await readdir(parent)).filter(name=>name.startsWith('scan-'+process.pid+'-')).sort();}catch(error){if(error.code==='ENOENT')return [];throw error;}}

test('retained ancestry beyond4096 metadata nodes stays readable with bounded disposable bookkeeping',async t=>{
 const root=await rootFor(t),raw=await put(root,Buffer.alloc(4),'application/x-ideogram-rgba8'),codec=hash(Buffer.from('codec')),value={schemaVersion:1,pipeline:'cp1-f64-triangle-area-v1/'+codec,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels:raw,tiles:[{x:0,y:0,width:1,height:1,hash:raw.hash}],dependencies:[],plan:{kind:'decoded-native',sourceAssetId:'source_1',codec,conversion:{encodedWidth:1,encodedHeight:1,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false}}};
 assert.doesNotThrow(()=>rasterManifest(value));const manifest=await put(root,value),db=dbFor(t,'assets');let previous=null;
 //4096 valid retention links plus their manifest exceed4096 typed refs while
 // preserving the existing per-retained-chain4096 validator contract.
 for(let i=0;i<4096;i++)previous=await put(root,{schemaVersion:1,kind:'retained-raster-metadata-1',manifest,previous});
 add(db,'assets',{id:'asset_1',retainedMetadata:previous});const before=await scratchNames();assert.doesNotThrow(()=>inspect(db,root,18));assert.deepEqual(await scratchNames(),before);
});

test('malicious self-reference cannot bypass byte proof and temporary state is cleaned on refusal',async t=>{
 const root=await rootFor(t),cycle={hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'},db=dbFor(t,'assets');let bytes;
 for(let i=0;i<4;i++){bytes=metadata({schemaVersion:1,kind:'retained-raster-metadata-1',manifest:cycle,previous:cycle});cycle.byteLength=String(bytes.length);}bytes=metadata({schemaVersion:1,kind:'retained-raster-metadata-1',manifest:cycle,previous:cycle});
 const path=join(root,'objects','sha256','00',cycle.hash.slice(7));await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});add(db,'assets',{id:'asset_1',retainedMetadata:cycle});
 const before=await scratchNames();assert.throws(()=>inspect(db,root,18),{code:'CORRUPT_OBJECT'});assert.deepEqual(await scratchNames(),before);
});

test('missing required reference cleans temporary state and never writes into owned root',async t=>{
 const root=await rootFor(t),missing=ref(Buffer.from('required')),db=dbFor(t,'documents');add(db,'documents',doc(image(missing)),undefined,'document_1');
 const before=await scratchNames(),names=await readdir(root);assert.throws(()=>inspect(db,root,18),{code:'MISSING_OBJECT'});assert.deepEqual(await scratchNames(),before);assert.deepEqual(await readdir(root),names);
});


test('environment-selected temporary directory cannot place scanner writes inside the owned root',async t=>{
 const root=await rootFor(t),db=dbFor(t,'assets'),prior={TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP},before=await readdir(root);
 try{process.env.TMPDIR=root;process.env.TMP=root;process.env.TEMP=root;assert.throws(()=>inspect(db,root,18),{code:'ROOT_UNSAFE'});assert.deepEqual(await readdir(root),before);}
 finally{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

// All SQLite execution below is authored fixture code only. Root owns the
// eventual pinned-toolchain run and its existing no-network preload.
async function rootBytes(root){const names=(await readdir(root)).sort(),values=[];for(const name of names){const path=join(root,name),s=await stat(path);values.push([name,s.mode,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.isFile()?await readFile(path):null]);}return values;}
async function crashedDatabase(t,root,mode){
 const fixture=join(root,'sqlite-preflight-crash-fixture.mjs'),path=join(root,'metadata.sqlite');
 await writeFile(fixture,`import {DatabaseSync} from 'node:sqlite';import {chmodSync,writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'',{flag:'wx',mode:0o600});const db=new DatabaseSync(process.argv[2]);db.exec("PRAGMA journal_mode=${mode};PRAGMA synchronous=FULL;PRAGMA wal_autocheckpoint=0;CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,receipt TEXT NOT NULL) STRICT;CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;INSERT INTO meta VALUES('writerEpoch','73');PRAGMA user_version=18;");db.prepare('INSERT INTO schema_migrations VALUES(18,?)').run(JSON.stringify({from:17,to:18,capability:'future'}));if('${mode}'==='DELETE'){db.exec('PRAGMA cache_size=1;BEGIN IMMEDIATE;UPDATE meta SET value=hex(zeroblob(8192))');}chmodSync(process.argv[2],0o600);process.send({ready:true});setInterval(()=>{},1000);`,{mode:0o600});
 const child=fork(fixture,[path],{execArgv:['--import',fileURLToPath(new URL('../store/no-network.mjs',import.meta.url))],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}});let exited=false;const exit=once(child,'exit').then(()=>{exited=true;});
 t.after(async()=>{if(!exited){child.kill('SIGKILL');await exit;}});await Promise.race([once(child,'message'),exit.then(()=>{throw new Error('SQLite fixture exited before ready');})]);child.kill('SIGKILL');await exit;await rm(fixture);
 return path;
}
for(const mode of ['WAL','DELETE'])test('crashed '+mode+' preflight refuses bad receipt without source side effects and cleans captured bytes',async t=>{
 const root=await rootFor(t),path=await crashedDatabase(t,root,mode);if(mode==='WAL'){assert.ok((await stat(path+'-wal')).size>0);await rm(path+'-shm',{force:true});}else assert.ok((await stat(path+'-journal')).size>0);
 const before=await rootBytes(root),scratch=await scratchNames();assert.throws(()=>new StoreDatabase(root,()=>{}),{code:'UNSUPPORTED_STORAGE'});assert.deepEqual(await rootBytes(root),before);assert.deepEqual(await scratchNames(),scratch);
});
test('captured WAL state remains visible, while later source membership drift refuses writable handoff',async t=>{
 const root=await rootFor(t),path=await crashedDatabase(t,root,'WAL');await rm(path+'-shm',{force:true});const before=await rootBytes(root),scratch=await scratchNames(),captured=editorSQLitePreflight(root,path);
 try{assert.equal(captured.db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value,'73');captured.checkSource();assert.deepEqual(await rootBytes(root),before);await writeFile(path+'-shm',Buffer.alloc(0),{mode:0o600});assert.throws(()=>captured.checkSource(),{code:'ROOT_UNSAFE'});}finally{captured.close();}assert.deepEqual(await scratchNames(),scratch);
});
test('corrupt latest snapshot remains a fallback input; verified future snapshot still refuses',async t=>{
 const root=await rootFor(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE snapshots(descriptor TEXT NOT NULL) STRICT');
 const prior=await snapshot(root,8,doc()),broken=await snapshot(root,8,doc(null,{revision:'2'}));const path=join(root,'objects','sha256',broken.content.blob.hash.slice(7,9),broken.content.blob.hash.slice(7));await writeFile(path,Buffer.from('corrupt'));
 db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(prior));db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(broken));assert.doesNotThrow(()=>inspect(db,root,17));
 const valid=await snapshot(root,8,doc());db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(valid));assert.doesNotThrow(()=>inspect(db,root,17));
 const invalid=await snapshot(root,8,{id:'malformed_document'});db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(invalid));assert.doesNotThrow(()=>inspect(db,root,17));
 const future=await snapshot(root,10,doc());db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(future));assert.throws(()=>inspect(db,root,18),{code:'UNSUPPORTED_STORAGE'});
});

test('valid snapshot cannot hide missing or corrupt required nested metadata behind snapshot fallback',async t=>{
 const root=await rootFor(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE snapshots(descriptor TEXT NOT NULL) STRICT;CREATE TABLE snapshot_roots(snapshot_id TEXT,owner TEXT,hash TEXT,media_type TEXT) STRICT');
 const absent=ref(Buffer.from('image-state')),value=doc(image(absent));
 // The outer snapshot entity must be valid, so corrupt-snapshot fallback
 // cannot prevent this case from reaching its required nested metadata.
 assert.equal(projectionEntity(8,'document',value),'1');
 const descriptor=await snapshot(root,8,value);db.prepare('INSERT INTO snapshots VALUES (?)').run(JSON.stringify(descriptor));db.prepare('INSERT INTO snapshot_roots VALUES (?,?,?,?)').run('snapshot_1','document:document_1',absent.hash,absent.mediaType);
 assert.throws(()=>inspect(db,root,17),{code:'MISSING_OBJECT'});
 const path=join(root,'objects','sha256',absent.hash.slice(7,9),absent.hash.slice(7));await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,Buffer.from('wrong-state'),{mode:0o600});assert.throws(()=>inspect(db,root,17),{code:'CORRUPT_OBJECT'});
});


const capabilityRefusal=code=>error=>{
 assert.equal(error.code,'UNSUPPORTED_STORAGE');assert.deepEqual(error.detail,{kind:'fields',issues:[{path:'storage.schemaVersion',code}]});return true;
};
for(const [table,value]of [
 ['commands',{command:{body:{type:'PrepareV45EditInputs'}}}],
 ['documents',doc(null,{metadata:{schemaVersion:1,name:'Mislabeled zero-version document',creationBackground:{kind:'transparent'}}})],
 ['image_edit_reviews',{kind:'request-review-v45-2'}],
])test('nonempty version0 '+table+' hits typed semantic refusal before nullseal and source writes',async t=>{
 const root=await rootFor(t),path=join(root,'metadata.sqlite'),db=new DatabaseSync(path),column=table==='commands'?'canonical':'json';
 db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,${column} TEXT NOT NULL) STRICT`);add(db,table,value,column,table==='documents'?'document_1':'entry_1');assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);db.close();await chmod(path,0o600);
 const bytes=await rootBytes(root),scratch=await scratchNames();assert.throws(()=>new StoreDatabase(root,()=>{}),capabilityRefusal('EDITOR_CONTRACTS_REQUIRE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP'));
 assert.deepEqual(await rootBytes(root),bytes);assert.deepEqual(await scratchNames(),scratch);
});
test('explicit null/unknown seals refuse and the exact seal passes the pure readiness check',()=>{
 assert.throws(()=>assertEditorSchema18Ready(null),capabilityRefusal('EDITOR_SCHEMA18_CAPABILITIES_UNSEALED'));
 assert.throws(()=>assertEditorSchema18Ready(hash(Buffer.from('unknown-capability-seal'))),capabilityRefusal('EDITOR_SCHEMA18_CAPABILITIES_UNSEALED'));
 assert.doesNotThrow(()=>assertEditorSchema18Ready(EDITOR_SCHEMA18_CAPABILITY_HASH));
 assert(EDITOR_SCHEMA18_CAPABILITY_SEAL===null||EDITOR_SCHEMA18_CAPABILITY_SEAL===EDITOR_SCHEMA18_CAPABILITY_HASH,'The compiled fixture must be deliberately unsealed or carry the exact reviewed capability identity');
});
function compiledReadinessCode(){
 if(EDITOR_SCHEMA18_CAPABILITY_SEAL===null)return 'EDITOR_SCHEMA18_CAPABILITIES_UNSEALED';
 assert.equal(EDITOR_SCHEMA18_CAPABILITY_SEAL,EDITOR_SCHEMA18_CAPABILITY_HASH);
 if(COMPOSITION_TEXT_SCHEMA19_CAPABILITY_SEAL===null)return 'COMPOSITION_TEXT_SCHEMA19_CAPABILITIES_UNSEALED';
 assert.equal(COMPOSITION_TEXT_SCHEMA19_CAPABILITY_SEAL,COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH);return null;
}
function compiledReadiness(operation){
 const code=compiledReadinessCode();if(code)assert.throws(operation,capabilityRefusal(code));else assert.doesNotThrow(operation);
}
test('actually empty version0 and known legacy envelopes preserve the compiled readiness lifecycle',async t=>{
 const root=await rootFor(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
 assert.doesNotThrow(()=>inspect(db,root,0));compiledReadiness(()=>assertEditorStorageCompatibility(db,root,0));
 db.exec('CREATE TABLE commands(id TEXT PRIMARY KEY,canonical TEXT NOT NULL) STRICT');add(db,'commands',{command:{body:{type:'NewDocument',width:1,height:1,color:'sRGB',depth:8}}},'canonical');
 assert.doesNotThrow(()=>inspect(db,root,0));compiledReadiness(()=>assertEditorStorageCompatibility(db,root,0));
});
test('existing empty version0 refuses unchanged while unsealed or bootstraps19 preserving the exact18 receipt',async t=>{
 const root=await rootFor(t),path=join(root,'metadata.sqlite'),db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);db.close();await chmod(path,0o600);
 const bytes=await rootBytes(root),scratch=await scratchNames(),readinessCode=compiledReadinessCode();
 if(readinessCode){
  assert.throws(()=>new StoreDatabase(root,()=>{}),capabilityRefusal(readinessCode));
  assert.deepEqual(await rootBytes(root),bytes);
 }else{
  assert.equal(EDITOR_SCHEMA18_CAPABILITY_SEAL,EDITOR_SCHEMA18_CAPABILITY_HASH);
  const store=new StoreDatabase(root,()=>{});try{assert.equal(store.epoch,'1');}finally{store.close();}
  const reader=new DatabaseSync(path,{readOnly:true,allowExtension:false});try{
   assert.equal(reader.prepare('PRAGMA user_version').get().user_version,19);
   assert.equal(reader.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value,'1');
   const actual=JSON.parse(reader.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get().receipt);
   assert.doesNotThrow(()=>assertEditorSchema18Receipt(actual));assert.equal(actual.backup,null);assert.equal(actual.rollback,null);
   const successor=JSON.parse(reader.prepare('SELECT receipt FROM schema_migrations WHERE version=19').get().receipt);
   assert.doesNotThrow(()=>assertCompositionTextSchema19Receipt(successor));assert.equal(successor.backup,null);assert.equal(successor.rollback,null);
  }finally{reader.close();}
  const reopened=new StoreDatabase(root,()=>{});try{assert.equal(reopened.epoch,'2');}finally{reopened.close();}
 }
 assert.deepEqual(await scratchNames(),scratch);
});
