import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
import {draftStateDependencies,jsonResponse} from '../draft-state-module.mjs';
import {viewModelDependencies} from '../view-model-module.mjs';
// Real client workflow and ownership, with isolated command/transport boundaries. Browser
// consent and actual destination bytes are exercised by recovery-copy.spec.ts.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const source=(await transformWithOxc(await readFile('src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {draftURL,commandsURL,memoryURL,controlURL}=await draftStateDependencies(allocationsURL,{promptURL:promptMemoryURL});
const {viewURL}=await viewModelDependencies(allocationsURL,{promptURL:promptMemoryURL,memoryURL,controlURL});
const resourcesURL=data((await transformWithOxc(await readFile('src/state/document-lifecycle.ts','utf8'),'document-lifecycle.ts')).code);
const {DraftPersistence}=await import(draftURL),{cloneOwnedModel}=await import(memoryURL),{allocationLedger}=await import(allocationsURL);
const stub=`
import {ViewModelOwners,ViewModelReads,ownDownload} from ${JSON.stringify(viewURL)};
import {CommandControlReads} from ${JSON.stringify(commandsURL)};
import {reserveCommandWire,measureControl} from ${JSON.stringify(controlURL)};
import {readOwnedJSON,cloneOwnedModel} from ${JSON.stringify(memoryURL)};
import {DocumentResources} from ${JSON.stringify(resourcesURL)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};
const browserPhases={resetNavigation(){},reset(){}};`;

