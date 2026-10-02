import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {zeroEffects} from '../store/helpers.mjs';
import {setup,copy,preview,workspace,terminal,edit,doc,binary,upload,digest} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {unpack,records,addObject,addEntity,pack,encoded,putRecords} from './archive-fixture.mjs';

const authored='Author chose https://authored.example/?signature=literal&token=not-a-credential — Café 東京';
const credential='KNOWN_TRANSPORT_CREDENTIAL_86f0';
const signed='KNOWN_SIGNED_URL_SENTINEL_62ad';
const transport=Buffer.from('Authorization: Key '+credential+'\nhttps://media.example/result?signature='+signed);
const policy={profileId:'privacy_fixture',profileVersion:1,evidenceDigest:'sha256:'+'c'.repeat(64),requestedStoreIO:'0',requestedAccess:'most-private-compatible',appliedLifecycleSeconds:null,appliedACL:'private',enforcement:'unknown',fallbackAcknowledgementId:null};
const acknowledgementId='explicit_incomplete_recovery_1';
const values=entries=>records(entries).values.filter(r=>r.kind==='entity').map(r=>({kind:r.entityType,id:r.logicalId,value:JSON.parse(entries.get('objects/'+r.payloadRef.hash.slice(7)))}));
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function currentImage(t){const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const imported=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:imported.asset.id,layerId:'picture',name:authored,draft:null});return {f,...imported};}
async function recovery(f,id='document_1'){
 const result=await edit(f,{type:'SaveRecoveryCopy',acknowledgementId},id),bundle=result.event.payload.bundle;
 assert.equal(bundle.complete,false);assert.equal(bundle.status,'recovery-copy-ready');assert.equal(bundle.destinationStatus,'unconfirmed');assert.equal(bundle.recovery.label,'Incomplete sanitized recovery copy');
 const downloaded=await binary(f,'/api/v1/bundles/'+bundle.bundleId+'/content');assert.equal(downloaded.status,200);assert.equal(digest(downloaded.bytes),bundle.blob.hash);
 return {...result,bundle,bytes:downloaded.bytes,entries:await unpack(f.root,downloaded.bytes)};
}
async function contaminated(t){
 const {f,asset}=await currentImage(t),base=await copy(f),entries=await unpack(f.root,base.bytes),requested=addObject(entries,Buffer.from(authored),'text/plain'),returned=addObject(entries,Buffer.from('Returned '+credential+' '+signed),'text/plain'),privacyPolicyRef=addObject(entries,encoded(policy)),safeTimingsRef=addObject(entries,encoded({processingMs:12.25,totalMs:14.5}));
 addEntity(entries,'portable-provider','historic_attempt',{class:'portable-provider',attemptId:'historic_attempt',endpoint:'ideogram/v4',requestId:'historic_request',status:'completed',assetHashes:[asset.blob.hash],requestedPromptRef:requested,submittedPromptRef:requested,returnedPromptRef:returned,seedText:'18446744073709551615',safeTimingsRef,privacyPolicyRef,derivation:{profile:'TP-1',sourceBodyHash:digest(transport),complete:true}});
 const originalArchive=await pack(f.root,entries),opened=await preview(f,originalArchive);assert.equal(opened.review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:opened.review.reviewId,reviewHash:opened.review.reviewHash});
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{db.prepare('INSERT INTO portable_quarantined_hashes VALUES (?,?)').run(returned.hash,'known-transport-sentinel');}finally{db.close();}
 return {f,id:opened.review.documentId,originalArchive,source:opened.review.source,returned,requested,asset};
}

