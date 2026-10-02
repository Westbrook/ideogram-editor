import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {entity,event} from '../../dist/local/src/protocol/validate.js';
import {textBody,textSplitPlan,isTextCommand} from '../../dist/local/src/protocol/text.js';
import {historyBody} from '../../dist/local/src/protocol/history-validation.js';
import {isHistoryCommand} from '../../dist/local/src/protocol/history.js';

const ref=text=>({hash:'sha256:'+createHash('sha256').update(text).digest('hex'),byteLength:String(Buffer.byteLength(text)),mediaType:'application/json'});
function fixture(){
 const before={state:ref('before'),semanticDigest:ref('before-digest').hash,compositeAssetId:null},after={state:ref('after'),semanticDigest:ref('after-digest').hash,compositeAssetId:'native_composite'},forward=ref('forward'),inverse=ref('inverse');
 const history={id:'native_history',documentId:'document',branchId:'branch',parent:'created_history',revision:'2',kind:'image-edit',operation:'CreateTextFromReturnedDescription',before,after,forward,inverse,roots:[before.state,after.state,forward,inverse]};
 const document={id:'document',revision:'2',branchId:'branch',width:64,height:32,color:'sRGB',depth:8,orderedLayerIds:['returned_text'],historyHead:history.id,checkpoint:null,compositionVersion:null,image:after,redo:null};
 return {schemaVersion:1,payloadVersion:1,eventId:'native_event',workspaceSeq:'7',streamId:'document',streamSeq:'2',documentId:'document',resultingDocumentRevision:'2',commandId:'native_command',correlationId:'correlation',causationId:null,transactionId:'native_transaction',writerEpoch:'1',recordedAt:'2026-09-30T00:00:00.000Z',type:'ImageEdited',payload:{document,history}};
}
test('reviewed returned-description creation is a valid durable history entity and ImageEdited event',()=>{
 const value=fixture();assert.equal(entity('history',value.payload.history),'2');assert.doesNotThrow(()=>event(value));
});
test('returned-description history keeps exact operation, root and event correspondence checks',()=>{
 for(const operation of ['CreateTextFromReturnedDescriptionV2','CreateTextFromDescription','ApproveReturnedDescription']){const value=fixture();value.payload.history.operation=operation;assert.throws(()=>entity('history',value.payload.history));assert.throws(()=>event(value));}
 for(const mutate of [value=>value.payload.history.roots.pop(),value=>value.payload.history.descriptionAuthority=true,value=>value.payload.history.adoptedLineage=ref('unauthorized-lineage'),value=>value.payload.history.after={...value.payload.history.after,state:ref('different-after')},value=>value.payload.history.documentId='other_document']){const value=fixture();mutate(value);assert.throws(()=>event(value));}
});

// These are protocol-shape specimens. Retained UTF-8, grapheme boundaries,
// candidate contents, rendered pixels and writer authority require backend proof.
const splitRef=(text,mediaType='application/json')=>({...ref(text),mediaType});
function splitPlanFixture(count=2,mediaType='text/plain'){
 return {kind:'text-split-plan-1',originalText:splitRef('x'.repeat(count),mediaType),parts:Array.from({length:count},(_,index)=>({layerId:'split_'+index,name:'Text '+(index+1),startByte:index,endByte:index+1,candidate:splitRef(JSON.stringify({part:index})),offset:{x:0,y:index*32},reviewedDependencyHash:ref('dependency-'+index).hash,reviewedRasterHash:ref('raster-'+index).hash}))};
}
function splitSelectionFixture(){
 return {kind:'returned-description-selection-1',jobId:'returned_job',attemptId:'returned_attempt',returnedPrompt:splitRef('{"retained":"caption"}','text/plain'),elementIndex:0,elementHash:ref('selected-element').hash,placementChoice:'keep-both',duplicationAcknowledged:true};
}
function splitCommandFixture(){
 const plan=splitRef(JSON.stringify(splitPlanFixture()));
 return {type:'SplitTextDraft',draft:{sessionId:'session',draftId:'draft',generation:'1'},sourceLayer:null,plan,reviewedPlanHash:plan.hash};
}

