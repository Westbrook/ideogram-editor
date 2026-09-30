import {keys,requireValue as ok,id,seq,blob} from '../../src/protocol/validate.js';
export function candidateRecord(v:any){
 keys(v,['id','version','documentId','jobId','attemptId','requestId','outputIndex','outputIdentity','safety','state','hidden','encodedAssetId','preparedAssetId','warning']);
 ok([v.id,v.documentId,v.jobId,v.attemptId,v.requestId].every(id)&&seq(v.version)&&Number.isSafeInteger(v.outputIndex)&&v.outputIndex>=0&&/^sha256:[a-f0-9]{64}$/.test(v.outputIdentity)&&['safe','unknown','withheld'].includes(v.safety)&&['missing','received','downloaded','prepared','transfer-failed','preparation-failed','withheld'].includes(v.state)&&typeof v.hidden==='boolean');
 for(const k of ['encodedAssetId','preparedAssetId'])ok(v[k]===null||id(v[k]));
 ok(v.warning===null||typeof v.warning==='string'&&v.warning.length<=256);
 ok(v.state!=='prepared'||v.safety==='safe'&&v.encodedAssetId!==null&&v.preparedAssetId!==null);
}
export function resultRecord(v:any){
 keys(v,['id','jobId','documentId','requestedCount','actualCount','phase','provenance','inert','request']);ok([v.id,v.jobId,v.documentId].every(id)&&Number.isSafeInteger(v.requestedCount)&&v.requestedCount>0&&v.requestedCount<=4&&(v.actualCount===null||Number.isSafeInteger(v.actualCount)&&v.actualCount>=0)&&['queued','running','completed','failed','quarantined'].includes(v.phase)&&v.inert===true);
 keys(v.request,['endpoint','prompt','seed']);blob(v.request.prompt);ok(v.request.prompt.mediaType==='text/plain'&&/^ideogram\/v4(?:\/[a-z-]+)*$/.test(v.request.endpoint)&&(v.request.seed===null||typeof v.request.seed==='string'&&/^-?(0|[1-9][0-9]*)$/.test(v.request.seed)));
 const p=v.provenance;if(p===null)return;keys(p,['requestedPrompt','submittedPrompt','returnedPrompt','returnedBytes','complete','quarantined','inspection','warning','requestedSeed','returnedSeed','timings','timingUnits','sourceBodyHash','privacyPolicy']);
 for(const k of ['requestedPrompt','submittedPrompt','privacyPolicy'])blob(p[k]);if(p.returnedPrompt)blob(p.returnedPrompt);
 ok(seq(p.returnedBytes)&&typeof p.complete==='boolean'&&typeof p.quarantined==='boolean'&&['supported','opaque','unavailable'].includes(p.inspection)&&[null,'missing-prompt','malformed-envelope'].includes(p.warning)&&p.timingUnits==='unknown'&&/^sha256:[a-f0-9]{64}$/.test(p.sourceBodyHash));
 for(const k of ['requestedSeed','returnedSeed'])ok(p[k]===null||typeof p[k]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(p[k]));
 ok(p.timings&&typeof p.timings==='object'&&!Array.isArray(p.timings));for(const [k,n]of Object.entries(p.timings))ok(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&typeof n==='number'&&Number.isFinite(n)&&n>=0);
}
