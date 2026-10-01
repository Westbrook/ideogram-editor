import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {savedState} from './completion-public.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ie-saved-owner-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=new DatabaseSync(join(root,'metadata.sqlite'));for(const table of ['documents','history','ui_checkpoints','assets'])db.exec('CREATE TABLE '+table+'(json TEXT NOT NULL)');
 t.after(()=>db.close());const insert=(table,value)=>db.prepare('INSERT INTO '+table+'(json) VALUES(?)').run(JSON.stringify(value));
 const object=async(value,mediaType='application/json')=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),hash='sha256:'+createHash('sha256').update(bytes).digest('hex'),directory=join(root,'objects','sha256',hash.slice(7,9));await mkdir(directory,{recursive:true});await writeFile(join(directory,hash.slice(7)),bytes);return {hash,byteLength:String(bytes.length),mediaType};};
 const text=await object('Exact imported text','text/plain'),draftBlob=await object({schemaVersion:1,kind:'text-draft-1',textUtf8:text});insert('assets',{id:'caption',blob:draftBlob});
 const imageA=await object({layers:[{id:'source-layer'}]}),imageB=await object({layers:[{id:'imported-layer'}]});
 const source={id:'original',revision:'40',image:{state:imageA}},imported={id:'p_imported',revision:'7',image:{state:imageB}};
 const draft={id:'native-draft',kind:'text',documentId:imported.id,expectedDocumentRevision:'7',assetId:'caption',generation:'1',status:'saved-unapplied'};
 return {root,db,insert,source,imported,draft,imageB};
}
test('completion observer resolves imported native owner from its unique saved draft among several documents',async t=>{
 const f=await fixture(t);f.insert('documents',f.source);f.insert('documents',f.imported);f.insert('documents',{id:'p_other',revision:'1'});f.insert('ui_checkpoints',{sessionId:'active-session',preferences:{documentId:f.source.id},drafts:[f.draft]});
 const saved=savedState(f.root,f.draft.id);assert.deepEqual(saved.document,f.imported);assert.equal(saved.draft.ui.sessionId,'active-session');assert.equal(saved.savedText,'Exact imported text');assert.equal(saved.accepted.documents.length,3);assert.equal(saved.accepted.imageSHA256,f.imageB.hash.slice(7));
});
test('single-document fallback remains available after the draft was deliberately cleared',async t=>{
 const f=await fixture(t);f.insert('documents',f.source);f.insert('ui_checkpoints',{sessionId:'active-session',drafts:[]});const saved=savedState(f.root,f.draft.id);assert.deepEqual(saved.document,f.source);assert.equal(saved.draft,null);assert.equal(saved.savedText,null);
});
test('missing draft across several documents never guesses from a current preference or row order',async t=>{
 const f=await fixture(t);f.insert('documents',f.source);f.insert('documents',f.imported);f.insert('ui_checkpoints',{sessionId:'active-session',preferences:{documentId:f.imported.id},drafts:[]});const saved=savedState(f.root,f.draft.id);assert.equal(saved.document,undefined);assert.equal(saved.draft,null);assert.equal(saved.accepted.imageSHA256,null);
});
test('ambiguous saved draft ownership remains refused even when only one document exists',async t=>{
 const f=await fixture(t);f.insert('documents',f.imported);for(const sessionId of ['one','two'])f.insert('ui_checkpoints',{sessionId,drafts:[f.draft]});const saved=savedState(f.root,f.draft.id);assert.equal(saved.document,undefined);assert.equal(saved.draft,null);assert.equal(saved.savedText,null);
});
test('a saved draft referencing a missing document cannot fall back to the unrelated sole document',async t=>{
 const f=await fixture(t);f.insert('documents',f.source);f.insert('ui_checkpoints',{sessionId:'active-session',drafts:[f.draft]});const saved=savedState(f.root,f.draft.id);assert.equal(saved.document,undefined);assert.equal(saved.draft.draft.documentId,f.imported.id);assert.equal(saved.accepted.imageSHA256,null);
});
test('duplicate JSON document identities cannot produce an arbitrary native owner',async t=>{
 const f=await fixture(t);f.insert('documents',f.imported);f.insert('documents',{...f.imported,revision:'8'});f.insert('ui_checkpoints',{sessionId:'active-session',drafts:[f.draft]});assert.equal(savedState(f.root,f.draft.id).document,undefined);
});
