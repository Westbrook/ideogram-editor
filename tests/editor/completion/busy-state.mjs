import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {document as validateDocument} from '../../../dist/local/src/protocol/validate.js';
import {imageState} from '../../../dist/local/src/protocol/history-validation.js';
import {canonical,hashBytes,parseCommand} from '../../../dist/local/server/storage/canonical.js';
import {Objects} from '../../../dist/local/server/storage/objects.js';

// Read-only witness for this held-save fixture. Other workflows still require image state.
export function busyStateObserver({root,origin,request,created,held}) {
 assert(request&&held());assert.equal(request.method(),'POST');assert.equal(request.url(),origin+'/api/v1/commands');
 const original=request,command=parseCommand(Buffer.from(request.postData())).command,creation=structuredClone(created);
 assert.equal(command.body.type,'SaveCheckpoint');assert(['NewDocument','CreateDocument'].includes(creation.body.type),'Known document creation command');assert.equal(creation.expectedDocumentRevision,null);
 assert.equal(command.documentId,creation.documentId);assert.equal(command.clientId,creation.clientId);assert.equal(command.sessionId,creation.sessionId);
 return () => {
  assert(held(),'Original checkpoint still held');assert.equal(request,original);assert.equal(request.method(),'POST');assert.equal(request.url(),origin+'/api/v1/commands');assert.deepEqual(parseCommand(Buffer.from(request.postData())).command,command);
  const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
  try {
   const rows=db.prepare('SELECT id,json FROM documents').all();assert.equal(rows.length,1,'One created busy document');
   const row=rows[0],document=JSON.parse(String(row.json));validateDocument(document);assert.equal(row.id,document.id);assert.equal(document.id,creation.documentId);assert.equal(document.id,command.documentId);assert.equal(document.revision,command.expectedDocumentRevision);
   for(const key of ['width','height'])assert.equal(document[key],creation.body[key],'Created document '+key);
   if(creation.body.type==='CreateDocument'){
    assert.equal(creation.body.background.kind,'transparent','Busy text fixture starts transparent');assert.equal(document.color,'sRGB');assert.equal(document.depth,8);
    assert.deepEqual(document.metadata,{schemaVersion:1,name:creation.body.name,creationBackground:creation.body.background},'Exact authored document metadata');
   }else for(const key of ['color','depth'])assert.equal(document[key],creation.body[key],'Created document '+key);
   const receipts=db.prepare('SELECT original,receipt FROM commands WHERE id=?').all(creation.commandId);assert.equal(receipts.length,1,'Original creation receipt');
   assert.deepEqual(parseCommand(Buffer.from(String(receipts[0].original))).command,creation);const receipt=JSON.parse(String(receipts[0].receipt));assert.equal(receipt.status,'accepted');assert.equal(receipt.commandId,creation.commandId);assert.equal(receipt.transactionId,creation.transactionId);
   let image;
   if(Object.hasOwn(document,'image')){
    const ref=document.image.state,objects=join(root,'objects','sha256');
    const bytes=Objects.prototype.verify.call({check(){},objects,path:r=>join(objects,r.hash.slice(7,9),r.hash.slice(7))},ref,true);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);image=JSON.parse(text);imageState(image);assert.equal(canonical(image),text);assert.equal(hashBytes(canonical({...image,layers:image.layers.map(({version,...layer})=>layer)})),document.image.semanticDigest);
   }else image={schemaVersion:1,width:document.width,height:document.height,layers:[]};
   imageState(image);assert.equal(image.width,document.width);assert.equal(image.height,document.height);assert.deepEqual(image.layers.map(layer=>layer.id),document.orderedLayerIds);
   return {document,image,creation:{command:creation,receipt},heldCommand:command};
  }finally{db.close();}
 };
}
