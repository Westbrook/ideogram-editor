import { IO_CHUNK, refuse } from './contracts.js';
import type { AppliedPrivacyPolicy, ProtectedBody, TransferSink } from './contracts.js';
import { ENDPOINTS } from './policy.js';
import type { TransportEvidenceStore } from './evidence.js';
import type {AdaptedResponse} from './response-adapter.js';
import type {BlobRef} from '../../src/protocol/store.js';
import type {ResultProvenanceV45} from '../../src/protocol/candidates.js';

export type PortablePrompt = Readonly<{hash:string;byteLength:string;mediaType:'text/plain;charset=utf-8'}>;
export type PortableProviderRecord = Readonly<{
  class:'portable-provider';attemptId:string;endpoint:string;requestId:string|null;status:string;
  assetHashes:readonly string[];requestedPromptRef:PortablePrompt|null;submittedPromptRef:PortablePrompt|null;
  returnedPromptRef:PortablePrompt|null;seedText:string|null;safeTimings:Readonly<Record<string,number>>;
  privacyPolicy:AppliedPrivacyPolicy;derivation:{profile:'TP-1';sourceBodyHash:string;complete:boolean};
}>;
export type DerivedProvenance = Readonly<{
  record:PortableProviderRecord; prompt:ProtectedBody; quarantined:boolean;
  inspection:'ordinary'|'opaque'|'unavailable'; warning:'malformed-envelope'|'missing-prompt'|null;
}>;