test('explicit recovery preserves useful safe pixels and authored URL text, omits secret and ancestor archive, and cannot import',async t=>{
 const x=await contaminated(t),before=await doc(x.f,x.id),retained=await readFile(objectPath(x.f.root,x.source));assert.deepEqual(retained,x.originalArchive);
 const failed=x.f.command({documentId:x.id,expectedDocumentRevision:before.revision,body:{type:'SaveCopy'}}),full=await x.f.post('/api/v1/commands',failed);assert.notEqual(full.status,202);assert.notEqual(full.json?.receipt?.status,'accepted');
 const saved=await recovery(x.f,x.id),manifest=JSON.parse(saved.entries.get('manifest.json')),all=values(saved.entries);
 assert.equal(manifest.formatVersion,11);assert.equal(manifest.documentSchema,11);assert.equal(manifest.complete,false);assert.deepEqual(manifest.recovery,saved.bundle.recovery);assert.equal(manifest.rootRefs[0].kind,'recovery-document');
 assert(all.every(r=>r.kind.startsWith('recovery-')));assert.equal(records(saved.entries).values.some(r=>r.kind==='transaction'),false);assert.equal(manifest.segments.some(s=>s.kind==='events'),false);
 const snapshot=all.find(r=>r.kind==='recovery-document').value;assert.equal(snapshot.width,3);assert.equal(snapshot.height,2);assert.equal(snapshot.layers.length,1);assert.equal(snapshot.layers[0].name,authored);assert.deepEqual(snapshot.layers[0].layerToDocument,[1,0,0,1,0,0]);assert(snapshot.layers[0].assetId);assert(snapshot.compositeAssetId);
 const safe=all.find(r=>r.kind==='recovery-asset'&&r.id===snapshot.layers[0].assetId).value;assert.deepEqual(saved.entries.get('objects/'+safe.blob.hash.slice(7)),await readFile(objectPath(x.f.root,safe.blob)));assert.deepEqual(saved.entries.get('objects/'+safe.pixels.hash.slice(7)),await readFile(objectPath(x.f.root,safe.pixels)));
 const record=all.find(r=>r.kind==='recovery-provider').value;assert.equal(record.returnedPromptRef,null);assert.equal(record.derivation.complete,false);assert.equal(record.seedText,'18446744073709551615');assert.deepEqual(record.assetHashes,[x.asset.blob.hash]);assert.deepEqual(JSON.parse(saved.entries.get('objects/'+record.safeTimingsRef.hash.slice(7))),{processingMs:12.25,totalMs:14.5});assert.equal(saved.entries.get('objects/'+x.requested.hash.slice(7)).toString(),authored);
 for(const secret of [credential,signed,transport])assert.equal(saved.bytes.includes(Buffer.from(secret)),false);for(const ref of [x.returned,x.source])assert.equal(saved.entries.has('objects/'+ref.hash.slice(7)),false);
 assert.deepEqual(await readFile(objectPath(x.f.root,x.source)),x.originalArchive);assert.deepEqual(await readFile(objectPath(x.f.root,x.returned)),Buffer.from('Returned '+credential+' '+signed));assert.deepEqual(await doc(x.f,x.id),before);
 const reviewed=await preview(x.f,saved.bytes);assert.equal(reviewed.review.editable,false);assert.equal(reviewed.review.reason,'INCOMPLETE_SANITIZED_RECOVERY_COPY');assert.deepEqual(reviewed.review.recovery,saved.bundle.recovery);
 const attempt=x.f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash}}),rejected=await terminal(x.f,attempt);assert.equal(rejected.json.receipt.status,'rejected');assert.equal(rejected.json.receipt.code,'INCOMPATIBLE');assert.deepEqual(await doc(x.f,x.id),before);
 const db=new DatabaseSync(join(x.f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM queue_jobs').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM portable_pins').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,1);}finally{db.close();}
});

test('recovery stays scoped, omits withheld descendants, and is never the latest full copy',async t=>{
 const {f,input}=await currentImage(t);const saved=await copy(f),before=await doc(f);const ui=(await f.read('/api/v1/documents/document_1/save-status?sessionId=recovery_session')).json;
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{const row=db.prepare('SELECT json FROM assets WHERE id=?').get(input.id),a=JSON.parse(row.json);a.safety='withheld';db.prepare('UPDATE assets SET json=? WHERE id=?').run(encoded(a).toString(),input.id);}finally{db.close();}
 const recovered=await recovery(f),all=values(recovered.entries),document=all.find(r=>r.kind==='recovery-document').value;
 assert.equal(all.some(r=>r.kind==='recovery-asset'),false);assert.equal(document.layers[0].assetId,null);assert.equal(document.compositeAssetId,null);assert(document.omitted.assets>=2);assert.equal(recovered.entries.has('objects/'+input.blob.hash.slice(7)),false);
 assert.deepEqual(await doc(f),before);const after=(await f.read('/api/v1/documents/document_1/save-status?sessionId=recovery_session')).json;assert.equal(after.bundleOutdated,ui.bundleOutdated);assert.equal(after.copyStatus,'copy-ready');
 const again=await terminal(f,recovered.command);assert.deepEqual(again.json.receipt,recovered.receipt);assert.equal((await f.read('/api/v1/bundles/'+saved.bundle.bundleId)).json.complete,true);
});

