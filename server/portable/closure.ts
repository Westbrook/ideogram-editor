import {validateComposition,bindingMap,compositionRefs,serialize} from '../../src/composition/core.js';
import {imagePatch,validateCommit} from '../storage/composition.js';
import {compositionDraft,compositionDraftRefs,compositionDraftGraph} from '../../src/composition/draft.js';
import {maskGrid,r16Mask} from '../../src/raster/mapping.js';
import {maskDraftValue,maskBindings,resolveMaskPlan,maskSource} from '../../src/raster/mask.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {textDraft,draftRefs} from '../../src/protocol/text.js';
import { portableTextSupport, UnsupportedText, validateSource, dependencies, validateLayout, dependencyIdentity } from '../text/validation.js';
import { providerRecord, privacyPolicy, safeTimings } from './provenance.js';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef, Document } from '../../src/protocol/store.js';
import { canonical, hashBytes } from '../storage/canonical.js';
import { entity, rasterManifest, keys, requireValue as ok, id, seq } from '../../src/protocol/validate.js';
import { imageState } from '../../src/protocol/history-validation.js';
import { reduceDocument } from '../../src/state/projection.js';
import { semanticDigest } from '../storage/history.js';
import { references, json } from './format.js';
import { invalid, tick } from './zip.js';
export function validateUI(v:any,documentId:string){
 keys(v,['sessionId','uiSeq','preferences','drafts','reconciledLayerIds']);ok(id(v.sessionId)&&seq(v.uiSeq)&&Array.isArray(v.drafts)&&v.drafts.length<=64&&Array.isArray(v.reconciledLayerIds)&&v.reconciledLayerIds.length<=100&&v.reconciledLayerIds.every(id));
 if(v.preferences!==null){const p=v.preferences;keys(p,['documentId','tool','viewport','panels','selectedLayerIds']);keys(p.viewport,['x','y','zoom']);keys(p.panels,['left','right','active']);ok(p.documentId===documentId&&['select','transform','crop','mask','text'].includes(p.tool)&&[p.viewport.x,p.viewport.y,p.viewport.zoom,p.panels.left,p.panels.right].every(Number.isFinite)&&p.viewport.zoom>0&&p.panels.left>=0&&p.panels.right>=0&&['layers','history','assets'].includes(p.panels.active)&&Array.isArray(p.selectedLayerIds)&&p.selectedLayerIds.length<=100&&p.selectedLayerIds.every(id));}
 const seen=new Set();for(const d of v.drafts){keys(d,['id','generation','kind','documentId','targetLayerId','expectedDocumentRevision','assetId','composing','status',...(d.kind==='mask'?['maskBindings']:[]),...(d.kind==='composition'?['compositionBindings']:[])]);ok(id(d.id)&&!seen.has(d.id)&&seq(d.generation)&&['prompt','inspector','text','mask','composition'].includes(d.kind)&&d.documentId===documentId&&(d.targetLayerId===null||id(d.targetLayerId))&&seq(d.expectedDocumentRevision)&&id(d.assetId)&&typeof d.composing==='boolean'&&['saved-unapplied','applied'].includes(d.status));seen.add(d.id);}
}
export async function validateClosure(db:DatabaseSync,read:(ref:BlobRef)=>Promise<Uint8Array>,check:()=>void,maskSemantics=true,retainedSemantics=true,placementSemantics=true,compositionSemantics=true){
 const docs=db.prepare("SELECT * FROM entities WHERE kind='document'").all();if(docs.length!==1)invalid();const d=JSON.parse(String(docs[0].json)) as Document;entity('document',d);if(d.id!==docs[0].id)invalid();
 db.exec('CREATE TABLE text_sources(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT; CREATE TABLE needed_refs(hash TEXT PRIMARY KEY) STRICT; CREATE TABLE needed_assets(id TEXT PRIMARY KEY) STRICT; CREATE TABLE visited_assets(id TEXT PRIMARY KEY) STRICT; CREATE TABLE semantic_versions(id TEXT PRIMARY KEY,ref TEXT NOT NULL) STRICT; CREATE TABLE checked_semantics(id TEXT PRIMARY KEY) STRICT;');
 const needed=(r:BlobRef)=>{const item=db.prepare('SELECT * FROM refs WHERE hash=?').get(r.hash);if(!item||item.bytes!==r.byteLength)invalid();db.prepare('INSERT OR IGNORE INTO needed_refs VALUES (?)').run(r.hash);};
 const asset=(id:string)=>{if(!db.prepare("SELECT 1 FROM entities WHERE kind='asset' AND id=?").get(id))invalid();db.prepare('INSERT OR IGNORE INTO needed_assets VALUES (?)').run(id);};
 const font=(f:any)=>{const row=db.prepare("SELECT id,json FROM entities WHERE kind='asset' AND json_extract(json,'$.font.id')=?").get(f.id);if(!row||canonical(JSON.parse(String(row.json)).font)!==canonical(f))invalid();asset(String(row!.id));};
 const source=async(ref:BlobRef,pixels?:BlobRef)=>{needed(ref);const raw=json(await read(ref));portableTextSupport(raw);const s=validateSource(raw);for(const r of dependencies(s))needed(r);s.text.fonts.forEach(font);if(pixels&&canonical(pixels)!==canonical(s.render.pixels))invalid();if(dependencyIdentity(s)!==s.render.dependencyHash)invalid();const layout=await read(s.render.layout);const layoutJSON=parseControlJSON(layout,8388608) as any;if(layoutJSON.version!=='layout-1'||layoutJSON.policy!=='text-layout-1')throw new UnsupportedText('UNSUPPORTED_TEXT_LAYOUT');validateLayout(s,layout,await read(s.text.textUtf8));db.prepare('INSERT OR IGNORE INTO text_sources VALUES (?,?)').run(ref.hash,canonical(s));return s;};
 const state=async(v:any)=>{needed(v.state);const s=json(await read(v.state));if(![1,2,3,4,5].includes(s.schemaVersion))throw new UnsupportedText('UNSUPPORTED_IMAGE_STATE_VERSION');if(!maskSemantics&&s.schemaVersion>=3||!retainedSemantics&&s.schemaVersion>=4||!compositionSemantics&&s.schemaVersion===5)invalid();imageState(s);if(s.composition){needed(s.composition.value);const c=json(await read(s.composition.value));if(c.schemaVersion!==1||c.profile!=='ideogram-guide-990fe1c-app1')throw new UnsupportedText('UNSUPPORTED_COMPOSITION_VERSION');validateComposition(c);if(c.id!==s.composition.id)invalid();const prior=db.prepare('SELECT ref FROM semantic_versions WHERE id=?').get(c.id),identity=canonical(s.composition);if(prior&&prior.ref!==identity)invalid();db.prepare('INSERT OR IGNORE INTO semantic_versions VALUES (?,?)').run(c.id,identity);bindingMap(c,s.composition.bindings);for(const r of compositionRefs(c))needed(r);if(c.review){const projected=serialize(c,[],{},true),expected={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:projected.dependencies,boxes:projected.boxes,prompt:c.review.prompt};if(canonical(expected)!==canonical(c.review)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await read(c.review.prompt))!==projected.prompt)invalid();}}if(semanticDigest(s)!==v.semanticDigest)invalid();const raster=(id:string,full=false)=>{asset(id);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(a.qualification!=='canonical-raster'||a.safety!=='safe'||!a.raster||full&&(a.raster.width!==s.width||a.raster.height!==s.height))invalid();};let textBytes=0;const fonts=new Map<string,number>();for(const l of s.layers){if(l.kind==='text'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(l.assetId)?.json??'null'));if(!a?.raster)invalid();const text=await source(l.source,a.raster.pixels);textBytes+=Number(text.text.textUtf8.byteLength);for(const f of text.text.fonts)fonts.set(f.bytes.hash+':'+f.faceIndex,Number(f.bytes.byteLength));if(textBytes>1048576||fonts.size>16||[...fonts.values()].reduce((n,b)=>n+b,0)>67108864)invalid();}raster(l.assetId);const role=(id:string)=>JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json)).raster.role;if(role(l.assetId)==='mask')invalid();if(l.mask){raster(l.mask.assetId);const m=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(l.mask.assetId)!.json)).raster,g=maskGrid(l.mask,s.width,s.height);if(m.width!==g.width||m.height!==g.height||(m.role==='mask')!==r16Mask(l.mask))invalid();}}if(v.compositeAssetId)raster(v.compositeAssetId,true);else if(s.layers.length)invalid();return s;};
 if(d.image){const s=await state(d.image);if((s.composition?.id??null)!==d.compositionVersion||s.width!==d.width||s.height!==d.height||canonical(s.layers.map((l:any)=>l.id))!==canonical(d.orderedLayerIds))invalid();}
 if(!db.prepare("SELECT 1 FROM entities WHERE kind='history' AND id=?").get(d.historyHead)||d.checkpoint&&!db.prepare("SELECT 1 FROM entities WHERE kind='checkpoint' AND id=?").get(d.checkpoint))invalid();
 for(const row of db.prepare('SELECT * FROM entities ORDER BY kind,id').iterate()){
  check();const v=JSON.parse(String(row.json));if(row.kind==='portable-provider'){providerRecord(v);if(v.attemptId!==row.id||!v.derivation.complete||db.prepare('SELECT 1 FROM refs WHERE hash=?').get(v.derivation.sourceBodyHash))invalid();for(const hash of v.assetHashes){const r=db.prepare('SELECT * FROM refs WHERE hash=?').get(hash);if(!r)invalid();needed({hash,byteLength:String(r!.bytes),mediaType:String(r!.media)});const matches=db.prepare("SELECT id FROM entities WHERE kind='asset' AND json_extract(json,'$.blob.hash')=?").all(hash);if(!matches.length)invalid();for(const a of matches)asset(String(a.id));}privacyPolicy(json(await read(v.privacyPolicyRef)));if(v.safeTimingsRef)safeTimings(json(await read(v.safeTimingsRef)));}
  else if(row.kind!=='draft'){entity(String(row.kind),v);if(v.id!==row.id)invalid();}else{validateUI(v,d.id);if(v.sessionId!==row.id)invalid();}
  if(!maskSemantics&&(row.kind==='asset'&&v.raster?.schemaVersion>=2||row.kind==='draft'&&v.drafts.some((d:any)=>d.kind==='mask')))invalid();
  if(row.kind!=='asset')references(v,needed);
  if(row.kind==='history'){
   if(v.documentId!==d.id)invalid();if(v.parent&&!db.prepare("SELECT 1 FROM entities WHERE kind='history' AND id=?").get(v.parent))invalid();
   if(v.kind==='image-edit'){
    const before=await state(v.before),after=await state(v.after);
    // Native versions are branch-local. Validate a changed semantic graph at
    // its actual before/after transition; inherited stale links keep their
    // already validated snapshots, not a same-number snapshot from a sibling.
    if(canonical(before.composition??null)!==canonical(after.composition??null)){
     if(!after.composition||!['CommitCompositionVersion','AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding','ApprovePromptProjection'].includes(v.operation))invalid();
     const cache=new Map<string,Uint8Array>(),load=async(r:BlobRef)=>{if(!cache.has(r.hash))cache.set(r.hash,await read(r));return cache.get(r.hash)!;};
     for(const ref of [before.composition,after.composition])if(ref){const c=json(await load(ref.value));if(c.review)await load(c.review.prompt);}
     for(const l of before.layers)if(l.kind==='text'){const source=json(await load(l.source));await load(source.text.textUtf8);}
     validateCommit(v.operation,after.composition!,before,r=>{const bytes=cache.get(r.hash);if(!bytes)invalid();return bytes!;},id=>JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)?.json??'null')));
     if(canonical(before.layers)!==canonical(after.layers)||before.width!==after.width||before.height!==after.height)invalid();
     db.prepare('INSERT OR IGNORE INTO checked_semantics VALUES (?)').run(after.composition!.id);
    }

    for(const [ref,from,to] of [[v.forward,before,after],[v.inverse,after,before]]){
     const p=json(await read(ref));const expected=imagePatch(from,to,v.operation);
     if(canonical(p)!==canonical(expected))invalid();
    }
   }
  }else if(row.kind==='checkpoint'){if(v.documentId!==d.id||!db.prepare("SELECT 1 FROM entities WHERE kind='history' AND id=?").get(v.historyHead))invalid();if(v.image)await state(v.image);}
  else if(row.kind==='draft')for(const draft of v.drafts){asset(draft.assetId);if(draft.kind==='mask'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json));const value=parseControlJSON(await read(a.blob));maskDraftValue(value);if(!retainedSemantics&&value.schema==='local-mask-2')invalid();const plan=resolveMaskPlan(value.plan,draft.maskBindings);for(const id of maskBindings(value.plan,draft.maskBindings)){asset(id);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(!a.raster||a.qualification!=='canonical-raster'||a.safety!=='safe')invalid();const m=json(await read(a.raster.manifest));maskSource(plan,id,a.raster,m.plan.hard);}}if(draft.kind==='composition'){if(!compositionSemantics)invalid();const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json)),value=json(await read(a.blob));compositionDraft(value);for(const r of compositionDraftRefs(value))needed(r);compositionDraftGraph(parseControlJSON(await read(value.graph),8388608),value);if(!draft.compositionBindings||Object.keys(draft.compositionBindings).length!==Object.keys(value.bindings).length||Object.keys(value.bindings).some(k=>!id(draft.compositionBindings[k])))invalid();}if(draft.kind==='text'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json));const value=json(await read(a.blob));textDraft(value);if(!placementSemantics&&value.kind==='text-draft-2')invalid();for(const ref of draftRefs(value))needed(ref);value.fonts.forEach(font);}}
  await tick();
 }
 // A disk-backed topological walk rejects cycles and verifies every retained
 // branch state, including branches that are not reachable from the current head.
 db.exec('CREATE TABLE checked_history(id TEXT PRIMARY KEY) STRICT');
 let roots=0;for(;;){let progress=0,remaining=0;
  for(const row of db.prepare("SELECT id,json FROM entities WHERE kind='history' AND id NOT IN (SELECT id FROM checked_history) ORDER BY id").iterate()){
   const h=JSON.parse(String(row.json));remaining++;
   if(h.parent===null){roots++;if(roots!==1)invalid();}
   else{
    if(!db.prepare('SELECT 1 FROM checked_history WHERE id=?').get(h.parent))continue;
    const parent=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='history' AND id=?").get(h.parent)!.json));
    const version=parent.kind==='image-edit'?parent.after:parent.forward.after.image;
    if(version){if(canonical(h.before)!==canonical(version))invalid();}
    else{const initial=parent.forward.after,s=json(await read(h.before.state));if(s.width!==initial.width||s.height!==initial.height||s.layers.length||s.composition||h.before.compositeAssetId!==null)invalid();}
   }
   db.prepare('INSERT INTO checked_history VALUES (?)').run(h.id);progress++;check();await tick();
  }
  if(!remaining)break;if(!progress)invalid();
 }
 const head=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='history' AND id=?").get(d.historyHead)!.json));
 if(head.kind==='image-edit'&&canonical(d.image)!==canonical(head.after))invalid();
 if(d.image&&d.redo&&!db.prepare("SELECT 1 FROM entities WHERE kind='history' AND id=? AND json_extract(json,'$.parent')=?").get(d.redo,d.historyHead))invalid();
 // All source events are exact provenance, checked against the captured domain
 // projection. No command/session envelope or live authority is imported.
 let projection:Document|null=null;for(const r of db.prepare('SELECT json FROM events ORDER BY length(seq),seq').iterate()){
  const e=JSON.parse(String(r.json));references(e,needed);
  if(e.type==='ImageEditPreviewPrepared'){await state(e.payload.preview.source);await state(e.payload.preview.after);asset(e.payload.preview.preparedAssetId);json(await read(e.payload.preview.plan));}
  else if(e.type==='AssetRegistered'){asset(e.payload.asset.id);const a=db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(e.payload.asset.id);if(a&&String(a.json)!==canonical(e.payload.asset))invalid();}
  else if(e.documentId!==null){if(e.documentId!==d.id)invalid();
   const retained=e.type==='DocumentCreated'||e.type==='ImageEdited'?['history',e.payload.history]:e.type==='CheckpointSaved'?['checkpoint',e.payload.checkpoint]:null;
   if(retained){const row=db.prepare('SELECT json FROM entities WHERE kind=? AND id=?').get(retained[0],retained[1].id);if(!row||row.json!==canonical(retained[1]))invalid();}
   projection=reduceDocument(projection,e);
  }
 }
 if(!projection||canonical(projection)!==canonical(d))invalid();
 // Every retained semantic graph must originate at a validated transition.
 if(db.prepare('SELECT id FROM semantic_versions WHERE id NOT IN (SELECT id FROM checked_semantics) LIMIT 1').get())invalid();
 // Disk-backed worklist prevents an unbounded transitive closure in memory.
 for(;;){const row=db.prepare('SELECT id FROM needed_assets WHERE id NOT IN (SELECT id FROM visited_assets) ORDER BY id LIMIT 1').get();if(!row)break;const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(row.id)!.json));if(a.availability!=='available'||['withheld','quarantined'].includes(a.safety))invalid();references(a,needed);
  if(a.raster){const m=json(await read(a.raster.manifest));rasterManifest(m);if(!retainedSemantics&&m.schemaVersion===3)invalid();if(m.width!==a.raster.width||m.height!==a.raster.height||m.pipeline!==a.raster.pipeline||canonical(m.pixels)!==canonical(a.raster.pixels))invalid();references(m,needed);if((a.raster.role==='mask')!==(['authored-mask-v1','authored-mask-v2'].includes(m.plan.kind)))invalid();if(a.raster.role==='mask'&&a.raster.schemaVersion!==m.schemaVersion)invalid();if(m.plan.kind==='retained-text')await source(m.plan.source,m.pixels);if(a.raster.role==='native'&&(m.plan.kind!=='decoded-native'||canonical(m.plan.conversion)!==canonical(a.raster.conversion)||canonical(a.raster.sourceAssetIds)!==canonical([m.plan.sourceAssetId])))invalid();for(const source of a.raster.sourceAssetIds)asset(source);const identity=hashBytes(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles}));
   // The stored pixel identity is verified below by the same frozen descriptor
   // shape, while tile bytes receive independent streamed hash checks.
   if(identity!==a.raster.pixelIdentity)invalid();
  }
  db.prepare('INSERT INTO visited_assets VALUES (?)').run(row.id);await tick();
 }
 db.exec('CREATE TABLE checked_assets(id TEXT PRIMARY KEY) STRICT');
 for(;;){let remaining=0,progress=0;for(const r of db.prepare("SELECT id,json FROM entities WHERE kind='asset' AND id NOT IN (SELECT id FROM checked_assets)").iterate()){
  remaining++;const a=JSON.parse(String(r.json));if(a.raster?.sourceAssetIds.some((id:string)=>!db.prepare('SELECT 1 FROM checked_assets WHERE id=?').get(id)))continue;
  db.prepare('INSERT INTO checked_assets VALUES (?)').run(r.id);progress++;check();await tick();
 }if(!remaining)break;if(!progress)invalid();}
 if(db.prepare("SELECT id FROM entities WHERE kind='asset' AND id NOT IN (SELECT id FROM needed_assets) LIMIT 1").get())invalid();
 for(const row of db.prepare('SELECT json FROM records').iterate()){const r=JSON.parse(String(row.json));needed(r.payloadRef);}
 // Command/receipt metadata is an explicitly scoped retained root on export.
 // It must be declared by an event/entity reference; arbitrary hidden objects
 // cannot be smuggled into a complete document archive.
 // Additional declared object records retain scoped command/checkpoint metadata.
 // Export selection, not raw global root reachability, owns that provenance.
 return d;
}
