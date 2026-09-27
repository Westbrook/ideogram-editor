import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {randomUUID} from 'node:crypto';
import {setup,terminal,workspace,upload,copy,preview,binary} from '../portable/helpers.mjs';
import {priorWriter} from './prior-writer.mjs';
import {unpack,pack,encoded} from '../portable/archive-fixture.mjs';
import {textDraft,textBody} from '../../dist/local/src/protocol/text.js';
const priorCommit='d3c6046a44d29d89ccdcb219cc37d40f02bad84f';
const style={primaryFont:'sha256:'+'0'.repeat(64),explicitFallbacks:[],sizePx:24,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'};
async function stage(f,bytes){const s=await upload(f,bytes,'caption','text/plain');return (await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;}
async function draft(f,placed,text){const source=await stage(f,Buffer.from(text)),value={schemaVersion:placed?2:1,kind:placed?'text-draft-2':'text-draft-1',textUtf8:source.blob,style,frame:{width:100,height:50},fonts:[],...placed?{placement:{x:-2.5,y:8.25}}:{}},asset=await stage(f,Buffer.from(canonical(value)));const result=await f.post('/api/v1/ui/session_1',{protocolVersion:1,requestId:randomUUID(),sessionId:'session_1',expectedUISeq:'0',body:{type:'SaveDraft',draft:{id:'recoverable',generation:'1',kind:'text',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:asset.id,composing:true}}});assert.equal(result.json.status,'accepted',result.text);return value;}
test('placement draft versions remain strict and finite; old command omission remains valid',()=>{
 const ref={hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'text/plain'},v={schemaVersion:1,kind:'text-draft-1',textUtf8:ref,style,frame:{width:1,height:1},fonts:[]};textDraft(v);assert.throws(()=>textDraft({...v,placement:{x:0,y:0}}));textDraft({...v,schemaVersion:2,kind:'text-draft-2',placement:{x:-.5,y:2.25}});assert.throws(()=>textDraft({...v,schemaVersion:2,kind:'text-draft-2',placement:{x:Infinity,y:0}}));
 const body={type:'CreateTextLayer',layerId:'layer_1',name:'Text',candidate:{...ref,mediaType:'application/json'},draft:{sessionId:'session_1',draftId:'draft_1',generation:'1'},admissionId:'admission_1'};textBody(body);textBody({...body,placement:{x:-.5,y:2.25}});assert.throws(()=>textBody({...body,placement:{x:NaN,y:0}}));
});
test('exact oversized source streams with generation and client ownership; PF6 retains placement and PF5 stays editable',async t=>{
 const old=await priorWriter(t,priorCommit),legacy=await old.setup(t);await old.terminal(legacy,legacy.command({}, {width:120,height:70}));const legacyValue=await draft(legacy,false,'legacy');const legacyCopy=await old.copy(legacy);
 const f=await setup(t);await terminal(f,f.command({}, {width:120,height:70}));const text='\ufeff'+('draft\n'.repeat(12000)),value=await draft(f,true,text),path='/api/v1/ui/session_1/text?draftId=recoverable';
 assert.deepEqual((await f.read(path)).json.value,value);assert.equal((await f.read(path+'&content=1&generation=0')).status,410);assert.equal((await binary(f,path+'&content=1&generation=1')).bytes.toString(),text);assert.equal((await f.read('/api/v1/ui/another_session/text?draftId=recoverable')).status,404);
 const saved=await copy(f),prior=(await old.preview(legacy,saved.bytes)).review;assert.equal(prior.formatVersion,7);assert.equal(prior.editable,false);assert.equal(prior.reason,'UNSUPPORTED_FORMAT_VERSION');
 const current=await preview(f,saved.bytes);assert.equal(current.review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:current.review.reviewId,reviewHash:current.review.reviewHash});
 const session=current.review.uiSessionIds[0],checkpoint=(await f.read('/api/v1/ui/'+session)).json,d=checkpoint.drafts[0],restored=(await f.read('/api/v1/ui/'+session+'/text?draftId='+d.id)).json;assert.deepEqual(restored.value,value);assert.equal((await binary(f,'/api/v1/ui/'+session+'/text?draftId='+d.id+'&content=1&generation='+d.generation)).bytes.toString(),text);
 const oldReview=(await preview(f,legacyCopy.bytes)).review;assert.equal(oldReview.formatVersion,5);assert.equal(oldReview.editable,true);await workspace(f,{type:'ImportBundle',reviewId:oldReview.reviewId,reviewHash:oldReview.reviewHash});const oldSession=oldReview.uiSessionIds[0],oldUI=(await f.read('/api/v1/ui/'+oldSession)).json;assert.deepEqual((await f.read('/api/v1/ui/'+oldSession+'/text?draftId='+oldUI.drafts[0].id)).json.value,legacyValue);
 const entries=await unpack(f.root,saved.bytes),manifest=JSON.parse(entries.get('manifest.json'));entries.set('manifest.json',encoded({...manifest,formatVersion:5,documentSchema:5}));const bad=await upload(f,await pack(f.root,entries));assert.equal((await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:bad.stagingId,expectedSha256:bad.sha256}}))).json.receipt.status,'rejected');
 t.diagnostic(JSON.stringify({priorCommit,legacy:legacyCopy.bundle.blob,current:saved.bundle.blob,priorRefusal:prior.reason,placement:value.placement,sourceBytes:Buffer.byteLength(text)}));
});