for(const fault of ['complete','transport-field','timing-header','timing-url','policy-header','extra-object','wrong-root','normal-entity','event'])test('PF-11 '+fault+' cannot become an editable or mislabeled import',async t=>{
 const {f}=await currentImage(t),saved=await recovery(f),entries=saved.entries,manifest=JSON.parse(entries.get('manifest.json'));
 if(fault==='complete'){manifest.complete=true;entries.set('manifest.json',encoded(manifest));}
 if(['transport-field','timing-header','timing-url','policy-header'].includes(fault)){const policyRef=addObject(entries,encoded(fault==='policy-header'?{...policy,headers:{Authorization:credential}}:policy)),safeTimingsRef=fault.startsWith('timing-')?addObject(entries,encoded(fault==='timing-header'?{Authorization:credential}:{totalMs:'https://provider.invalid/?signature='+signed})):null;addEntity(entries,'recovery-provider','fake_attempt',{class:'portable-provider',attemptId:'fake_attempt',endpoint:'ideogram/v4',requestId:null,status:'completed',assetHashes:[],requestedPromptRef:null,submittedPromptRef:null,returnedPromptRef:null,seedText:null,safeTimingsRef,privacyPolicyRef:policyRef,derivation:{profile:'TP-1',sourceBodyHash:digest(transport),complete:false},...(fault==='transport-field'?{headers:{Authorization:credential}}:{})});}
 if(fault==='extra-object')addObject(entries,transport,'text/plain');
 if(fault==='wrong-root'){manifest.rootRefs[0].logicalId='other_document';entries.set('manifest.json',encoded(manifest));}
 if(fault==='normal-entity')addEntity(entries,'document','smuggled_document',await doc(f));
 if(fault==='event'){const {path,values}=records(entries);values.push({schemaVersion:1,kind:'event',event:saved.event});putRecords(entries,path,values);}
 const source=await upload(f,await pack(f.root,entries)),result=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:source.stagingId,expectedSha256:source.sha256}}));assert.equal(result.json.receipt.status,'rejected');
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM queue_jobs').get().n,0);}finally{db.close();}
});

test('recovery refusal without explicit acknowledgement leaves the original document intact',async t=>{
 const {f}=await currentImage(t),before=await doc(f),request=f.command({documentId:before.id,expectedDocumentRevision:before.revision,body:{type:'SaveRecoveryCopy'}}),response=await f.post('/api/v1/commands',request);assert.notEqual(response.status,202);assert.notEqual(response.json?.receipt?.status,'accepted');assert.deepEqual(await doc(f),before);
});

for(const state of ['unknown','withheld','quarantined'])test('provider '+state+' pixels and normalized descendants stay withheld in recovery',async t=>{
 const {f,input,asset}=await currentImage(t),before=await doc(f),db=new DatabaseSync(join(f.root,'metadata.sqlite'));
 try{
  // An isolated retained-safety fixture models a late safety withdrawal. It
  // intentionally leaves descendant rows marked safe to test ancestry checks.
  const candidate={id:'withdrawn_candidate',version:'2',documentId:before.id,jobId:'historical_job',attemptId:'historical_attempt',requestId:'historical_request',outputIndex:0,outputIdentity:'sha256:'+'a'.repeat(64),safety:state==='quarantined'?'safe':state,state:state==='quarantined'?'prepared':'withheld',hidden:false,encodedAssetId:input.id,preparedAssetId:asset.id,warning:null};
  db.prepare('INSERT INTO candidates VALUES (?,?,?,?)').run(candidate.id,before.id,candidate.jobId,encoded(candidate).toString());
  if(state==='quarantined'){const original=JSON.parse(db.prepare('SELECT json FROM assets WHERE id=?').get(input.id).json);original.safety='quarantined';db.prepare('UPDATE assets SET json=? WHERE id=?').run(encoded(original).toString(),input.id);}
 }finally{db.close();}
 const saved=await recovery(f),all=values(saved.entries),snapshot=all.find(r=>r.kind==='recovery-document').value;assert.equal(snapshot.layers[0].assetId,null);assert.equal(snapshot.compositeAssetId,null);assert.equal(all.some(r=>r.kind==='recovery-asset'),false);assert.equal(saved.entries.has('objects/'+asset.blob.hash.slice(7)),false);assert.equal(saved.entries.has('objects/'+asset.raster.pixels.hash.slice(7)),false);assert.deepEqual(await doc(f),before);
});

