import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {inspectReturnedDescription,makeReturnedDescriptionReview,verifyReturnedDescriptionReview,validateReturnedDescriptionReview,approximateReturnedTextBox,returnedDescriptionSelection,validateReturnedDescriptionSelection} from '../../dist/local/src/text/returned-description.js';
import {textDraft,draftRefs,textBody} from '../../dist/local/src/protocol/text.js';
import {assertReturnedDescriptionOwner} from '../../dist/local/server/storage/returned-description.js';

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const ref=(value,mediaType='text/plain')=>{const bytes=Buffer.from(value);return {hash:digest(bytes),byteLength:String(bytes.length),mediaType};};
const caption=text=>JSON.stringify({high_level_description:'A sign',compositional_deconstruction:{background:'plain',elements:[{type:'text',bbox:[100,200,300,800],text,desc:'blue lettering'}]}});
function fixture(text='Cafe\u0301 東京 <b>literal</b>'){
 const bytes=Buffer.from(caption(text)),inspection=inspectReturnedDescription(bytes);assert.equal(inspection.state,'available');
 const selected=inspection.elements[0],source={schemaVersion:1,text:{textUtf8:ref(text),frame:{width:120,height:40},style:{primaryFont:'font-test',explicitFallbacks:[],sizePx:16,lineHeightMultiplier:1.2,fill:[20,40,180,255],align:'start',direction:'auto'},fonts:[]}};
 const review=makeReturnedDescriptionReview({id:'review_1',jobId:'job_1',attemptId:'attempt_1',returnedPrompt:ref(bytes),elementIndex:selected.index,elementHash:selected.elementHash,documentId:'document_1',documentRevision:'4',literal:source.text.textUtf8,frame:source.text.frame,placement:{x:10,y:20},style:source.text.style,fonts:source.text.fonts,placementChoice:'keep-both',duplicationAcknowledged:true});
 return {bytes,selected,source,review};
}
const reseal=value=>{const {hash,...binding}=value;return {...binding,hash:digest(canonical(binding))};};