/** Bounded envelope scanner. Large prompt strings are decoded in 32KiB pages, never JSON.parse'd. */
export function scanEnvelope(chunks:Iterable<Uint8Array>, prompt:(chunk:Buffer)=>void, options?:{profile:'ideogram-v45-result-1'}) {
  function* characters(){const decoder=new TextDecoder('utf-8',{fatal:true});for(const chunk of chunks){if(chunk.byteLength>IO_CHUNK)refuse('PROVENANCE');yield* decoder.decode(chunk,{stream:true});}yield* decoder.decode();}
  const iterator=characters();let c=iterator.next().value as string|undefined;
  const next=()=>{c=iterator.next().value as string|undefined;};
  const whitespace=()=>{while(c!==undefined&&' \r\n\t'.includes(c))next();};
  let tokens=0,foundPrompt=false,seed:string|null=null;const timings:Record<string,number>={};
  const urls:string[]=[];
  const images:Record<string,unknown>[]=[]; const safety:unknown[]=[];
  // Legacy outputIdentity hashes include these exact image records. Extra V45
  // fields are therefore opt-in rather than changing historic V4 identities.
  const imageFields=options?.profile==='ideogram-v45-result-1'?['url','content_type','file_name','file_size','width','height']:['url','content_type','file_size','width','height'];
  let imagesArray=false,safetyArray=false,timingsObject=false,timingsValid=true;
  const capture=(path:string[],v:unknown)=>{
    if(path.length===3&&path[0]==='images'&&imageFields.includes(path[2]!)){
      const i=Number(path[1]);if(i>=1000)refuse('PROVENANCE');(images[i]??={})[path[2]!]=v;
    }
    if(path.length===2&&path[0]==='has_nsfw_concepts'){if(Number(path[1])>=1000)refuse('PROVENANCE');safety[Number(path[1])]=v;}
  };
  function string(emit?:(s:string)=>void):void{
    if(c!=='"')refuse('PROVENANCE');next();let page='';
    const push=(s:string)=>{page+=s;if(page.length>=8192){emit?.(page);page='';}};
    while(c!==undefined&&c!=='"'){
      let char:string=c;next();
      if(char==='\\'){
        if(c===undefined)refuse('PROVENANCE');const escape:string=c;next();
        if(escape==='u'){
          let hex='';for(let i=0;i<4;i++){if(c===undefined||!/^[0-9a-fA-F]$/.test(c))refuse('PROVENANCE');hex+=c;next();}
          const code=parseInt(hex,16);
          if(code>=0xd800&&code<=0xdbff){
            if(c!=='\\')refuse('PROVENANCE');next();if(c!=='u')refuse('PROVENANCE');next();let low='';
            for(let i=0;i<4;i++){if(c===undefined||!/^[0-9a-fA-F]$/.test(c))refuse('PROVENANCE');low+=c;next();}
            const tail=parseInt(low,16);if(tail<0xdc00||tail>0xdfff)refuse('PROVENANCE');char=String.fromCodePoint(0x10000+(code-0xd800)*1024+tail-0xdc00);
          }else{if(code>=0xdc00&&code<=0xdfff)refuse('PROVENANCE');char=String.fromCharCode(code);}
        }else{
          const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
          if(!(escape in escapes))refuse('PROVENANCE');char=escapes[escape]!;
        }
      }else if(char.codePointAt(0)!<32)refuse('PROVENANCE');
      push(char);
    }
    if(c!=='"')refuse('PROVENANCE');next();if(page)emit?.(page);
  }
  function smallString(limit:number):string {let out='';string(s=>{if(out.length+s.length>limit)refuse('PROVENANCE');out+=s;});return out;}
  function value(path:string[],depth:number):void{
    if(depth>16||++tokens>50000)refuse('PROVENANCE');whitespace();
    if(path.length===2&&path[0]==='images'){if(Number(path[1])>=1000)refuse('PROVENANCE');images[Number(path[1])]??={};}
    if(path.length===2&&path[0]==='has_nsfw_concepts'){if(Number(path[1])>=1000)refuse('PROVENANCE');safety[Number(path[1])]=null;}
    if(path.length===2&&path[0]==='timings'&&(c==='"'||c==='{'||c==='['))timingsValid=false;
    if(path.length===3&&path[0]==='images'&&imageFields.includes(path[2]!)&&(c==='{'||c==='['))capture(path,options?.profile==='ideogram-v45-result-1'?{invalid:true}:'invalid');
    if(c==='"'){
      if(path.length===1&&path[0]==='prompt'){foundPrompt=true;string(s=>prompt(Buffer.from(s,'utf8')));}
      else if(path.length===3&&path[0]==='images'&&(['url','content_type'].includes(path[2]!)||options?.profile==='ideogram-v45-result-1'&&path[2]==='file_name')){const u=smallString(16384);if(path[2]==='url')urls.push(u);capture(path,u);}
      else if(path.length===3&&path[0]==='images'&&['file_size','width','height'].includes(path[2]!)){string();capture(path,'invalid');}else string();
    }else if(c==='{'){
      if(path.length===1&&path[0]==='timings')timingsObject=true;
      if(path.length===2&&path[0]==='images'){if(Number(path[1])>=1000)refuse('PROVENANCE');images[Number(path[1])]={};}
      next();whitespace();const keys=new Set<string>();if(String(c)==='}'){next();return;}
      for(;;){whitespace();const key=smallString(256);if(keys.has(key))refuse('PROVENANCE');keys.add(key);whitespace();if(String(c)!==':')refuse('PROVENANCE');next();value([...path,key],depth+1);whitespace();if(String(c)==='}'){next();break;}if(String(c)!==',')refuse('PROVENANCE');next();}
    }else if(c==='['){
      if(path.length===1&&path[0]==='images')imagesArray=true;
      if(path.length===1&&path[0]==='has_nsfw_concepts')safetyArray=true;
      next();whitespace();if(String(c)===']'){next();return;}let i=0;
      for(;;){value([...path,String(i++)],depth+1);whitespace();if(String(c)===']'){next();break;}if(String(c)!==',')refuse('PROVENANCE');next();}
    }else{
      // Exact V45 seed text uses the same bounded representation as a request.
      // Every other numeric token retains the legacy scanner's existing cap.
      const v45Seed=options?.profile==='ideogram-v45-result-1'&&path.length===1&&path[0]==='seed';
      let raw='';while(c!==undefined&&!/[\s,\]}]/.test(c)){if(v45Seed?raw.length>=16384:raw.length>256)refuse('PROVENANCE');raw+=c;next();}
      if(!['true','false','null'].includes(raw)&&!/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.test(raw))refuse('PROVENANCE');
      // Anchor separately: a malformed suffix cannot pass by containing a valid number.
      if(!['true','false','null'].includes(raw)&&! /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw))refuse('PROVENANCE');
      capture(path,['true','false','null'].includes(raw)?JSON.parse(raw):Number(raw));
      if(path.length===2&&path[0]==='timings'&&(!Number.isFinite(Number(raw))||Number(raw)<0||['true','false','null'].includes(raw)))timingsValid=false;
      if(path.length===1&&path[0]==='seed'&&/^-?(0|[1-9][0-9]*)$/.test(raw))seed=raw;
      if(path.length===2&&path[0]==='timings'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(path[1]!)&&Number.isFinite(Number(raw))&&Number(raw)>=0){if(Object.keys(timings).length>=64)refuse('PROVENANCE');timings[path[1]!]=Number(raw);}
    }
  }
  whitespace();if(c!=='{')refuse('PROVENANCE');value([],0);whitespace();if(c!==undefined)refuse('PROVENANCE');
  return {foundPrompt,seed,timings,urls,images,safety,imagesArray,safetyArray,timingsObject,timingsValid};
}
function containsSecret(chunks:Iterable<Uint8Array>,secrets:readonly string[]):boolean{
  const needles=secrets.filter(Boolean).map(s=>Buffer.from(s));
  if(needles.some(s=>s.length>16384)||needles.length>128)refuse('PROVENANCE');
  const keep=Math.max(0,...needles.map(s=>s.length-1));let tail=Buffer.alloc(0),found=false;
  for(const chunk of chunks){const data=Buffer.concat([tail,chunk]);if(needles.some(n=>data.includes(n)))found=true;tail=Buffer.from(data.subarray(Math.max(0,data.length-keep)));}
  return found;
}
export function deriveProvenance(input:{store:TransportEvidenceStore;source:ProtectedBody;promptSink:TransferSink;
  endpoint:string;requestId:string|null;status:'completed'|'failed'|'unknown';policy:AppliedPrivacyPolicy;
  knownTransportSecrets:readonly string[];assetHashes?:readonly string[]}):DerivedProvenance {
  if(!ENDPOINTS.includes(input.endpoint)||!['completed','failed','unknown'].includes(input.status)||
      (input.requestId!==null&&!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)))refuse('IDENTITY');
  if(input.assetHashes?.some(h=>!/^sha256:[a-f0-9]{64}$/.test(h)))refuse('PROVENANCE');
  const metadata=input.store.inspect(input.source.recordId);
  if(metadata.sha256!==input.source.sha256||metadata.attemptId!==input.source.attemptId||metadata.completeness!==input.source.completeness||
    input.promptSink.owner.attemptId!==input.source.attemptId)refuse('PROVENANCE');
  let parsed:ReturnType<typeof scanEnvelope>|undefined,warning:DerivedProvenance['warning']=null;
  try{parsed=scanEnvelope(input.store.read(input.source.recordId),chunk=>input.promptSink.append(chunk));}
  catch{warning='malformed-envelope';}
  const complete=input.source.completeness==='complete'&&!!parsed?.foundPrompt;
  if(!warning&&!parsed?.foundPrompt)warning='missing-prompt';
  const prompt=input.promptSink.finish(complete);
  // Scan after the complete envelope, so URLs appearing after prompt cannot evade quarantine.
  const secrets=[...input.knownTransportSecrets];
  for(const raw of parsed?.urls??[]){try{const u=new URL(raw);if(u.search){secrets.push(raw);for(const v of u.searchParams.values())if(v)secrets.push(v);}}catch{/* URL validation belongs to EF-1; never export unknown fields. */}}
  let quarantined=true;
  try{quarantined=containsSecret(input.store.read(prompt.recordId),secrets);}catch{warning='malformed-envelope';}
  const record:PortableProviderRecord=Object.freeze({class:'portable-provider',attemptId:input.source.attemptId,endpoint:input.endpoint,
    requestId:input.requestId,status:input.status,assetHashes:Object.freeze([...(input.assetHashes??[])]),
    requestedPromptRef:null,submittedPromptRef:null,returnedPromptRef:complete&&!quarantined?Object.freeze({hash:'sha256:'+prompt.sha256,byteLength:prompt.receivedBytes,mediaType:'text/plain;charset=utf-8'}):null,
    seedText:parsed?.seed??null,safeTimings:Object.freeze(parsed?.timings??{}),privacyPolicy:input.policy,
    derivation:Object.freeze({profile:'TP-1',sourceBodyHash:input.source.sha256,complete:complete&&!quarantined&&!warning})});
  return Object.freeze({record,prompt,quarantined,warning,inspection:!complete?'unavailable':BigInt(prompt.receivedBytes)>16n*1024n*1024n?'opaque':'ordinary'});
}
/** Complete copy gate. Evidence hashes are metadata, never traversable export edges. */
export function portableCopyRecord(derived:DerivedProvenance):PortableProviderRecord {
  if(derived.quarantined||!derived.record.derivation.complete||!derived.record.returnedPromptRef)refuse('PROVENANCE');
  return derived.record;
}
/** Explicit recovery copy drops the entire unsafe prompt; original evidence stays unchanged. */
export function redactedRecoveryRecord(derived:DerivedProvenance,acknowledgementId:string) {
  if(!acknowledgementId||acknowledgementId.length>128)refuse('PROVENANCE');
  return Object.freeze({complete:false,sanitized:true,label:'Incomplete sanitized recovery copy',acknowledgementId,
    record:{...derived.record,returnedPromptRef:null,derivation:{...derived.record.derivation,complete:false}}});
}

