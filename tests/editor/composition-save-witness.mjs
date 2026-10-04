import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {canonical,hashBytes,parseCommand} from '../../dist/local/server/storage/canonical.js';
import {compositionDraft,compositionDraftGraph} from '../../dist/local/src/composition/draft.js';

function object(root,ref){
 const objects=join(root,'objects','sha256');
 // Inherit verifier delegation without constructing a store or creating staging.
 const reader=Object.assign(Object.create(Objects.prototype),{check(){},objects});
 const bytes=reader.verify(ref,true);
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=JSON.parse(text);
 assert.equal(text,canonical(value),'Exact canonical object bytes');
 return {ref,bytes:bytes.length,sha256:hashBytes(bytes),text,value};
}
export function commandWitness(root,command){
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{const rows=db.prepare('SELECT original,receipt FROM commands WHERE id=?').all(command.commandId);assert.equal(rows.length,1);assert.deepEqual(parseCommand(Buffer.from(String(rows[0].original))).command,command);
 const receipt=JSON.parse(String(rows[0].receipt));assert.equal(receipt.status,'accepted');assert.equal(receipt.commandId,command.commandId);assert.equal(receipt.transactionId,command.transactionId);
 const documents=db.prepare('SELECT json FROM documents WHERE id=?').all(command.documentId);assert.equal(documents.length,1);const document=JSON.parse(String(documents[0].json));assert.equal(document.id,command.documentId);assert.equal(document.revision,receipt.documentRevision);
 return {command,receipt,document};
 }finally{db.close();}
}
export function acceptedComposition(root,commit,currentCommand=commit){
 const witness=commandWitness(root,currentCommand);assert.equal(commit.body.type,'CommitCompositionVersion');assert.equal(witness.document.compositionVersion,commit.body.composition.id);
 const composition=object(root,commit.body.composition.value);assert.equal(composition.value.id,commit.body.composition.id);assert.equal(composition.value.raw.length,1);
 return {...witness,composition,raw:object(root,composition.value.raw[0])};
}
export function draftWitness(root,owner,request){
 assert.equal(request.protocolVersion,1);assert.equal(request.sessionId,owner.sessionId);assert.equal(request.body.type,'SaveDraft');const draft=request.body.draft;
 assert.equal(draft.kind,'composition');assert.equal(draft.documentId,owner.documentId);assert.equal(draft.expectedDocumentRevision,owner.revision);assert.equal(draft.composing,false);assert.equal(draft.targetLayerId,null);
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{
  const receipts=db.prepare('SELECT hash,json FROM ui_receipts WHERE client_id=? AND id=?').all(owner.clientId,request.requestId);assert.equal(receipts.length,1,'One original UI receipt');assert.equal(receipts[0].hash,hashBytes(canonical(request)));const receipt=JSON.parse(String(receipts[0].json));assert.equal(receipt.requestId,request.requestId);assert.equal(receipt.status,'accepted');assert.equal(receipt.protocolVersion,1);
  const events=db.prepare('SELECT json FROM ui_events WHERE client_id=? AND session_id=? AND seq=?').all(owner.clientId,owner.sessionId,receipt.uiSeq);assert.equal(events.length,1);assert.deepEqual(JSON.parse(String(events[0].json)),request.body);
  const checkpoints=db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').all(owner.clientId,owner.sessionId);assert.equal(checkpoints.length,1);const checkpoint=JSON.parse(String(checkpoints[0].json));assert.equal(checkpoint.sessionId,owner.sessionId);assert(BigInt(checkpoint.uiSeq)>=BigInt(receipt.uiSeq));
  const matches=checkpoint.drafts.filter(d=>d.id===draft.id);assert.equal(matches.length,1);const selected=matches[0];assert.equal(selected.status,'saved-unapplied');for(const k of Object.keys(draft))assert.deepEqual(selected[k],draft[k]);
  const assets=db.prepare('SELECT json FROM assets WHERE id=?').all(draft.assetId);assert.equal(assets.length,1);const asset=JSON.parse(String(assets[0].json));assert.equal(asset.id,draft.assetId);
  const descriptor=object(root,asset.blob);compositionDraft(descriptor.value);const graph=object(root,descriptor.value.graph);compositionDraftGraph(graph.value,descriptor.value);assert.equal(graph.value.composition.frame.documentWidth,owner.width);assert.equal(graph.value.composition.frame.documentHeight,owner.height);
  return {owner:structuredClone(owner),request:structuredClone(request),receipt,checkpointSeq:checkpoint.uiSeq,selected,descriptor,graph};
 }finally{db.close();}
}
export function rawIdentity(request,expected){
 assert.equal(request.method(),'GET');assert.equal(request.url(),expected.url);assert.equal(request.redirectedFrom(),null);assert.equal(request.frame(),expected.frame);assert.equal(request.frame().page(),expected.page);
 const u=new URL(request.url());assert.equal(u.origin,expected.origin);assert.equal(u.pathname,'/api/v1/documents/'+expected.documentId+'/composition');assert.deepEqual([...u.searchParams],[['revision',expected.revision],['raw','0'],['offset','0']]);
 return {url:u.href,method:'GET',documentId:expected.documentId,revision:expected.revision,originalRequest:true,originalFrame:true,originalPage:true};
}
export function originalHold(route,expected){
 const request=route.request(),identity=rawIdentity(request,expected);let release,used=false;const wait=new Promise(r=>release=r),record={...identity,heldAt:Date.now(),releasedAt:null,continuedAt:null,continueError:null};
 const completion=(async()=>{await wait;assert.equal(route.request(),request);try{await route.continue();record.continuedAt=Date.now();}catch(e){record.continueError=String(e);throw e;}})();
 return {request,record,completion,release(){if(!used){used=true;record.releasedAt=Date.now();release();}}};
}
export function publicShortcutFocus(node){
 const rect=node.getBoundingClientRect();
 return {tag:node.tagName,label:node.getAttribute('aria-label'),tabIndex:node.tabIndex,active:node.ownerDocument.activeElement===node,connected:node.isConnected,visible:rect.width>0&&rect.height>0,editable:node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')||node.isContentEditable,at:Date.now()};
}
export function assertShortcutFocus(x){
 assert.equal(x.tag,'SECTION');assert.equal(x.label,'Operation status');assert.equal(x.tabIndex,0);assert.equal(x.active,true);assert.equal(x.connected,true);assert.equal(x.visible,true);assert.equal(x.editable,false);
}
export function downloadIdentity(request,expected){
 assert.equal(request.method(),'GET');assert.equal(request.url(),expected.url);assert.equal(request.redirectedFrom(),null);assert.equal(request.frame(),expected.frame);assert.equal(request.frame().page(),expected.page);
 const u=new URL(request.url());assert.equal(u.origin,expected.origin);assert.equal(u.pathname,'/api/v1/documents/'+expected.documentId+'/composition');assert.deepEqual([...u.searchParams],[['revision',expected.revision],['raw','0'],['download','1']]);
 return {url:u.href,method:'GET',documentId:expected.documentId,revision:expected.revision,originalRequest:true,originalFrame:true,originalPage:true};
}
export async function originalResponse(request,response){
 assert.equal(response.request(),request);assert.equal(response.status(),200);const bytes=await response.body(),finished=await response.finished();assert.equal(finished,null);
 return {status:response.status(),sameRequest:response.request()===request,finished,bytes:bytes.length,text:bytes.toString(),sha256:hashBytes(bytes),completedAt:Date.now()};
}
export async function observeSaveEdit(x,actions){
 assert.equal(x.actionSequence,undefined,'Observation sequence starts once');x.actionSequence=[];x.heldChecks=[];
 const held=phase=>{const released=x.held.releasedAt; x.heldChecks.push({phase,releasedAt:released});assert.equal(released,null,'Original request remains held at '+phase);};
 for(const name of ['edit','empty','before','release','raw','fresh','after']){
  x.actionSequence.push('start:'+name);if(['edit','empty','before','release'].includes(name))held(name);
  await actions[name]();
  if(name==='edit'){assert(x.edit,'Original input must be observed');assert.equal(x.edit.trusted,true);assert.equal(x.edit.value,x.intended);assert.equal(x.edit.documentId,x.owner.documentId);held('edited');}
  if(name==='empty'){assert.equal(x.rawEmpty.value,'');held('empty-observed');assert.equal(x.rawEmpty.held,true);}
  if(name==='before')held('before-saved');
  if(name==='release')assert.notEqual(x.held.releasedAt,null);
  if(name==='fresh')assert.equal(x.rawFresh.value,x.rawExpected);
  x.actionSequence.push('done:'+name);
 }
}
export function assertFreshRaw(x){
 assert.equal(x.rawEmpty.value,'');assert(x.rawEmpty.at>=x.held.heldAt&&x.rawEmpty.at<x.held.releasedAt);assert.equal(x.rawEmpty.held,true);
 assert.equal(x.download.originalRequest,true);assert.equal(x.download.originalFrame,true);assert.equal(x.download.originalPage,true);assert.equal(x.download.documentId,x.owner.documentId);assert.equal(x.download.revision,x.owner.revision);assert.notEqual(x.download.requestId,x.held.requestId);assert(x.download.requestAt>=x.held.releasedAt);
 for(const r of [x.raw,x.download]){assert.equal(r.status,200);assert.equal(r.sameRequest,true);assert.equal(r.finished,null);assert.equal(r.text,x.rawExpected);assert.equal(r.sha256,hashBytes(x.rawExpected));assert.equal(r.bytes,Buffer.byteLength(x.rawExpected));}
 assert.equal(x.rawFresh.value,x.rawExpected);assert(x.rawFresh.at>=x.raw.completedAt&&x.rawFresh.at>=x.download.completedAt);assert(x.afterAt>=x.rawFresh.at);
}
export function assessSaveControl(x){
 assert.deepEqual(x.actionSequence,['edit','empty','before','release','raw','fresh','after'].flatMap(n=>['start:'+n,'done:'+n]));assert.deepEqual(x.heldChecks,['edit','edited','empty','empty-observed','before','before-saved','release'].map(phase=>({phase,releasedAt:null})));
 assertShortcutFocus(x.shortcutFocus);assertFreshRaw(x);assert.equal(x.checkpoint.command.body.type,'SaveCheckpoint');for(const k of ['clientId','sessionId','documentId'])assert.equal(x.checkpoint.command[k],x.owner[k]);assert.equal(x.checkpoint.receipt.documentRevision,x.owner.revision);assert.equal(x.checkpoint.document.revision,x.owner.revision);
 assert.equal(x.held.originalRequest,true);assert.equal(x.held.originalFrame,true);assert.equal(x.held.originalPage,true);assert(x.held.heldAt<x.held.releasedAt);assert(x.held.continuedAt>=x.held.releasedAt);assert.equal(x.held.continueError,null);assert.equal(x.edit.trusted,true);assert.equal(x.edit.value,x.intended);assert.equal(x.edit.documentId,x.owner.documentId);
 assert.equal(x.raw.status,200);assert.equal(x.raw.sameRequest,true);assert.equal(x.raw.finished,null);assert.equal(x.raw.text,x.rawExpected);assert.equal(x.raw.sha256,hashBytes(x.rawExpected));
 assert.deepEqual(x.before.owner,x.owner);assert.deepEqual(x.after.owner,x.owner);assert.equal(x.before.selected.id,x.after.selected.id);assert.equal(x.before.selected.generation,x.after.selected.generation);assert.equal(x.before.request.requestId,x.after.request.requestId);assert.equal(x.before.graph.sha256,x.after.graph.sha256);assert.equal(x.beforeObservedHeld,true);assert(x.beforeAt<x.held.releasedAt);assert(x.afterAt>=x.held.continuedAt);
 assert.equal(x.cleanup.passed,true);assert.deepEqual(x.observationErrors,[]);assert.equal(x.unexpectedWorkers,0);assert.equal(x.acceptedBefore.composition.value.scene,x.acceptedAfter.composition.value.scene);assert.equal(x.acceptedBefore.composition.sha256,x.acceptedAfter.composition.sha256);
 const before=x.before.graph.value.composition.scene,after=x.after.graph.value.composition.scene;
 if(before===x.intended&&after===x.intended){assert.equal(x.beforePublicValue,x.intended,'GREEN original public Scene before release');assert.equal(x.afterPublicValue,x.intended,'GREEN fresh public Scene after response');}
 const reproduced=before!==x.intended&&after===before&&before===x.acceptedBefore.composition.value.scene;
 return {kind:reproduced?'VERIFIED-RED':before===x.intended&&after===x.intended?'GREEN':'INCONCLUSIVE',applicationAssertionPassed:before===x.intended&&after===x.intended,cleanupPassed:true,before,after,intended:x.intended,historical322CauseProved:false};
}