test('SplitTextDraft registers one exact reviewed plan command for new and existing text drafts',()=>{
 assert.equal(isTextCommand('SplitTextDraft'),true);assert.equal(isHistoryCommand('SplitTextDraft'),true);
 for(const sourceLayer of [null,{layerId:'split_0',layerVersion:'8'}]){
  const body={...splitCommandFixture(),sourceLayer},original=structuredClone(body);
  assert.doesNotThrow(()=>textBody(body));assert.doesNotThrow(()=>historyBody(body));assert.deepEqual(body,original);
 }
 const boundary=splitCommandFixture();boundary.plan=splitRef(' '.repeat(65536));boundary.reviewedPlanHash=boundary.plan.hash;
 assert.doesNotThrow(()=>historyBody(boundary));
 const value=fixture();value.payload.history.operation='SplitTextDraft';assert.equal(entity('history',value.payload.history),'2');assert.doesNotThrow(()=>event(value));
 for(const operation of ['SplitTextDraftV2','SplitTextLayer']){const invalid=fixture();invalid.payload.history.operation=operation;assert.throws(()=>event(invalid));}
});

test('SplitTextDraft rejects missing and extra fields, wrong plan references, and invalid draft or source fences',()=>{
 for(const field of ['type','draft','sourceLayer','plan','reviewedPlanHash']){const body=splitCommandFixture();delete body[field];assert.throws(()=>historyBody(body),field);}
 const changes={
  'extra command field':b=>{b.candidate=ref('{}');},
  'reviewed hash mismatch':b=>{b.reviewedPlanHash=ref('other-plan').hash;},
  'reviewed hash malformed':b=>{b.reviewedPlanHash='bad';},
  'wrong plan media':b=>{b.plan.mediaType='text/plain';},
  'oversized plan':b=>{b.plan.byteLength='65537';},
  'noncanonical plan size':b=>{b.plan.byteLength='01';},
  'missing plan hash':b=>{delete b.plan.hash;},
  'extra plan field':b=>{b.plan.inline={};},
  'missing source version':b=>{b.sourceLayer={layerId:'split_0'};},
  'wrong source identifier':b=>{b.sourceLayer={layerId:'bad/id',layerVersion:'1'};},
  'wrong source version':b=>{b.sourceLayer={layerId:'split_0',layerVersion:1};},
  'extra source field':b=>{b.sourceLayer={layerId:'split_0',layerVersion:'1',locked:false};},
  'null draft':b=>{b.draft=null;},
  'missing draft generation':b=>{delete b.draft.generation;},
  'wrong draft identifier':b=>{b.draft.draftId='bad/id';},
  'wrong draft session':b=>{b.draft.sessionId='';},
  'wrong draft generation':b=>{b.draft.generation='-1';},
  'extra draft field':b=>{b.draft.layerId='split_0';},
 };
 for(const [label,change] of Object.entries(changes)){const body=splitCommandFixture();change(body);assert.throws(()=>textBody(body),label);assert.throws(()=>historyBody(body),label);}
});

test('text split plans accept 2 through 100 parts, both exact text media types and returned selection for over-limit text',()=>{
 for(const count of [2,100])for(const mediaType of ['text/plain','text/plain;charset=utf-8']){
  const plan=splitPlanFixture(count,mediaType),original=structuredClone(plan);assert.doesNotThrow(()=>textSplitPlan(plan));assert.deepEqual(plan,original);
 }
 const plan=splitPlanFixture();plan.originalText=splitRef('x'.repeat(16384)+'y','text/plain;charset=utf-8');plan.parts[0].endByte=16384;plan.parts[1].startByte=16384;plan.parts[1].endByte=16385;
 plan.parts[0].name='é'.repeat(512);plan.parts[0].candidate=splitRef(' '.repeat(65536));plan.description=splitSelectionFixture();
 const original=structuredClone(plan);assert.doesNotThrow(()=>textSplitPlan(plan));assert.deepEqual(plan,original);
 plan.description.returnedPrompt={...plan.description.returnedPrompt,mediaType:'text/plain;charset=utf-8',byteLength:'262144'};assert.doesNotThrow(()=>textSplitPlan(plan));
});