test('J1 name survives recovery while historical background metadata stays excluded',async t=>{
 const f=await setup(t),name='Café 東京 recovery',created=f.command({expectedDocumentRevision:null,body:{type:'CreateDocument',name,width:3,height:2,background:{kind:'solid',color:[17,83,201,255]}}}),accepted=await terminal(f,created);assert.equal(accepted.json.receipt.status,'accepted');
 const initial=await doc(f),state=(await f.read('/api/v1/documents/'+initial.id+'/image')).json;await edit(f,{type:'DeleteLayer',layerId:state.layers[0].id,layerVersion:state.layers[0].version,draft:null});
 const before=await doc(f),saved=await recovery(f),snapshot=values(saved.entries).find(r=>r.kind==='recovery-document').value;assert.equal(snapshot.name,name);assert.deepEqual(snapshot.layers,[]);assert.equal(Object.hasOwn(snapshot,'creationBackground'),false);assert(saved.bundle.recovery.omissions.includes('creation-background-provenance'));assert.deepEqual(await doc(f),before);assert.deepEqual(before.metadata,initial.metadata);
});

test('missing source asset omits both its direct layer and transitive composite without changing original bytes',async t=>{
 const {f,input,asset}=await currentImage(t),before=await doc(f),sourceBytes=await readFile(objectPath(f.root,input.blob)),imageBytes=await readFile(objectPath(f.root,asset.blob)),pixels=await readFile(objectPath(f.root,asset.raster.pixels)),db=new DatabaseSync(join(f.root,'metadata.sqlite'));
 try{
  // Native layer -> encoded original is one edge; current composite -> native
  // layer -> encoded original is two edges. Leave the owned bytes in place so
  // the test isolates absent safety authority, not physical missing content.
  // Only remove the missing asset's own dependency-index rows before its row;
  // keep SQL foreign keys enabled and all descendant metadata/roots intact.
  db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  const dependencies=db.prepare('SELECT hash FROM asset_dependencies WHERE asset_id=? ORDER BY hash').all(input.id),descendants=db.prepare('SELECT id,json FROM assets WHERE id IN (?,?) ORDER BY id').all(asset.id,before.image.compositeAssetId),roots=db.prepare('SELECT * FROM roots ORDER BY owner,hash,media_type').all();
  assert(dependencies.some(row=>row.hash===input.blob.hash));assert(asset.raster.sourceAssetIds.includes(input.id));assert.equal(descendants.length,2);assert(JSON.parse(descendants.find(row=>row.id===before.image.compositeAssetId).json).raster.sourceAssetIds.includes(asset.id));
  assert.equal(db.prepare('DELETE FROM asset_dependencies WHERE asset_id=?').run(input.id).changes,dependencies.length);
  assert.equal(db.prepare('DELETE FROM assets WHERE id=?').run(input.id).changes,1);
  assert.equal(db.prepare('SELECT 1 FROM assets WHERE id=?').get(input.id),undefined);assert.deepEqual(db.prepare('SELECT id,json FROM assets WHERE id IN (?,?) ORDER BY id').all(asset.id,before.image.compositeAssetId),descendants);assert.deepEqual(db.prepare('SELECT * FROM roots ORDER BY owner,hash,media_type').all(),roots);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.exec('COMMIT');
 }finally{try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}
 const saved=await recovery(f),all=values(saved.entries),snapshot=all.find(r=>r.kind==='recovery-document').value;
 assert.equal(snapshot.layers[0].assetId,null);assert.equal(snapshot.compositeAssetId,null);assert.equal(all.some(r=>r.kind==='recovery-asset'),false);assert(snapshot.omitted.assets>=2);
 assert.equal(saved.entries.has('objects/'+asset.blob.hash.slice(7)),false);assert.equal(saved.entries.has('objects/'+asset.raster.pixels.hash.slice(7)),false);
 assert.deepEqual(await readFile(objectPath(f.root,input.blob)),sourceBytes);assert.deepEqual(await readFile(objectPath(f.root,asset.blob)),imageBytes);assert.deepEqual(await readFile(objectPath(f.root,asset.raster.pixels)),pixels);assert.deepEqual(await doc(f),before);
});