/** V45-A1 absent fields stay absent. No TP-1 prompt derivative or safety grant. */
export function deriveUnavailableV45Provenance(input:{store:TransportEvidenceStore;source:ProtectedBody;adapted:AdaptedResponse;requestedPrompt:BlobRef;submittedPrompt:BlobRef;requestedSeed:string|null;privacyPolicy:BlobRef}):ResultProvenanceV45 {
  if(input.adapted.profile!=='ideogram-v45-result-1'||!['ideogram/v4.5','ideogram/v4.5/edit'].includes(input.adapted.endpoint))refuse('IDENTITY');
  const actual=input.store.inspect(input.source.recordId);
  if(actual.direction!=='response'||actual.sha256!==input.source.sha256||actual.attemptId!==input.source.attemptId||actual.completeness!==input.source.completeness)refuse('PROVENANCE');
  const valid=input.source.completeness==='complete'&&input.adapted.envelope.schemaValid;
  return {
    schemaVersion:2,responseProfile:'ideogram-v45-result-1',
    availability:{returnedPrompt:'unavailable-by-contract',timings:'unavailable-by-contract',safety:'unavailable-by-contract',providerDimensions:'unavailable-by-contract',measuredImageMetadata:'unavailable-while-withheld',provenance:'partial-metadata-unavailable',resultContract:valid?'valid':'invalid'},
    requestedPrompt:input.requestedPrompt,submittedPrompt:input.submittedPrompt,returnedPrompt:null,returnedBytes:'0',complete:false,quarantined:!valid,inspection:'unavailable',warning:valid?'provider-metadata-unavailable':'malformed-envelope',requestedSeed:input.requestedSeed,returnedSeed:input.adapted.returnedSeed,timings:null,timingUnits:null,sourceBodyHash:'sha256:'+input.source.sha256,privacyPolicy:input.privacyPolicy,
  };
}