test('text split plans reject duplicate IDs, holes, overlap, missing coverage and unsafe ranges',()=>{
 const changes={
  'wrong kind':p=>{p.kind='text-split-plan-2';},
  'extra plan field':p=>{p.schemaVersion=1;},
  'no parts':p=>{p.parts=[];},
  'one part':p=>{p.parts.pop();p.originalText=splitRef('x','text/plain');},
  'too many parts':p=>{p.parts=splitPlanFixture(101).parts;p.originalText=splitRef('x'.repeat(101),'text/plain');},
  'duplicate ID':p=>{p.parts[1].layerId=p.parts[0].layerId;},
  'invalid ID':p=>{p.parts[1].layerId='bad/id';},
  'initial gap':p=>{p.parts[0].startByte=1;},
  'negative start':p=>{p.parts[0].startByte=-1;},
  'zero range':p=>{p.parts[0].endByte=0;},
  'range hole':p=>{p.parts[1].startByte=2;p.parts[1].endByte=3;p.originalText=splitRef('xxx','text/plain');},
  'range overlap':p=>{p.parts[1].startByte=0;},
  'incomplete original':p=>{p.originalText=splitRef('xxx','text/plain');},
  'overshooting original':p=>{p.originalText=splitRef('x','text/plain');},
  'fractional start':p=>{p.parts[1].startByte=0.5;},
  'fractional end':p=>{p.parts[1].endByte=2.5;},
  'nonfinite end':p=>{p.parts[1].endByte=Infinity;},
  'unsafe end':p=>{p.parts[1].endByte=Number.MAX_SAFE_INTEGER+1;p.originalText.byteLength=String(Number.MAX_SAFE_INTEGER+1);},
  'rounded original size':p=>{p.originalText.byteLength='9007199254740993';},
  'missing range':p=>{delete p.parts[1].endByte;},
  'extra part field':p=>{p.parts[0].text='x';},
 };
 for(const [label,change] of Object.entries(changes)){const plan=splitPlanFixture();change(plan);assert.throws(()=>textSplitPlan(plan),label);}
});

test('text split plans require bounded metadata, reviewed hashes, zero first offset and exact selection shape',()=>{
 const changes={
  'unsupported original media':p=>{p.originalText.mediaType='text/html';},
  'missing original reference':p=>{delete p.originalText;},
  'extra original field':p=>{p.originalText.charset='utf-8';},
  'empty name':p=>{p.parts[0].name='';},
  'oversized UTF-8 name':p=>{p.parts[0].name='é'.repeat(513);},
  'wrong candidate media':p=>{p.parts[0].candidate.mediaType='text/plain';},
  'oversized candidate':p=>{p.parts[0].candidate.byteLength='65537';},
  'missing candidate hash':p=>{delete p.parts[0].candidate.hash;},
  'wrong dependency hash':p=>{p.parts[0].reviewedDependencyHash='bad';},
  'wrong raster hash':p=>{p.parts[0].reviewedRasterHash='bad';},
  'missing reviewed hash':p=>{delete p.parts[0].reviewedRasterHash;},
  'first x offset':p=>{p.parts[0].offset.x=1;},
  'first y offset':p=>{p.parts[0].offset.y=1;},
  'nonfinite offset':p=>{p.parts[1].offset.x=NaN;},
  'wrong offset type':p=>{p.parts[1].offset.y='32';},
  'extra offset field':p=>{p.parts[1].offset.unit='px';},
  'null selection':p=>{p.description=null;},
  'wrong selection kind':p=>{p.description.kind='returned-description-review-1';},
  'selection carries old literal review':p=>{p.description.literal=p.originalText;},
  'unacknowledged selection':p=>{p.description.duplicationAcknowledged=false;},
  'invalid selection index':p=>{p.description.elementIndex=256;},
  'unsupported selection media':p=>{p.description.returnedPrompt.mediaType='application/json';},
  'oversized selection source':p=>{p.description.returnedPrompt.byteLength='262145';},
 };
 for(const [label,change] of Object.entries(changes)){const plan=splitPlanFixture();plan.description=splitSelectionFixture();change(plan);assert.throws(()=>textSplitPlan(plan),label);}
});
