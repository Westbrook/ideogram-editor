// Test-only public font selection and coherent pre-action draft capture.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {savedState} from './completion-public.mjs';
import {canonical} from '../../../dist/local/server/storage/canonical.js';
import {inspectFont} from '../../../dist/local/server/text/font.js';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const ref=(b,mediaType)=>({hash:hash(b),byteLength:String(b.length),mediaType});
export function bundledFontIntent(id,source,text){
 const profile=JSON.parse(readFileSync('src/text/profile.json')),entry=profile.fonts.find(f=>f.id===id);assert(entry,'Pinned bundled font');
 const bytes=readFileSync(join('vendor/text',entry.file)),license=readFileSync(join('vendor/text',entry.licenseFile));assert.equal(hash(bytes),'sha256:'+entry.sha256);assert.equal(bytes.length,entry.bytes);assert.equal(hash(license),entry.licenseHash);
 const inspected=inspectFont(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 const value={schemaVersion:1,bytes:ref(bytes,'application/octet-stream'),faceIndex:0,format:inspected.format,parserProfile:inspected.parserProfile,fsType:inspected.fsType,licenseRecord:ref(license,'text/plain'),origin:'bundled',embedding:'permitted'},font={...value,id:hash(canonical(value))};
 return {text,graph:{schemaVersion:1,kind:'text-draft-1',textUtf8:ref(Buffer.from(text),'text/plain'),style:{...structuredClone(source.style),primaryFont:font.bytes.hash,explicitFallbacks:[]},frame:structuredClone(source.frame),fonts:[font]},fontId:id};
}
export function readNativeState(root,draftId){
 const state=savedState(root,draftId);if(!state.draft)return {...state,savedGraph:null};
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{
  const asset=db.prepare('SELECT json FROM assets WHERE id=?').get(state.draft.draft.assetId);assert(asset,'Saved draft asset');const blob=JSON.parse(String(asset.json)).blob;
  const bytes=readFileSync(join(root,'objects/sha256',blob.hash.slice(7,9),blob.hash.slice(7)));assert.equal(String(bytes.length),blob.byteLength);assert.equal(hash(bytes),blob.hash);
  return {...state,savedGraph:JSON.parse(bytes.toString('utf8'))};
 }finally{db.close();}
}
export function nativeDescriptor(el){const r=el.closest('#native-text-editor');return {sameTextarea:el===document.querySelector('#native-text-content'),connected:el.isConnected,editable:!el.disabled&&!el.readOnly,draftId:r?.getAttribute('data-session'),revision:r?.getAttribute('data-revision'),value:el.value,ready:r?.textContent?.includes('Text preview ready. Accepted appearance is unchanged.')??false};}
function publicOwner(view,draftId){assert(typeof draftId==='string'&&draftId.length>0,'Public draft identity');assert(view.sameTextarea&&view.connected&&view.editable,'Same connected editable textarea');assert.equal(view.draftId,draftId,'Original public draft');assert(/^\d+$/.test(view.revision),'Public revision');}
function ownerOf(saved,draftId){assert(saved.document&&saved.draft?.ui?.sessionId&&saved.draft.draft,'Saved owner exists');assert.equal(saved.draft.draft.id,draftId,'Saved draft identity');assert.equal(saved.draft.draft.documentId,saved.document.id,'Saved document identity');assert.equal(saved.draft.draft.expectedDocumentRevision,saved.document.revision,'Saved document revision');return {draftId,documentId:saved.document.id,documentRevision:saved.document.revision,sessionId:saved.draft.ui.sessionId};}
export async function adoptNativeInput({expect,observe,read,intent}){
 const initial=await observe();publicOwner(initial,initial.draftId);const first=read(initial.draftId),owner=intent?.owner??ownerOf(first,initial.draftId);assert.equal(owner.draftId,initial.draftId,'Intended public draft');
 const text=intent?.text??initial.value;let permanent;
 const matching=s=>{try{assert.equal(s.document?.id,owner.documentId,'Original document identity');assert.equal(s.document?.revision,owner.documentRevision,'Original document revision');if(!s.draft)return false;assert.deepEqual(ownerOf(s,initial.draftId),owner,'Original document/session/draft owner');return s.savedText===text&&s.draft.draft.status==='saved-unapplied'&&(!intent||isDeepStrictEqual(s.savedGraph,intent.graph));}catch(error){permanent??=error;throw error;}};
 matching(first);
 await expect.poll(()=>{if(permanent)throw permanent;return matching(read(initial.draftId));}).toBe(true);if(permanent)throw permanent;
 const saved=read(initial.draftId);assert(matching(saved),'Full intended saved graph');
 const before=await observe();publicOwner(before,initial.draftId);assert.equal(before.value,text,'Current intended text');assert.equal(before.ready,initial.ready,'No intervening public operation');
 const final=read(initial.draftId);assert(matching(final),'Final intended saved graph');assert.deepEqual(final,saved,'Saved state unchanged across refreshed public descriptor');
 assert(Number.isSafeInteger(Number(final.draft.draft.generation))&&Number(final.draft.draft.generation)>=0,'Saved generation');return {before,saved:final,owner};
}
// Public opening observations are separate from the admitted operation descriptor.
export function nativeOpeningDescriptor(el){const r=el.closest('#native-text-editor'),style=getComputedStyle(el);return {sameTextarea:el===document.querySelector('#native-text-content'),connected:el.isConnected,editable:!el.disabled&&!el.readOnly,draftId:r?.getAttribute('data-session'),revision:r?.getAttribute('data-revision'),value:el.value,ready:r?.textContent?.includes('Text preview ready. Accepted appearance is unchanged.')??false,regionHidden:!r||r.hidden,visible:!!r&&!r.hidden&&el.getClientRects().length>0&&style.visibility!=='hidden'&&style.visibility!=='collapse'};}
export function readDraftOccurrences(root,draftId){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT json FROM ui_checkpoints').all().flatMap(row=>{const ui=JSON.parse(String(row.json));return ui.drafts.filter(d=>d.id===draftId).map(draft=>({ui,draft}));});}finally{db.close();}}
function journal(record,phase,value){record({at:new Date().toISOString(),phase,...structuredClone(value)});}
export async function awaitNativeOpening({page,expect,read,document,acceptedText,priorOwner,record=(_row)=>{}}){
 let last,permanent;const locator=page.locator('#native-text-content');
 try{
  await expect.poll(async()=>{if(permanent)throw permanent;last=await locator.evaluate(nativeOpeningDescriptor);journal(record,'opening-observation',{descriptor:last});
   try{const saved=read(last.draftId);assert.deepEqual(saved.document,document,'Opening accepted document');if(last.draftId&&priorOwner)assert.notEqual(last.draftId,priorOwner.draftId,'Fresh public draft after Cancel');if(saved.draft){const owner=ownerOf(saved,last.draftId);if(priorOwner)assert.equal(owner.sessionId,priorOwner.sessionId,'Opening original session');}
    if(last.regionHidden||!last.visible||!last.editable||!last.draftId)return false;publicOwner(last,last.draftId);assert.equal(last.value,acceptedText,'Opened accepted text');
    return true;
   }catch(error){permanent??=error;throw error;}
  }).toBe(true);
  const node=await locator.elementHandle();assert(node,'Opened textarea');try{const view=await node.evaluate(nativeOpeningDescriptor);journal(record,'opening-admission',{descriptor:view});publicOwner(view,last.draftId);assert(view.visible&&!view.regionHidden,'Visible editor at admission');assert.equal(view.value,acceptedText,'Accepted text at admission');return {node,before:view};}catch(error){await node.dispose();throw error;}
 }catch(error){journal(record,'opening-refused',{descriptor:last,error:String(permanent??error)});throw permanent??error;}
}
export async function cancelAndReopenNativeFont({page,expect,read,occurrences,intent,previous,document,acceptedText,commands,record=(_row)=>{}}){
 const view=await page.locator('#native-text-content').evaluate(nativeDescriptor);journal(record,'before-cancel',{descriptor:view});publicOwner(view,previous.owner.draftId);const before=read(view.draftId);assert.deepEqual(ownerOf(before,view.draftId),previous.owner,'Prior saved owner before Cancel');assert.deepEqual(before.document,document,'Cancel accepted document');
 try{
  await page.getByRole('button',{name:'Cancel text edit',exact:true}).click();
  await expect(page.locator('#native-text-editor')).toContainText('Text draft cancelled. Accepted appearance is unchanged.');await expect(page.locator('#native-text-editor')).toBeHidden();
  let permanent;await expect.poll(()=>{if(permanent)throw permanent;try{const current=read(view.draftId),matches=occurrences(view.draftId);journal(record,'cancel-clear-observation',{draftId:view.draftId,matches:matches.map(x=>({sessionId:x.ui.sessionId,draft:x.draft})),accepted:current.accepted});assert.deepEqual(current.accepted,before.accepted,'Cancel accepted state unchanged');assert.deepEqual(current.document,document,'Cancel document unchanged');for(const match of matches)assert.deepEqual(ownerOf({...current,draft:match},view.draftId),previous.owner,'Clearing original draft owner');return matches.length===0;}catch(error){permanent??=error;throw error;}}).toBe(true);
  assert(!permanent);journal(record,'cancel-complete',{draftId:view.draftId});await page.getByRole('button',{name:'Edit text',exact:true}).click();journal(record,'edit-issued',{priorDraftId:view.draftId});
  return await selectNativeFont({page,expect,read,intent,document,commands,acceptedText,priorOwner:previous.owner,record});
 }catch(error){journal(record,'cancel-or-reopen-refused',{error:String(error)});throw error;}
}
export async function selectNativeFont({page,expect,read,intent,document,commands,acceptedText,priorOwner,record=(_row)=>{}}){
 const {node,before:admitted}=await awaitNativeOpening({page,expect,read,document,acceptedText,priorOwner,record});const observe=()=>node.evaluate(nativeDescriptor);
 try{
  const before=await observe();journal(record,'font-admission-handoff',{admitted,descriptor:before});publicOwner(before,admitted.draftId);for(const key of ['revision','value','ready'])assert.equal(before[key],admitted[key],'Admitted public '+key);
  const accepted=read(before.draftId);assert.deepEqual(accepted.document,document,'Accepted document before font action');const prior=new Set(commands().map(c=>c.commandId));
  await page.getByRole('combobox',{name:'Font choice',exact:true}).selectOption(intent.fontId);await page.getByRole('button',{name:'Use selected font',exact:true}).click();
  await expect(page.getByText('Font substitution draft. Preview reflow before Apply; previous history is unchanged.',{exact:true})).toBeVisible();
  const order=page.locator('#native-text-editor').getByText(new RegExp('^Exact font order: '+intent.fontId+'\\. '));await expect(order).toHaveCount(1);await expect(order).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview text',exact:true})).toBeEnabled();publicOwner(await observe(),before.draftId);assert.deepEqual(read(before.draftId).document,document,'Accepted document after font action');
  const imported=commands().filter(c=>!prior.has(c.commandId)&&c.body.type==='ImportFont');assert.equal(imported.length,1,'One original font action command');const command=imported[0];assert.equal(command.documentId,document.id,'Font action document');assert.equal(command.expectedDocumentRevision,document.revision,'Font action document revision');assert(command.sessionId&&command.clientId,'Original font action session');if(priorOwner)assert.equal(command.sessionId,priorOwner.sessionId,'Original reopened session');assert.deepEqual(command.body,{type:'ImportFont',source:intent.graph.fonts[0].bytes,license:intent.graph.fonts[0].licenseRecord,origin:'bundled',embeddingReviewed:true},'Original intended font import');
  const owner={draftId:before.draftId,documentId:document.id,documentRevision:document.revision,sessionId:command.sessionId};
  await node.fill(intent.text);return {...structuredClone(intent),owner};
 }catch(error){journal(record,'font-action-refused',{descriptor:await observe().catch(e=>({unavailable:String(e)})),error:String(error)});throw error;}finally{await node.dispose();}
}