test('returned description remains literal and independently reviewed; no markup or Unicode normalization',()=>{
 const x=fixture();assert.equal(x.selected.literal,'Cafe\u0301 東京 <b>literal</b>');
 assert.equal(verifyReturnedDescriptionReview(x.review,x.bytes,x.source).literal,x.selected.literal);
 assert.equal(x.review.returnedPrompt.hash,digest(x.bytes));assert(!Object.hasOwn(x.review,'imageSafety'));
 assert.deepEqual(approximateReturnedTextBox(x.selected.box,1000,500),{placement:{x:200,y:50},frame:{width:600,height:100},approximate:true});
});
test('plain, malformed, duplicate-key, unsupported and oversized descriptions expose no create-text selection',()=>{
 for(const bytes of [Buffer.from('plain prose'),Buffer.from('{'),Buffer.from(caption('A').replace('"text":"A"','"text":"A","text":"B"')),Buffer.from(caption('A').replace('"desc":"blue lettering"','"desc":"blue lettering","url":"https://example.invalid"')),Buffer.alloc(262145,32)])assert.equal(inspectReturnedDescription(bytes).state,'unavailable');
});
test('review binds exact original bytes, selected element, local literal/font/style/geometry and acknowledgement',()=>{
 const x=fixture();for(const patch of [{elementHash:'sha256:'+'0'.repeat(64)},{literal:ref('different')},{styleHash:'sha256:'+'0'.repeat(64)},{fontsHash:'sha256:'+'0'.repeat(64)},{frame:{width:121,height:40}}])assert.throws(()=>verifyReturnedDescriptionReview(reseal({...x.review,...patch}),x.bytes,x.source));
 assert.throws(()=>verifyReturnedDescriptionReview(x.review,Buffer.from(caption('changed')),x.source));
 assert.throws(()=>validateReturnedDescriptionReview(reseal({...x.review,duplicationAcknowledged:false})));
 assert.throws(()=>validateReturnedDescriptionReview({...x.review,placement:{x:11,y:20}}));
});
test('explicitly changed literal is allowed only with the matching local prepared source',()=>{
 const x=fixture(),literal=ref('User chose another literal');x.source.text.textUtf8=literal;
 const reviewed=reseal({...x.review,literal});assert.equal(verifyReturnedDescriptionReview(reviewed,x.bytes,x.source).literal,x.selected.literal);
 assert.notEqual(reviewed.literal.hash,ref(x.selected.literal).hash);
});
test('local owner proof rejects missing, partial, quarantined, changed, V45 and stale returned provenance',t=>{
 const x=fixture(),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE candidate_jobs(job_id TEXT,json TEXT);CREATE TABLE candidate_document_tombstones(document_id TEXT);CREATE TABLE portable_rows(kind TEXT,id TEXT,json TEXT)');
 const provenance={complete:true,quarantined:false,inspection:'supported',returnedPrompt:x.review.returnedPrompt},record={jobId:'job_1',attemptId:'attempt_1',documentId:'document_1',provenance},target={id:'document_1',revision:'4'};
 assert.throws(()=>assertReturnedDescriptionOwner(db,x.review,target));
 const put=value=>{db.exec('DELETE FROM candidate_jobs');db.prepare('INSERT INTO candidate_jobs VALUES (?,?)').run('attempt_1',JSON.stringify(value));};put(record);assert.doesNotThrow(()=>assertReturnedDescriptionOwner(db,x.review,target));
 for(const patch of [{complete:false},{quarantined:true},{inspection:'opaque'},{schemaVersion:2,returnedPrompt:null},{returnedPrompt:ref('changed')}]){put({...record,provenance:{...provenance,...patch}});assert.throws(()=>assertReturnedDescriptionOwner(db,x.review,target));}
 put(record);assert.throws(()=>assertReturnedDescriptionOwner(db,x.review,{...target,revision:'5'}));
 db.prepare('INSERT INTO candidate_document_tombstones VALUES (?)').run(target.id);assert.throws(()=>assertReturnedDescriptionOwner(db,x.review,target));
});
test('imported supported caption observations permit only explicit new local creation, without a live job',t=>{
 const x=fixture(),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE candidate_jobs(job_id TEXT,json TEXT);CREATE TABLE candidate_document_tombstones(document_id TEXT);CREATE TABLE portable_rows(kind TEXT,id TEXT,json TEXT)');
 db.prepare('INSERT INTO portable_rows VALUES (?,?,?)').run('job-result','attempt_1',JSON.stringify({jobId:'job_1',documentId:'document_1',inert:true,provenance:{complete:true,quarantined:false,inspection:'supported',returnedPrompt:x.review.returnedPrompt}}));
 assert.doesNotThrow(()=>assertReturnedDescriptionOwner(db,x.review,{id:'document_1',revision:'4'}));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_jobs').get().n,0);
});
test('approximate box validates the complete normalized tuple before suggesting local geometry',()=>{
 for(const box of [undefined,{},[],[0,0,1000],[0,0,1000,1000,1],[0,0,NaN,1000],[0,0,Infinity,1000],[-1,0,1000,1000],[0,0,1001,1000],[0,0,1000,1000.5],[500,0,100,1000],[0,500,1000,100],[0,0,0,1000],[0,0,1000,0],['0',0,1000,1000]])assert.throws(()=>approximateReturnedTextBox(box,640,480));
 assert.deepEqual(approximateReturnedTextBox(null,640,480),{placement:{x:0,y:0},frame:{width:360,height:180},approximate:true});
 assert.deepEqual(approximateReturnedTextBox([0,0,1000,1000],640,480),{placement:{x:0,y:0},frame:{width:640,height:480},approximate:true});
});

