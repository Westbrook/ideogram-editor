import {dirname} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {Asset} from '../../src/protocol/assets.js';
import type {BlobRef} from '../../src/protocol/store.js';
import type {Candidate} from '../../src/protocol/candidates.js';
import type {QueueJob} from '../../src/protocol/queue.js';
import {adapterVersion,adapterDependencies,adapterRuntimeScope,adapterRuntimeEvidence} from '../../src/protocol/adapters.js';
import type {AdapterRuntimeEvidence,AdapterRuntimeProfile,AdapterRuntimeScope} from '../../src/protocol/adapters.js';
import {routes} from '../../src/request/core.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {PRODUCTION_PROFILE} from '../provider/production-profile.js';
import {QUEUE_ORIGIN,PRODUCTION_MEDIA_HOSTS,PRODUCTION_UPLOAD_ORIGINS} from '../provider/policy.js';
import {TransportEvidenceStore} from '../provider/evidence.js';
import {validateWireExecution} from '../provider/contracts.js';
import {canonical,hashBytes,isId} from './canonical.js';
import type {RuntimeWireRef} from './queue.js';
import type {Objects} from './objects.js';
import type {Assets} from './assets.js';

const HASH=/^sha256:[a-f0-9]{64}$/;
const ENDPOINTS=['ideogram/v4/lora','ideogram/v4/image-to-image/lora','ideogram/v4/inpaint/lora'];
export const RUNTIME_EVIDENCE_LIMIT=4;
export const RUNTIME_ATTEMPT_SCAN_LIMIT=32;
export type AdapterRuntimeAuthority={profile:AdapterRuntimeProfile;queueOrigin:string;mediaOrigins:readonly string[];uploadOrigins:readonly string[]};
export type RuntimeWireSnapshot={metadata:any;body?:Uint8Array};
/** Detached inputs for one comparison. Supplying synthetic inputs tests this
 * contract; it does not mint transport authority or install a provider profile. */
export type AdapterRuntimeFacts={
  job:QueueJob;attemptId:string;retained:any;outbox:any;candidate:Candidate;privateSlot:any;
  versions:ReadonlyMap<string,Asset>;encoded:Asset;prepared:Asset;
  wire:(ref:RuntimeWireRef)=>RuntimeWireSnapshot|null;
  available:(ref:BlobRef)=>boolean;
};
export function currentAdapterRuntimeAuthority():AdapterRuntimeAuthority|null{
  const p=PRODUCTION_PROFILE;
  // The currently shipped production profile only permits plain Generate.
  // This observation pathway does not add routes, uploads or a new profile.
  if(p.mode!=='production'||!ENDPOINTS.includes(p.endpoint))return null;
  return {profile:{id:p.id,version:p.version,evidenceDigest:p.evidenceDigest,endpoint:p.endpoint},queueOrigin:QUEUE_ORIGIN,
    mediaOrigins:PRODUCTION_MEDIA_HOSTS.map(host=>'https://'+host),uploadOrigins:PRODUCTION_UPLOAD_ORIGINS};
}
export function currentAdapterRuntimeProfile():AdapterRuntimeProfile|null{return currentAdapterRuntimeAuthority()?.profile??null;}
function require(value:unknown):asserts value{if(!value)throw Error('UNQUALIFIED_RUNTIME_EVIDENCE');}
function ref(value:any):asserts value is RuntimeWireRef{
  require(value&&Object.keys(value).length===3&&isId(value.recordId)&&HASH.test(value.bodyHash)&&HASH.test(value.metadataHash));
}
function objectPresent(f:AdapterRuntimeFacts,a:Asset){
  require(a.availability==='available'&&f.available(a.blob));
  for(const dependency of a.dependencies)require(f.available(dependency));
  if(a.raster)for(const dependency of [a.raster.pixels,a.raster.manifest])require(f.available(dependency));
}
/** Strictly derives a single observation from already owned, exact facts.
 * The production reader below supplies authority only from the shipped factory
 * profile and obtains bodies from the protected evidence store. */
