import {validateContributionClosure} from './contributions.js';
import {retainedMetadataReferences,validateRetainedRequestMetadata,validateRetainedRasterMetadata} from './retained.js';
import {lineageRecord,lineageReferences,lineageAssetIds} from './lineage.js';
import {candidateRecord,resultRecord} from './candidates.js';
import {retainedExport} from './exports.js';
import {draftShape as requestDraft,refs as requestRefs} from '../../src/request/core.js';
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
 const seen=new Set();for(const d of v.drafts){keys(d,['id','generation','kind','documentId','targetLayerId','expectedDocumentRevision','assetId','composing','status',...(d.kind==='mask'?['maskBindings']:[]),...(d.kind==='composition'?['compositionBindings']:[])]);ok(id(d.id)&&!seen.has(d.id)&&seq(d.generation)&&['prompt','inspector','text','mask','composition','request'].includes(d.kind)&&d.documentId===documentId&&(d.targetLayerId===null||id(d.targetLayerId))&&seq(d.expectedDocumentRevision)&&id(d.assetId)&&typeof d.composing==='boolean'&&['saved-unapplied','applied'].includes(d.status));seen.add(d.id);}
}
export async function validateClosure(db:DatabaseSync,read:(ref:BlobRef)=>Promise<Uint8Array>,check:()=>void,maskSemantics=true,retainedSemantics=true,placementSemantics=true,compositionSemantics=true,requestSemantics=true){
 const docs=db.prepare("SELECT * FROM entities WHERE kind='document'").all();if(docs.length!==1)invalid();const d=JSON.parse(String(docs[0].json)) as Document;entity('document',d);if(d.id!==docs[0].id)invalid();
 db.exec('CREATE TABLE retained_metadata(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,media TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0) STRICT; CREATE TABLE adopted_lineages(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT; CREATE TABLE lineage_asset_edges(owner TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(owner,child)) STRICT; CREATE TABLE text_sources(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT; CREATE TABLE needed_refs(hash TEXT PRIMARY KEY) STRICT; CREATE TABLE needed_assets(id TEXT PRIMARY KEY) STRICT; CREATE TABLE visited_assets(id TEXT PRIMARY KEY) STRICT; CREATE TABLE semantic_versions(id TEXT PRIMARY KEY,ref TEXT NOT NULL) STRICT; CREATE TABLE checked_semantics(id TEXT PRIMARY KEY) STRICT;');
 const needed=(r:BlobRef)=>{const item=db.prepare('SELECT * FROM refs WHERE hash=?').get(r.hash);if(!item||item.bytes!==r.byteLength)invalid();db.prepare('INSERT OR IGNORE INTO needed_refs VALUES (?)').run(r.hash);};
 const retainMetadata=(ref:BlobRef)=>{needed(ref);if(ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n)invalid();db.prepare('INSERT OR IGNORE INTO retained_metadata(hash,bytes,media) VALUES (?,?,?)').run(ref.hash,ref.byteLength,ref.mediaType);};
 const asset=(id:string)=>{if(!db.prepare("SELECT 1 FROM entities WHERE kind='asset' AND id=?").get(id))invalid();db.prepare('INSERT OR IGNORE INTO needed_assets VALUES (?)').run(id);};
 const adapter=(version:string,hash:string)=>{asset(version);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(version)!.json));if(a.qualification!=='adapter-version'||a.adapter?.id!==version||a.blob.hash!==hash)invalid();};
 const requestAssets=async(value:any,bindings:Record<string,string>|null=null)=>{if(value.source?.capture)retainMetadata(value.source.capture);if(value.mask)retainMetadata(value.mask.plan);if(value.settings?.prompt.composition)retainMetadata(value.settings.prompt.composition.value);const mapped=(id:string)=>bindings?bindings[id]:id;for(const a of value.adapters??[])adapter(mapped(a.version),a.hash);for(const s of [value.source,value.mask])if(s){const id=mapped(s.assetId);asset(id);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(!a.raster||a.version!==s.version||canonical(a.blob)!==canonical(s.blob)||canonical(a.raster.pixels)!==canonical(s.pixels)||a.raster.width!==s.width||a.raster.height!==s.height)invalid();}await validateRetainedRequestMetadata(value,async ref=>json(await read(ref)),bindings!==null);};
 const frozenPrompt=async(prompt:any)=>{if(!prompt.composition)return;const c=json(await read(prompt.composition.value));validateComposition(c);if(c.id!==prompt.composition.id)invalid();bindingMap(c,prompt.composition.bindings);for(const ref of compositionRefs(c))needed(ref);if(!c.review||canonical(c.review)!==canonical(prompt.projection)||canonical(c.review.prompt)!==canonical(prompt.text))invalid();const review=c.review!,projected=serialize(c,[],{},true),expected={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:projected.dependencies,boxes:projected.boxes,prompt:review.prompt};if(canonical(expected)!==canonical(review)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await read(review.prompt))!==projected.prompt)invalid();};
 const adoptedLineage=async(ref:BlobRef,owner?:string)=>{retainMetadata(ref);const lineage=json(await read(ref));if(!requestSemantics)invalid();lineageRecord(lineage);const p=lineage.result.provenance;if(p&&(p.quarantined||!p.complete||db.prepare('SELECT 1 FROM refs WHERE hash=?').get(p.sourceBodyHash)))invalid();if(p)privacyPolicy(json(await read(p.privacyPolicy)));for(const r of lineageReferences(lineage))needed(r);await requestAssets(lineage.result.request.specification,lineage.assetBindings);await frozenPrompt(lineage.result.request.specification.settings.prompt);for(const original of [lineage.candidate.encodedAssetId!,lineage.candidate.preparedAssetId!]){const local=lineage.assetBindings[original];asset(local);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(local)!.json));
   // Candidate decoding approves the normalized raster. Its original encoded
   // bytes stay unknown and are retained as provenance, never as a renderable layer.
   if(a.availability!=='available'||a.purpose!=='image'||!['safe','unknown'].includes(a.safety)||original===lineage.candidate.preparedAssetId&&(a.safety!=='safe'||a.qualification!=='canonical-raster'||!a.raster||a.raster.role==='mask'))invalid();
  }db.prepare('INSERT OR IGNORE INTO adopted_lineages VALUES (?,?)').run(ref.hash,canonical(lineage));if(owner)for(const child of lineageAssetIds(lineage))db.prepare('INSERT OR IGNORE INTO lineage_asset_edges VALUES (?,?)').run(owner,child);return lineage;};
 const font=(f:any)=>{const row=db.prepare("SELECT id,json FROM entities WHERE kind='asset' AND json_extract(json,'$.font.id')=?").get(f.id);if(!row||canonical(JSON.parse(String(row.json)).font)!==canonical(f))invalid();asset(String(row!.id));};
 const source=async(ref:BlobRef,pixels?:BlobRef)=>{needed(ref);const raw=json(await read(ref));portableTextSupport(raw);const s=validateSource(raw);for(const r of dependencies(s))needed(r);s.text.fonts.forEach(font);if(pixels&&canonical(pixels)!==canonical(s.render.pixels))invalid();if(dependencyIdentity(s)!==s.render.dependencyHash)invalid();const layout=await read(s.render.layout);validateLayout(s,layout,await read(s.text.textUtf8),{portable:true});db.prepare('INSERT OR IGNORE INTO text_sources VALUES (?,?)').run(ref.hash,canonical(s));return s;};
 const state=async(v:any,provenanceOnly=false)=>{needed(v.state);const s=json(await read(v.state));if(![1,2,3,4,5].includes(s.schemaVersion))throw new UnsupportedText('UNSUPPORTED_IMAGE_STATE_VERSION');if(!maskSemantics&&s.schemaVersion>=3||!retainedSemantics&&s.schemaVersion>=4||!compositionSemantics&&s.schemaVersion===5)invalid();imageState(s);if(s.composition){needed(s.composition.value);const c=json(await read(s.composition.value));if(c.schemaVersion!==1||c.profile!=='ideogram-guide-990fe1c-app1')throw new UnsupportedText('UNSUPPORTED_COMPOSITION_VERSION');validateComposition(c);if(c.id!==s.composition.id)invalid();const prior=db.prepare('SELECT ref FROM semantic_versions WHERE id=?').get(c.id),identity=canonical(s.composition);if(prior&&prior.ref!==identity)invalid();if(!provenanceOnly)db.prepare('INSERT OR IGNORE INTO semantic_versions VALUES (?,?)').run(c.id,identity);bindingMap(c,s.composition.bindings);for(const r of compositionRefs(c))needed(r);if(c.review){const projected=serialize(c,[],{},true),expected={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:projected.dependencies,boxes:projected.boxes,prompt:c.review.prompt};if(canonical(expected)!==canonical(c.review)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await read(c.review.prompt))!==projected.prompt)invalid();}}if(semanticDigest(s)!==v.semanticDigest)invalid();const raster=(id:string,full=false)=>{asset(id);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(a.qualification!=='canonical-raster'||a.safety!=='safe'||!a.raster||full&&(a.raster.width!==s.width||a.raster.height!==s.height))invalid();};let textBytes=0;const fonts=new Map<string,number>();for(const l of s.layers){if(l.kind==='text'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(l.assetId)?.json??'null'));if(!a?.raster)invalid();const text=await source(l.source,a.raster.pixels);textBytes+=Number(text.text.textUtf8.byteLength);for(const f of text.text.fonts)fonts.set(f.bytes.hash+':'+f.faceIndex,Number(f.bytes.byteLength));if(textBytes>1048576||fonts.size>16||[...fonts.values()].reduce((n,b)=>n+b,0)>67108864)invalid();}raster(l.assetId);const role=(id:string)=>JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json)).raster.role;if(role(l.assetId)==='mask')invalid();if(l.mask){raster(l.mask.assetId);const m=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(l.mask.assetId)!.json)).raster,g=maskGrid(l.mask,s.width,s.height);if(m.width!==g.width||m.height!==g.height||(m.role==='mask')!==r16Mask(l.mask))invalid();}}if(v.compositeAssetId)raster(v.compositeAssetId,true);else if(s.layers.length)invalid();return s;};
 if(d.image){const s=await state(d.image);if((s.composition?.id??null)!==d.compositionVersion||s.width!==d.width||s.height!==d.height||canonical(s.layers.map((l:any)=>l.id))!==canonical(d.orderedLayerIds))invalid();}
 if(!db.prepare("SELECT 1 FROM entities WHERE kind='history' AND id=?").get(d.historyHead)||d.checkpoint&&!db.prepare("SELECT 1 FROM entities WHERE kind='checkpoint' AND id=?").get(d.checkpoint))invalid();
 for(const row of db.prepare('SELECT * FROM entities ORDER BY kind,id').iterate()){
  check();const v=JSON.parse(String(row.json));if(row.kind==='portable-provider'){providerRecord(v);if(v.attemptId!==row.id||!v.derivation.complete||db.prepare('SELECT 1 FROM refs WHERE hash=?').get(v.derivation.sourceBodyHash))invalid();for(const hash of v.assetHashes){const r=db.prepare('SELECT * FROM refs WHERE hash=?').get(hash);if(!r)invalid();needed({hash,byteLength:String(r!.bytes),mediaType:String(r!.media)});const matches=db.prepare("SELECT id FROM entities WHERE kind='asset' AND json_extract(json,'$.blob.hash')=?").all(hash);if(!matches.length)invalid();for(const a of matches)asset(String(a.id));}privacyPolicy(json(await read(v.privacyPolicyRef)));if(v.safeTimingsRef)safeTimings(json(await read(v.safeTimingsRef)));}
  else if(row.kind==='retained-export'){
   retainedExport(v);if(!requestSemantics||v.id!==row.id||v.documentId!==d.id)invalid();asset(v.assetId);
   const retained=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(v.assetId)!.json));
   if(retained.raster?.role!=='export'||!['canonical-png','canonical-jpeg'].includes(retained.qualification)||retained.safety!=='safe'||retained.availability!=='available')invalid();
  }
  else if(row.kind==='job-result'){resultRecord(v);if(v.documentId!==d.id||v.id!==row.id||v.provenance?.quarantined)invalid();if(v.provenance)privacyPolicy(json(await read(v.provenance.privacyPolicy)));if(v.request.specification){await requestAssets(v.request.specification,v.request.assetBindings);await frozenPrompt(v.request.specification.settings.prompt);}}
  else if(row.kind==='candidate-result'){candidateRecord(v);if(v.documentId!==d.id||v.id!==row.id)invalid();const owner=db.prepare("SELECT json FROM entities WHERE kind='job-result' AND id=?").get(v.attemptId);if(!owner||JSON.parse(String(owner.json)).jobId!==v.jobId)invalid();if(!v.encodedAssetId||v.safety!=='safe')invalid();asset(v.encodedAssetId);if(v.preparedAssetId)asset(v.preparedAssetId);}
  else if(row.kind!=='draft'){entity(String(row.kind),v);if(v.id!==row.id)invalid();}else{validateUI(v,d.id);if(v.sessionId!==row.id)invalid();}
  if(!maskSemantics&&(row.kind==='asset'&&v.raster?.schemaVersion>=2||row.kind==='draft'&&v.drafts.some((d:any)=>d.kind==='mask')))invalid();
  if(row.kind!=='asset')references(v,needed);
  if(row.kind==='history'){
   for(const ref of v.roots){if(ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n)continue;const lineage=json(await read(ref));if(lineage.kind==='adopted-candidate-lineage-1')await adoptedLineage(ref);}
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
  else if(row.kind==='draft')for(const draft of v.drafts){asset(draft.assetId);if(draft.kind==='mask'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json));const value=parseControlJSON(await read(a.blob));maskDraftValue(value);if(!retainedSemantics&&value.schema==='local-mask-2')invalid();const plan=resolveMaskPlan(value.plan,draft.maskBindings);for(const id of maskBindings(value.plan,draft.maskBindings)){asset(id);const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(!a.raster||a.qualification!=='canonical-raster'||a.safety!=='safe')invalid();const m=json(await read(a.raster.manifest));maskSource(plan,id,a.raster,m.plan.hard);}}if(draft.kind==='request'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json)),value=parseControlJSON(await read(a.blob));requestDraft(value);for(const ref of requestRefs(value))needed(ref);await requestAssets(value);}
   if(draft.kind==='composition'){if(!compositionSemantics)invalid();const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json)),value=json(await read(a.blob));compositionDraft(value);for(const r of compositionDraftRefs(value))needed(r);compositionDraftGraph(parseControlJSON(await read(value.graph),8388608),value);if(!draft.compositionBindings||Object.keys(draft.compositionBindings).length!==Object.keys(value.bindings).length||Object.keys(value.bindings).some(k=>!id(draft.compositionBindings[k])))invalid();}if(draft.kind==='text'){const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(draft.assetId)!.json));const value=json(await read(a.blob));textDraft(value);if(!placementSemantics&&value.kind==='text-draft-2')invalid();for(const ref of draftRefs(value))needed(ref);value.fonts.forEach(font);}}
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
 for(;;){const row=db.prepare('SELECT id FROM needed_assets WHERE id NOT IN (SELECT id FROM visited_assets) ORDER BY id LIMIT 1').get();if(!row)break;const a=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(row.id)!.json));if(a.availability!=='available'||a.safety==='withheld'||a.safety==='quarantined'&&a.qualification!=='adapter-version')invalid();references(a,needed);
  if(a.adapter){for(const [key,ref] of [['weightsAssetId',a.adapter.weights],['configAssetId',a.adapter.config],['provenanceAssetId',a.adapter.origin.original]] as const){const id=a.adapter.sources[key];if(id!==null){asset(id);const original=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)!.json));if(canonical(original.blob)!==canonical(ref)||(key==='weightsAssetId'?original.purpose!=='adapter'||original.qualification!=='pending-adapter'||original.blob.mediaType!=='application/octet-stream':original.purpose!=='caption'||original.qualification!=='opaque-text'))invalid();}}}
  if(a.retainedMetadata){if(!requestSemantics||!a.raster)invalid();retainMetadata(a.retainedMetadata);await validateRetainedRasterMetadata(a.retainedMetadata,a.raster,async ref=>json(await read(ref)),check);}
  if(a.raster){const m=json(await read(a.raster.manifest));rasterManifest(m);if(!requestSemantics&&['request-source-capture-v1','authored-request-mask-v1','request-preservation-v1','request-source-transport-v1','request-mask-binary-v1','retained-candidate-v1','frozen-image-export-v1'].includes(m.plan.kind))invalid();if(!retainedSemantics&&m.schemaVersion===3)invalid();if(m.width!==a.raster.width||m.height!==a.raster.height||m.pipeline!==a.raster.pipeline||canonical(m.pixels)!==canonical(a.raster.pixels))invalid();references(m,needed);await validateContributionClosure(m,async ref=>json(await read(ref)),id=>JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)?.json??'null'))?.raster,needed);if((a.raster.role==='mask')!==(['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(m.plan.kind)))invalid();if(a.raster.role==='mask'&&a.raster.schemaVersion!==m.schemaVersion)invalid();if(m.plan.kind==='retained-text')await source(m.plan.source,m.pixels);if(m.plan.kind==='request-source-capture-v1'){const c=m.plan.capture,captured=await state(c.image,c.documentId!==d.id);if(c.documentId===d.id&&BigInt(c.documentRevision)>BigInt(d.revision)||captured.width!==m.width||captured.height!==m.height)invalid();const selected=captured.layers.filter((l:any)=>c.scope==='visible-document'?l.visible:c.layerIds.includes(l.id));if(canonical(selected.map((l:any)=>l.id))!==canonical(c.layerIds)||canonical(selected.map((l:any)=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask})))!==canonical(m.plan.layers))invalid();}
   if(m.plan.kind==='retained-candidate-v1'){if(a.raster.sourceAssetIds.length!==1)invalid();const original=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(a.raster.sourceAssetIds[0])?.json??'null'));if(!original?.raster||original.qualification!=='canonical-raster'||original.raster.role==='mask'||canonical(original.raster.manifest)!==canonical(m.plan.source)||canonical(original.blob)!==canonical(a.blob)||canonical(original.raster.pixels)!==canonical(a.raster.pixels)||original.raster.pixelIdentity!==a.raster.pixelIdentity||original.raster.width!==a.raster.width||original.raster.height!==a.raster.height)invalid();const lineage=await adoptedLineage(m.plan.lineage,a.id),candidate=lineage.assetBindings[lineage.candidate.preparedAssetId!];if(original.id!==candidate){const preserved=json(await read(original.raster.manifest)),request=lineage.result.request.specification;if(!('mask'in request)||preserved.plan.kind!=='request-preservation-v1'||canonical(preserved.plan.requestPlan)!==canonical(request.mask.requestPlan)||canonical(original.raster.sourceAssetIds)!==canonical([lineage.assetBindings[request.source.assetId],candidate,lineage.assetBindings[request.mask.assetId]]))invalid();}}
   if(m.plan.kind==='authored-request-mask-v1'){asset(m.plan.sourceAssetId);const original=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(m.plan.sourceAssetId)!.json));if(original.raster?.role==='mask'||canonical(original.raster?.manifest)!==canonical(m.plan.source)||canonical(original.raster?.pixels)!==canonical(m.plan.sourcePixels)||original.raster?.width!==m.width||original.raster?.height!==m.height)invalid();}
   if(a.raster.role==='export'){
    if(!['frozen-png-export','frozen-image-export-v1'].includes(m.plan.kind))invalid();
    const format=m.plan.kind==='frozen-png-export'?'png':m.plan.options.format;
    if(a.qualification!==(format==='jpeg'?'canonical-jpeg':'canonical-png'))invalid();
    if(m.plan.kind==='frozen-image-export-v1'){
     asset(m.plan.sourceAssetId);const original=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(m.plan.sourceAssetId)!.json));
     if(original.qualification!=='canonical-raster'||!original.raster||original.raster.role==='mask'||original.raster.pixelIdentity!==m.plan.pixelIdentity||original.raster.width!==m.plan.sourceWidth||original.raster.height!==m.plan.sourceHeight||canonical(a.raster.sourceAssetIds)!==canonical([original.id])||canonical(m.dependencies)!==canonical([original.raster.manifest]))invalid();
    }
   }
   if(a.raster.role==='native'&&(m.plan.kind!=='decoded-native'||canonical(m.plan.conversion)!==canonical(a.raster.conversion)||canonical(a.raster.sourceAssetIds)!==canonical([m.plan.sourceAssetId])))invalid();for(const source of a.raster.sourceAssetIds)asset(source);const identity=hashBytes(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles}));
   // The stored pixel identity is verified below by the same frozen descriptor
   // shape, while tile bytes receive independent streamed hash checks.
   if(identity!==a.raster.pixelIdentity)invalid();
  }
  db.prepare('INSERT INTO visited_assets VALUES (?)').run(row.id);await tick();
 }
 // Historical IDs are inert here: follow only typed BlobRefs from frozen
 // observations, without resolving them into destination assets or authority.
 for(;;){const row=db.prepare('SELECT * FROM retained_metadata WHERE done=0 ORDER BY hash LIMIT 1').get();if(!row)break;const ref={hash:String(row.hash),byteLength:String(row.bytes),mediaType:String(row.media)},value=json(await read(ref));for(const entry of retainedMetadataReferences(value)){needed(entry.ref);if(entry.inspect)retainMetadata(entry.ref);}db.prepare('UPDATE retained_metadata SET done=1 WHERE hash=?').run(row.hash);check();await tick();}
 db.exec('CREATE TABLE checked_assets(id TEXT PRIMARY KEY) STRICT');
 for(;;){let remaining=0,progress=0;for(const r of db.prepare("SELECT id,json FROM entities WHERE kind='asset' AND id NOT IN (SELECT id FROM checked_assets)").iterate()){
  remaining++;const a=JSON.parse(String(r.json));if(a.raster?.sourceAssetIds.some((id:string)=>!db.prepare('SELECT 1 FROM checked_assets WHERE id=?').get(id))||a.adapter&&Object.values(a.adapter.sources).some(id=>id!==null&&!db.prepare('SELECT 1 FROM checked_assets WHERE id=?').get(id as string))||db.prepare('SELECT 1 FROM lineage_asset_edges WHERE owner=? AND child NOT IN (SELECT id FROM checked_assets) LIMIT 1').get(a.id))continue;
  db.prepare('INSERT INTO checked_assets VALUES (?)').run(r.id);progress++;check();await tick();
 }if(!remaining)break;if(!progress)invalid();}
 if(db.prepare("SELECT id FROM entities WHERE kind='asset' AND id NOT IN (SELECT id FROM needed_assets) LIMIT 1").get()||db.prepare('SELECT id FROM semantic_versions WHERE id NOT IN (SELECT id FROM checked_semantics) LIMIT 1').get())invalid();
 for(const row of db.prepare('SELECT json FROM records').iterate()){const r=JSON.parse(String(row.json));needed(r.payloadRef);}
 // Command/receipt metadata is an explicitly scoped retained root on export.
 // It must be declared by an event/entity reference; arbitrary hidden objects
 // cannot be smuggled into a complete document archive.
 // Additional declared object records retain scoped command/checkpoint metadata.
 // Export selection, not raw global root reachability, owns that provenance.
 return d;
}