const {EditorClient}=await import(data(stub+source));
const {RECOVERY_OMISSIONS}=await import(data((await transformWithOxc(await readFile('src/protocol/portable.ts','utf8'),'portable.ts')).code));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const fixtures=new Set();let baseline;
const usage=()=>{const {cpuBytes,handles,activeRecords}=allocationLedger.snapshot();return {cpuBytes,handles,activeRecords};};
test.beforeEach(()=>{baseline=usage();});
test.afterEach(async()=>{const results=await Promise.allSettled([...fixtures].map(f=>f.close()));fixtures.clear();const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'Recovery copy fixture cleanup failed');assert.deepEqual(usage(),baseline,'Every document, checkpoint and response owner drains');});
function fixture(){
 let identity='owner';const session={identity:()=>identity,csrf:()=> 'fixture-csrf',transport:async path=>{throw Error('Unexpected fixture transport '+path);}},client=new EditorClient(session),documents=cloneOwnedModel('recovery-fixture-documents',[{id:'document_1',revision:'3',historyHead:'history_1'}]),document=documents.value[0];
 client.owner=identity;client.draftOwner=new DraftPersistence('session_1',session.transport,session.csrf);client.draftOwner.checkpoint={sessionId:'session_1',uiSeq:'0',drafts:[],preferences:{documentId:document.id,selectedLayerIds:[]}};client.ui=client.draftOwner.checkpoint;
 client.documentsMetadata={documents:documents.value,pin:()=>documents.pin(),release:()=>documents.release()};client.patch({ready:true,documents:documents.value,document});
 const calls=[],reply=deferred(),entered=deferred();client.ownedCommand=async(body,target)=>{calls.push({body,target});entered.resolve();return cloneOwnedModel('recovery-fixture-command-events',await reply.promise);};
 client.flushDrafts=async()=>{throw Error('Recovery must not capture drafts');};
 const bundle={protocolVersion:1,bundleId:'recovery_1',documentId:document.id,documentRevision:document.revision,capturedHighWater:'12',uiDigest:'sha256:'+'1'.repeat(64),blob:{hash:'sha256:'+'2'.repeat(64),byteLength:'512',mediaType:'application/x-ideogram-project'},complete:false,status:'recovery-copy-ready',destinationStatus:'unconfirmed',recovery:{kind:'tp1-sanitized-recovery-v1',label:'Incomplete sanitized recovery copy',sanitized:true,authority:'observation-only',acknowledgementId:'ack_1',scope:'current-document-safe-content',omissions:[...RECOVERY_OMISSIONS]}};
 const f={client,document,calls,reply,entered,bundle,identity:value=>{identity=value;},finish:()=>reply.resolve([{type:'BundlePrepared',payload:{bundle}}]),async close(){reply.resolve([]);client.dispose();await Promise.all([client.documentResources.release(),client.recoveryDrain,client.drainDraftOwners()]);}};fixtures.add(f);return f;
}
test('recovery is an explicit command against frozen document and never flushes excluded drafts',async()=>{
 const f=fixture(),work=f.client.copyRecovery('ack_1');await f.entered.promise;assert.deepEqual(f.calls,[{body:{type:'SaveRecoveryCopy',acknowledgementId:'ack_1'},target:{id:f.document.id,revision:f.document.revision}}]);f.finish();await work;
 assert.equal(f.client.view.download.name,'project.recovery.ideogram-project');assert.deepEqual(f.client.view.download.recovery,f.bundle.recovery);assert.equal(f.client.view.download.status,'ready');assert.match(f.client.view.message,/Incomplete sanitized recovery copy.*inspection only.*unconfirmed/i);
});
for(const boundary of ['identity','owner','session','transport','lifecycle','document lifetime','document'])test('late recovery completion after '+boundary+' replacement does not publish a download',async()=>{
 const f=fixture(),work=f.client.copyRecovery('ack_1');await f.entered.promise;
 if(boundary==='identity')f.identity('new-owner');if(boundary==='owner')f.client.owner='new-owner';if(boundary==='session')f.client.ui={...f.client.ui,sessionId:'new-session'};if(boundary==='transport')f.client.session={identity:()=> 'owner'};if(boundary==='lifecycle')f.client.lifecycle++;if(boundary==='document lifetime')f.client.documentLifetime++;if(boundary==='document')f.client.patch({document:{...f.document,id:'other'}});
 f.finish();if(boundary==='document')await work;else await assert.rejects(work,{name:'AbortError'});assert.equal(f.client.view.download,null);
});
for(const defect of ['complete','status','ack','document','revision'])test('mismatched '+defect+' result never publishes a recovery copy',async()=>{
 const f=fixture(),work=f.client.copyRecovery('ack_1');if(defect==='complete')f.bundle.complete=true;if(defect==='status')f.bundle.status='copy-ready';if(defect==='ack')f.bundle.recovery.acknowledgementId='different';if(defect==='document')f.bundle.documentId='different';if(defect==='revision')f.bundle.documentRevision='4';f.finish();await assert.rejects(work,/RECOVERY_COPY_IDENTITY_CHANGED/);assert.equal(f.client.view.download,null);
});
for(const value of ['',null,'with spaces'])test('missing or malformed acknowledgement '+JSON.stringify(value)+' submits nothing',async()=>{const f=fixture();await assert.rejects(f.client.copyRecovery(value),/RECOVERY_COPY_REVIEW_REQUIRED/);assert.equal(f.calls.length,0);});
test('inspection-only recovery opening never claims a new editable identity',async()=>{
 const f=fixture();f.client.ownedUpload=async()=>cloneOwnedModel('recovery-fixture-upload',{stagingId:'stage',sha256:'sha256:'+'3'.repeat(64)});f.client.ownedCommand=async()=>cloneOwnedModel('recovery-fixture-import-events',[{type:'BundleImportReviewed',payload:{reviewId:'review'}}]);f.client.session.transport=async()=>jsonResponse({editable:false,recovery:f.bundle.recovery,reason:'INCOMPLETE_SANITIZED_RECOVERY_COPY'});await f.client.openBundle({name:'rescue.ideogram-project'});assert.match(f.client.view.message,/Inspection only; it cannot reopen an editable document/);assert.equal(f.client.view.review.review.editable,false);
});
