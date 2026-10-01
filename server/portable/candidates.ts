import {keys,requireValue as ok,id,seq,blob} from '../../src/protocol/validate.js';
import {draftShape,newDraft,operations,presets,routes} from '../../src/request/core.js';
import type {Request,Operation} from '../../src/request/core.js';
import {canonical} from '../../src/protocol/json.js';
/** These are inert provenance, never an executable review, token or provider envelope. */
export function requestAssetIds(r:Request):string[]{return [...new Set([...('source'in r?[r.source.assetId]:[]),...('mask'in r?[r.mask.assetId]:[]),...('adapters'in r?r.adapters.map(a=>a.version):[])])];}
export function frozenRequest(r:any):asserts r is Request{
 ok(r&&operations.includes(r.kind));const edit=r.kind.startsWith('transform')||r.kind.startsWith('inpaint'),masked=r.kind.startsWith('inpaint'),adapters=r.kind.endsWith('adapters'),regular=!['instant','fast'].includes(r.kind);
 keys(r,['kind','settings','size',...(edit?['source','strength']:[]),...(masked?['mask']:[]),...(adapters?['adapters']:[])]);const s=r.settings;keys(s,['prompt','syncMode','safetyChecker','seed','count','format','expansion',...(r.kind!=='instant'?['speed']:[]),...(regular?['acceleration']:[])]);
 ok(s.syncMode===false&&s.safetyChecker===true&&[1,2,3,4].includes(s.count)&&['png','jpeg'].includes(s.format)&&['None','Medium',...(regular?['Large']:[])].includes(s.expansion));if(r.kind!=='instant')ok(['TURBO','BALANCED','QUALITY'].includes(s.speed));if(regular)ok(['none','low','regular','high'].includes(s.acceleration));keys(s.seed,s.seed?.kind==='integer'?['kind','decimal']:['kind']);ok(s.seed.kind==='provider-random'||s.seed.kind==='integer'&&typeof s.seed.decimal==='string'&&/^-?(0|[1-9][0-9]*)$/.test(s.seed.decimal));
 if(r.size?.kind==='custom'){keys(r.size,['kind','width','height']);ok([r.size.width,r.size.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)&&r.size.width*r.size.height<=25000000);}else if(r.size?.kind==='preset'){keys(r.size,['kind','value']);ok(presets.includes(r.size.value));}else{keys(r.size,['kind']);ok(edit&&r.size.kind==='auto');}
 if(edit)ok(typeof r.strength==='number'&&Number.isFinite(r.strength)&&r.strength>=0&&r.strength<=1);const d=newDraft(s.prompt?.text);d.operation=r.kind;d.prompt=s.prompt;d.source=edit?r.source:null;d.mask=masked?r.mask:null;d.adapters=adapters?r.adapters:[];draftShape(d);if(adapters)ok(r.adapters.length>0&&r.adapters.length<=3&&new Set(r.adapters.map((a:any)=>a.version)).size===r.adapters.length&&r.adapters.every((a:any)=>a.scale.trim()!==''&&Number.isFinite(Number(a.scale))&&Number(a.scale)>=0&&Number(a.scale)<=4));
}
export function portableRequestRecord(r:any){
 const full=Object.hasOwn(r,'specification');keys(r,['endpoint','prompt','seed',...(full?['specification','assetBindings']:[])]);blob(r.prompt);ok(r.prompt.mediaType==='text/plain'&&/^ideogram\/v4(?:\/[a-z-]+)*$/.test(r.endpoint)&&(r.seed===null||typeof r.seed==='string'&&/^-?(0|[1-9][0-9]*)$/.test(r.seed)));
 if(full){frozenRequest(r.specification);ok(r.endpoint===routes[r.specification.kind as Operation].endpoint&&canonical(r.prompt)===canonical(r.specification.settings.prompt.text)&&r.seed===(r.specification.settings.seed.kind==='integer'?r.specification.settings.seed.decimal:null));keys(r.assetBindings,requestAssetIds(r.specification));ok(Object.values(r.assetBindings).every(id));}
}

export function candidateRecord(v:any){
 keys(v,['id','version','documentId','jobId','attemptId','requestId','outputIndex','outputIdentity','safety','state','hidden','encodedAssetId','preparedAssetId','warning']);
 ok([v.id,v.documentId,v.jobId,v.attemptId,v.requestId].every(id)&&seq(v.version)&&Number.isSafeInteger(v.outputIndex)&&v.outputIndex>=0&&/^sha256:[a-f0-9]{64}$/.test(v.outputIdentity)&&['safe','unknown','withheld'].includes(v.safety)&&['missing','received','downloaded','prepared','transfer-failed','preparation-failed','withheld'].includes(v.state)&&typeof v.hidden==='boolean');
 for(const k of ['encodedAssetId','preparedAssetId'])ok(v[k]===null||id(v[k]));
 ok(v.warning===null||typeof v.warning==='string'&&v.warning.length<=256);
 ok(v.state!=='prepared'||v.safety==='safe'&&v.encodedAssetId!==null&&v.preparedAssetId!==null);
}
export function resultRecord(v:any){
 keys(v,['id','jobId','documentId','requestedCount','actualCount','phase','provenance','inert','request']);ok([v.id,v.jobId,v.documentId].every(id)&&Number.isSafeInteger(v.requestedCount)&&v.requestedCount>0&&v.requestedCount<=4&&(v.actualCount===null||Number.isSafeInteger(v.actualCount)&&v.actualCount>=0)&&['queued','running','completed','failed','quarantined'].includes(v.phase)&&v.inert===true);
 portableRequestRecord(v.request);
 const p=v.provenance;if(p===null)return;keys(p,['requestedPrompt','submittedPrompt','returnedPrompt','returnedBytes','complete','quarantined','inspection','warning','requestedSeed','returnedSeed','timings','timingUnits','sourceBodyHash','privacyPolicy']);
 for(const k of ['requestedPrompt','submittedPrompt','privacyPolicy'])blob(p[k]);if(p.returnedPrompt)blob(p.returnedPrompt);
 ok(seq(p.returnedBytes)&&typeof p.complete==='boolean'&&typeof p.quarantined==='boolean'&&['supported','opaque','unavailable'].includes(p.inspection)&&[null,'missing-prompt','malformed-envelope'].includes(p.warning)&&p.timingUnits==='unknown'&&/^sha256:[a-f0-9]{64}$/.test(p.sourceBodyHash));
 for(const k of ['requestedSeed','returnedSeed'])ok(p[k]===null||typeof p[k]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(p[k]));
 ok(p.timings&&typeof p.timings==='object'&&!Array.isArray(p.timings));for(const [k,n]of Object.entries(p.timings))ok(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&typeof n==='number'&&Number.isFinite(n)&&n>=0);
}