test('recoverable selection retains exact caption identity but carries no document, style or writer approval',()=>{
 const x=fixture(),selection=returnedDescriptionSelection(x.review);validateReturnedDescriptionSelection(selection);
 assert.deepEqual(selection,{kind:'returned-description-selection-1',jobId:x.review.jobId,attemptId:x.review.attemptId,returnedPrompt:x.review.returnedPrompt,elementIndex:x.review.elementIndex,elementHash:x.review.elementHash,placementChoice:'keep-both',duplicationAcknowledged:true});
 for(const field of ['documentId','documentRevision','literal','styleHash','fontsHash','hash','id'])assert(!Object.hasOwn(selection,field));
 assert.throws(()=>validateReturnedDescriptionReview(selection));
 for(const patch of [{duplicationAcknowledged:false},{elementIndex:-1},{elementIndex:256},{placementChoice:'hide-original'},{elementHash:'bad'},{returnedPrompt:{...selection.returnedPrompt,byteLength:'262145'}},{documentRevision:'9'}])assert.throws(()=>validateReturnedDescriptionSelection({...selection,...patch}));
});

test('draft3 retains exact returned intent and full literal closure without changing legacy draft schemas',()=>{
 const x=fixture(),description=returnedDescriptionSelection(x.review),common={textUtf8:x.source.text.textUtf8,style:x.source.text.style,frame:x.source.text.frame,fonts:[]},legacy={schemaVersion:1,kind:'text-draft-1',...common},placed={schemaVersion:2,kind:'text-draft-2',...common,placement:{x:3,y:4}},described={schemaVersion:3,kind:'text-draft-3',...common,placement:{x:8,y:9},description};
 const originals=[legacy,placed,described].map(canonical);for(const draft of [legacy,placed,described])textDraft(draft);assert.deepEqual([legacy,placed,described].map(canonical),originals);
 assert.deepEqual(draftRefs(legacy),[common.textUtf8]);assert.deepEqual(draftRefs(placed),[common.textUtf8]);assert.deepEqual(draftRefs(described),[common.textUtf8,description.returnedPrompt]);
 for(const value of [{...described,schemaVersion:2},{...placed,description},{...legacy,description},{...described,description:{...description,duplicationAcknowledged:false}},{...described,placement:{x:NaN,y:0}},{...described,extra:true}])assert.throws(()=>textDraft(value));
 const {description:removed,...missing}=described;assert.throws(()=>textDraft(missing));
 // Saving incomplete local font/style choices is recovery, never Apply admission.
 const unfinished={...described,style:{localChoice:'unfinished'},frame:{width:'unfinished',height:20},textUtf8:ref('Changed local literal')};textDraft(unfinished);assert.deepEqual(unfinished.description,description);
});

test('final command requires the complete re-bound review instead of recoverable selection',()=>{
 const x=fixture(),selection=returnedDescriptionSelection(x.review),body={type:'CreateTextFromReturnedDescription',layerId:'new_text',name:'Reviewed text',candidate:ref('{}','application/json'),draft:{sessionId:'session',draftId:'draft',generation:'1'},admissionId:'admission',placement:x.review.placement,description:x.review};
 textBody(body);assert.throws(()=>textBody({...body,description:selection}));assert.throws(()=>textBody({...body,placement:{x:99,y:20}}));
 const changed={...x.source,text:{...x.source.text,textUtf8:ref('Changed local literal'),style:{...x.source.text.style,sizePx:24},fonts:[{selected:'new local font'}]}};
 assert.throws(()=>verifyReturnedDescriptionReview(x.review,x.bytes,changed));
 const {kind,...intent}=selection,final=makeReturnedDescriptionReview({...intent,id:'final_review',documentId:'document_1',documentRevision:'5',literal:changed.text.textUtf8,frame:changed.text.frame,placement:{x:13,y:21},style:changed.text.style,fonts:changed.text.fonts});
 assert.equal(verifyReturnedDescriptionReview(final,x.bytes,changed).literal,x.selected.literal);assert.notEqual(final.literal.hash,x.review.literal.hash);assert.notEqual(final.styleHash,x.review.styleHash);assert.notEqual(final.fontsHash,x.review.fontsHash);assert.notEqual(final.hash,x.review.hash);assert.deepEqual(returnedDescriptionSelection(final),selection);
});