export function deriveAdapterRuntimeEvidence(f:AdapterRuntimeFacts,authority:AdapterRuntimeAuthority):AdapterRuntimeEvidence|null{
  try{
    const {job,retained:r,outbox:o,candidate:c,privateSlot:p}=f,attempt=job.attempts.find(a=>a.id===f.attemptId),request=job.review.request;
    const {token:reviewToken,...reviewValue}=job.review;require(hashBytes(canonical(reviewValue))===reviewToken&&r.inert!==true);
    require(attempt&&attempt.state==='provider-terminal'&&attempt.terminal==='completed'&&attempt.requestId&&attempt.payloadHash&&attempt.uncertainReason===null&&job.disposition!=='deleted');
    require('adapters' in request&&request.adapters.length>=1&&request.adapters.length<=3&&authority.profile.endpoint===job.review.endpoint);
    const route=routes[request.kind];require(route&&route.endpoint===job.review.endpoint&&route.schemaHash===job.review.schemaHash&&hashBytes(canonical(route))===job.review.routeHash);
    const approval=attempt.providerAuthorization;
    require(approval&&approval.jobId===job.id&&approval.attemptId===attempt.id&&approval.reviewToken===job.review.token&&approval.profileId===authority.profile.id&&approval.profileVersion===authority.profile.version);
    require(r.jobId===job.id&&r.attemptId===attempt.id&&r.documentId===job.documentId&&r.observation?.phase==='completed'&&r.provenance?.complete===true&&!r.provenance.quarantined);
    const observed=r.wireEvidence;require(observed?.kind==='candidate-wire-evidence-1'&&observed.overflow===false&&Array.isArray(observed.contradictions)&&observed.contradictions.length===0&&observed.status&&observed.result);
    const adapters=request.adapters.map(use=>{
      const asset=f.versions.get(use.version);require(asset?.adapter&&asset.qualification==='adapter-version'&&asset.id===use.version&&asset.blob.hash===use.hash);adapterVersion(asset.adapter);objectPresent(f,asset);
      const a=asset.adapter;require(a.id===asset.id&&a.validation.locallyEligible&&canonical(a.weights)===canonical(asset.blob)&&canonical(adapterDependencies(a))===canonical(asset.dependencies));
      return {version:use.version,weightsHash:a.weights.hash,configHash:a.config?.hash??null,scale:Number(use.scale)};
    });
    const scope:AdapterRuntimeScope={kind:'adapter-runtime-scope-1',endpoint:job.review.endpoint,schemaHash:job.review.schemaHash,routeHash:job.review.routeHash,profile:{...authority.profile},adapters};require(adapterRuntimeScope(scope));
    const accepted:RuntimeWireRef[]=[];
    const wire=(value:unknown,role:string,direction:'request'|'response',url:string,control=false)=>{
      ref(value);const snapshot=f.wire(value);require(snapshot);const m=snapshot.metadata,w=m?.wireExecution;
      require(m?.recordId===value.recordId&&m.attemptId===attempt.id&&m.direction===direction&&m.class==='backend-transport'&&m.access==='backend-only'&&m.export==='never'&&m.completeness==='complete'&&m.receivedBytes===m.retainedBytes&&'sha256:'+m.sha256===value.bodyHash&&hashBytes(canonical(m))===value.metadataHash);
      validateWireExecution(w,m);const u=new URL(url);require(w.boundary==='sealed-fal-production-1'&&w.role===role&&w.origin===u.origin&&w.pathname===u.pathname&&w.urlHash===hashBytes(url)&&w.httpStatus>=200&&w.httpStatus<300);
      require(w.method===(role==='submit'||role==='upload'?'POST':role==='cancel'?'PUT':'GET'));
      require(m.policy?.profileId===authority.profile.id&&m.policy.profileVersion===authority.profile.version&&m.policy.evidenceDigest===authority.profile.evidenceDigest&&m.policy.fallbackAcknowledgementId===approval.id);
      // inspect() rechecks the proof-bound body identity. Its canonical metadata
      // hash is retained in the writer journal; callers cannot bless a changed
      // file by merely copying a profile-shaped record into an import.
      const identity=m.wireBodyIdentity;require(identity&&Object.keys(identity).sort().join(',')===['kind','dev','ino','size','mtimeNs','ctimeNs'].sort().join(',')&&identity.kind==='provider-wire-body-identity-1'&&['dev','ino','size','mtimeNs','ctimeNs'].every(key=>typeof identity[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(identity[key]))&&identity.size===m.retainedBytes);
      let body:any=null;
      if(control){require(snapshot.body&&snapshot.body.byteLength<=65536&&hashBytes(snapshot.body)===value.bodyHash);body=parseControlJSON(snapshot.body,65536);require(body&&typeof body==='object'&&!Array.isArray(body));}
      accepted.push(value);return {meta:m,execution:w,body};
    };
    const base=authority.queueOrigin+'/'+scope.endpoint;
    require(o.endpoint===scope.endpoint&&o.requestId===attempt.requestId&&o.payloadHash===attempt.payloadHash&&o.state==='terminal'&&o.urls?.status===base+'/requests/'+attempt.requestId+'/status'&&o.urls?.cancel===base+'/requests/'+attempt.requestId+'/cancel'&&[base+'/requests/'+attempt.requestId,base+'/requests/'+attempt.requestId+'/response'].includes(o.urls?.result));
    const dispatch=o.wireEvidence;require(dispatch?.kind==='queue-wire-evidence-1'&&dispatch.conflicted===false&&Array.isArray(dispatch.uploads)&&dispatch.uploads.length===job.stagePlan.length&&dispatch.uploads.length<=5&&dispatch.dispatch&&dispatch.submission);
    const expected={reviewToken,stagePlanHash:hashBytes(canonical(job.stagePlan)),mappingHash:hashBytes(canonical(o.mapping)),payloadHash:attempt.payloadHash};
    require(canonical(dispatch.dispatch)===canonical(expected)&&dispatch.submission.reviewToken===reviewToken&&dispatch.submission.stagePlanHash===expected.stagePlanHash&&dispatch.submission.mappingHash===expected.mappingHash&&dispatch.submission.payloadHash===expected.payloadHash);
    const roles=new Set<string>();
    for(let i=0;i<job.stagePlan.length;i++){
      const stage=job.stagePlan[i]!,upload=dispatch.uploads[i];require(upload&&canonical(upload.stage)===canonical(stage)&&!roles.has(stage.role)&&o.mapping[stage.role]===upload.url);roles.add(stage.role);
      const returned=new URL(upload.url);require(authority.mediaOrigins.includes(returned.origin)&&!returned.username&&!returned.password&&!returned.hash);
      ref(upload.response);const responseSnapshot=f.wire(upload.response),uploadExecution=responseSnapshot?.metadata?.wireExecution;require(uploadExecution&&authority.uploadOrigins.includes(uploadExecution.origin));
      const uploadURL=uploadExecution.origin+uploadExecution.pathname,output=wire(upload.response,'upload','response',uploadURL,true),input=wire(upload.request,'upload','request',uploadURL);
      require(output.body.url===upload.url&&output.execution.requestRecordId===upload.request.recordId&&output.execution.requestSha256===upload.request.bodyHash&&input.execution.requestSha256===upload.request.bodyHash&&input.execution.httpStatus===output.execution.httpStatus&&upload.request.bodyHash===stage.transport.hash&&input.meta.retainedBytes===stage.transport.byteLength);
      if('versionId' in stage){const index=Number(stage.role.slice(8)),use=adapters[index];require(use&&stage.role==='adapter:'+index&&stage.versionId===use.version&&stage.original.hash===use.weightsHash&&canonical(stage.original)===canonical(stage.transport));}
    }
    require(Object.keys(o.mapping).length===roles.size&&adapters.every((_,index)=>roles.has('adapter:'+index)));
    const submit=wire(dispatch.submission.body,'submit','request',base),ack=wire(dispatch.submission.response,'submit','response',base,true);
    require(dispatch.submission.body.bodyHash===attempt.payloadHash&&submit.execution.requestSha256===dispatch.submission.body.bodyHash&&submit.execution.httpStatus===ack.execution.httpStatus&&o.responseRecord===dispatch.submission.response.recordId&&ack.execution.requestRecordId===dispatch.submission.body.recordId&&ack.execution.requestSha256===dispatch.submission.body.bodyHash&&ack.body.request_id===attempt.requestId&&ack.body.status_url===o.urls.status&&ack.body.response_url===o.urls.result&&ack.body.cancel_url===o.urls.cancel);
    const status=wire(observed.status,'status','response',o.urls.status,true),result=wire(observed.result,'result','response',o.urls.result);
    require(status.body.request_id===attempt.requestId&&status.body.status==='COMPLETED'&&!status.body.error&&!status.body.error_type&&r.observation.resultDigest===result.meta.sha256&&r.provenance.sourceBodyHash===observed.result.bodyHash);
    require(c.jobId===job.id&&c.attemptId===attempt.id&&c.requestId===attempt.requestId&&c.documentId===job.documentId&&c.state==='prepared'&&c.safety==='safe'&&c.warning===null&&c.encodedAssetId===f.encoded.id&&c.preparedAssetId===f.prepared.id);
    const output=p.outputEvidence;require(output?.kind==='candidate-output-wire-1'&&canonical(output.result)===canonical(observed.result)&&output.safe===true&&output.index===c.outputIndex&&Number.isSafeInteger(output.index)&&output.index>=0&&output.index<4&&Number.isSafeInteger(r.actualCount)&&r.actualCount>=1&&output.index<r.actualCount&&r.actualCount<=4);
    const image=output.image;require(image&&typeof image==='object'&&!Array.isArray(image)&&Object.keys(image).every(key=>['url','content_type','file_size','width','height'].includes(key))&&image.url===p.url);
    const numeric=(key:string)=>image[key]===undefined||image[key]===null?null:typeof image[key]==='number'&&Number.isSafeInteger(image[key])&&image[key]>=0?image[key]:-1;
    require(p.expectedBytes===numeric('file_size')&&p.width===numeric('width')&&p.height===numeric('height')&&p.mime===(image.content_type===undefined||image.content_type===null?null:typeof image.content_type==='string'?image.content_type:'invalid'));
    const outputIdentity=hashBytes(canonical([attempt.requestId,output.index,image]));require(c.outputIdentity===outputIdentity&&c.id==='c_'+hashBytes(canonical([attempt.id,output.index,outputIdentity])).slice(7));
    // The original wire bytes and decoded-output journal establish a historical
    // successful observation. Current Objects checks below establish retained
    // availability; they do not advertise a new pixel-integrity verification.
    require(f.prepared.qualification==='canonical-raster'&&f.prepared.safety==='safe'&&f.prepared.raster?.sourceAssetIds.includes(f.encoded.id));objectPresent(f,f.encoded);objectPresent(f,f.prepared);
    require(p.mediaRecord&&p.mediaEvidence&&p.mediaRecord===p.mediaEvidence.recordId&&typeof p.url==='string'&&authority.mediaOrigins.includes(new URL(p.url).origin));
    const media=wire(p.mediaEvidence,'media','response',p.url);require('sha256:'+media.meta.sha256===f.encoded.blob.hash&&media.meta.retainedBytes===f.encoded.blob.byteLength);
    const value:AdapterRuntimeEvidence={kind:'adapter-runtime-evidence-1',scope,jobId:job.id,attemptId:attempt.id,requestId:attempt.requestId,candidateId:c.id,outputAssetId:f.prepared.id,outputHash:f.prepared.blob.hash,
      observationHash:hashBytes(canonical({scope,reviewToken:job.review.token,approval,wire:accepted,candidate:{id:c.id,outputIdentity:c.outputIdentity,encoded:f.encoded.blob,prepared:f.prepared.blob}}))};
    require(adapterRuntimeEvidence(value));return value;
  }catch{return null;}
}

/** Bounded metadata projection. Imported portable rows are deliberately absent.
 * Transport bodies remain backend-only; the public observation exposes hashes
 * and scoped request identities, never URLs or protected record identifiers. */
export class AdapterRuntimeEvidenceReader{
  private evidence:TransportEvidenceStore|undefined;
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets){}
  profile(){return currentAdapterRuntimeProfile();}
  forVersion(versionId:string):AdapterRuntimeEvidence[]{
    const authority=currentAdapterRuntimeAuthority();if(!authority||this.assets.adapterDeleted(versionId))return [];
    const evidence=this.evidence??=new TransportEvidenceStore(dirname(this.objects.staging));
    const values:AdapterRuntimeEvidence[]=[];
    const rows=this.db.prepare("SELECT r.json retained,j.json job FROM candidate_jobs r JOIN queue_jobs j ON j.id=json_extract(r.json,'$.jobId') WHERE json_extract(r.json,'$.wireEvidence.kind')='candidate-wire-evidence-1' AND EXISTS(SELECT 1 FROM json_each(j.json,'$.review.request.adapters') a WHERE json_extract(a.value,'$.version')=?) ORDER BY r.rowid DESC LIMIT ?").all(versionId,RUNTIME_ATTEMPT_SCAN_LIMIT);
    for(const row of rows){
      if(values.length===RUNTIME_EVIDENCE_LIMIT)break;
      try{
        const job=JSON.parse(String(row.job)) as QueueJob,retained=JSON.parse(String(row.retained));
        if(this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(job.documentId))continue;
        const outboxRow=this.db.prepare('SELECT json FROM queue_outbox WHERE attempt_id=?').get(retained.attemptId);if(!outboxRow)continue;
        const versions=new Map<string,Asset>();if(!('adapters' in job.review.request))continue;
        for(const use of job.review.request.adapters){const asset=this.assets.asset(use.version);if(!asset||this.assets.adapterDeleted(use.version))throw Error();versions.set(use.version,asset);}
        const candidates=this.db.prepare("SELECT json FROM candidates WHERE job_id=? AND json_extract(json,'$.attemptId')=? AND json_extract(json,'$.state')='prepared' ORDER BY id LIMIT 4").all(job.id,retained.attemptId);
        for(const candidateRow of candidates){
          const candidate=JSON.parse(String(candidateRow.json)) as Candidate,privateRow=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(candidate.id),encoded=candidate.encodedAssetId?this.assets.asset(candidate.encodedAssetId):null,prepared=candidate.preparedAssetId?this.assets.asset(candidate.preparedAssetId):null;
          if(!privateRow||!encoded||!prepared)continue;
          const value=deriveAdapterRuntimeEvidence({job,attemptId:retained.attemptId,retained,outbox:JSON.parse(String(outboxRow.json)),candidate,privateSlot:JSON.parse(String(privateRow.json)),versions,encoded,prepared,
            available:blob=>{try{this.objects.readRange(blob,'0',0);return true;}catch{return false;}},
            wire:reference=>{try{ref(reference);const metadata=evidence.inspect(reference.recordId),role=metadata.wireExecution?.role;let body:Uint8Array|undefined;if(metadata.direction==='response'&&['submit','status','upload'].includes(role??'')){if(BigInt(metadata.retainedBytes)>65536n)return null;body=Buffer.concat([...evidence.read(reference.recordId)]);}return {metadata,body};}catch{return null;}}
          },authority);
          if(value){values.push(value);break;}
        }
      }catch{/* Missing, malformed or conflicting evidence never grants authority. */}
    }
    return values;
  }
}