test('ancestry denies missing rows, permits classified unknown originals, and terminates cycles',async t=>{
 const raster=(id,sourceAssetIds,safety='safe')=>({id,safety,qualification:'canonical-raster',raster:{sourceAssetIds}}),original={id:'original',safety:'unknown',qualification:'pending-decoder'};
 const fixtures=[
  {name:'missing-start',assetId:'absent',assets:[],expected:false},
  {name:'missing-immediate',assetId:'child',assets:[raster('child',['absent'])],expected:false},
  {name:'missing-transitive',assetId:'child',assets:[raster('child',['middle']),raster('middle',['absent'])],expected:false},
  {name:'existing-unknown-original-no-candidate',assetId:'child',assets:[raster('child',['original']),original],expected:true},
  {name:'existing-unknown-original-safe-candidate',assetId:'child',assets:[raster('child',['original']),original],candidates:[{safety:'safe',encodedAssetId:'original',preparedAssetId:'child'}],expected:true},
  {name:'existing-unknown-original-unclassified-candidate',assetId:'child',assets:[raster('child',['original']),original],candidates:[{safety:'unknown',encodedAssetId:'original',preparedAssetId:'child'}],expected:false},
  {name:'local-candidate-missing-safety',assetId:'child',assets:[raster('child',['original']),original],candidates:[{encodedAssetId:'original',preparedAssetId:'child'}],expected:false},
  {name:'local-candidate-null-safety',assetId:'child',assets:[raster('child',['original']),original],candidates:[{safety:null,encodedAssetId:'original',preparedAssetId:'child'}],expected:false},
  {name:'imported-candidate-missing-safety',assetId:'child',assets:[raster('child',['original']),original],importedCandidates:[{encodedAssetId:'original',preparedAssetId:'child'}],expected:false},
  {name:'imported-candidate-null-safety',assetId:'child',assets:[raster('child',['original']),original],importedCandidates:[{safety:null,encodedAssetId:'original',preparedAssetId:'child'}],expected:false},
  {name:'imported-candidate-explicit-safe',assetId:'child',assets:[raster('child',['original']),original],importedCandidates:[{safety:'safe',encodedAssetId:'original',preparedAssetId:'child'}],expected:true},
  {name:'self-cycle-present',assetId:'child',assets:[raster('child',['child'])],expected:true},
  {name:'shared-cycle-present',assetId:'child',assets:[raster('child',['middle']),raster('middle',['child'])],expected:true},
  {name:'cycle-with-missing-branch',assetId:'child',assets:[raster('child',['middle']),raster('middle',['child','absent'])],expected:false},
  {name:'cycle-with-quarantined-branch',assetId:'child',assets:[raster('child',['middle']),raster('middle',['child','blocked']),raster('blocked',[],'quarantined')],expected:false},
 ];
 // A process deadline remains enforceable while SQLite is executing native
 // code. It detects a regression to endless UNION ALL without hanging this
 // test runner. The child uses the repository's strict no-network preload.
 const child=fork(fileURLToPath(new URL('./recovery-ancestry-fixture.mjs',import.meta.url)),[],{execArgv:['--import',fileURLToPath(new URL('../store/no-network.mjs',import.meta.url))],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});
 const exited=once(child,'exit');let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-16384);});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
 const response=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Recovery ancestry traversal did not finish within 5 seconds.'));},5000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Recovery ancestry child exited before reply: '+code+' '+stderr));});
  child.once('message',message=>{clearTimeout(timer);message.error?reject(Error(message.error)):resolve(message);});
 });
 child.send(fixtures);const result=await response;assert.deepEqual(result.results,fixtures.map(({name,expected})=>({name,allowed:expected,unchanged:true})));assert.deepEqual(result.effects,zeroEffects);await exited;
});
