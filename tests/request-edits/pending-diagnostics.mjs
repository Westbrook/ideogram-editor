// Failure-only test diagnostics. Never changes a command, deadline, admission or result.
import {openSync,closeSync,fstatSync,readSync,writeFileSync,linkSync,unlinkSync,constants} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const DIAGNOSTIC_LIMIT=270336;
const operation='AdoptReviewedCandidate',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const codes=new Set('ROOT_BUSY ROOT_UNSAFE UNSUPPORTED_STORAGE STALE_EPOCH STORAGE_FAILURE STORAGE_FULL MISSING_OBJECT CORRUPT_OBJECT COMMAND_ID_REUSE MALFORMED_REQUEST PROTOCOL_VERSION PAYLOAD_TOO_LARGE UNSUPPORTED_COMMAND OWNER_REQUIRED NOT_FOUND CONTENT_WITHHELD STAGING_ID_REUSE OFFSET_MISMATCH REVIEW_EXPIRED MEDIA_TYPE CAPACITY CLOSED QUEUE_FULL CORRUPT_STORE TRANSACTION_EVIDENCE_UNAVAILABLE UNEXPECTED INVALID_INPUT INCOMPATIBLE STALE_REVISION ERR_ASSERTION ENOSPC EDQUOT EACCES EPERM'.split(' '));
const enums=new Set(('preparing waiting-for-resources accepted rejected resource-preflight resource-admission resource-retained browser-admission failure import-cleanup-retained encoded-input-rebuild source-metadata retain-text native-state native-limits state-metadata dependency-proofs composite patch-metadata commit candidate split-candidates split-retain-text text-font text-verification ComposeRaster RetainText PrepareCandidatePreview native process worker idle busy paused closed running admitted refused '+operation+' j19-owned-diagnostics-1 j19-diagnostic-unavailable-1').split(' '));
const unavailable=(reason,commandId=null)=>({kind:'e3-pending-diagnostic-unavailable-1',commandId,operation,reason});
function validRequest(value){return value&&Object.keys(value).sort().join(',')==='commandId,operation'&&uuid.test(value.commandId)&&value.operation===operation;}

export function readBoundedJSON(path,limit=DIAGNOSTIC_LIMIT){
 if(!Number.isSafeInteger(limit)||limit<1||limit>DIAGNOSTIC_LIMIT)throw Error('E3_DIAGNOSTIC_LIMIT');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);if(!before.isFile()||before.size<1||before.size>limit)throw Error('E3_DIAGNOSTIC_BOUND');
  const bytes=Buffer.alloc(limit+1);let used=0;
  while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}
  const after=fstatSync(fd);
  if(used>limit||used!==before.size||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw Error('E3_DIAGNOSTIC_CHANGED');
  return JSON.parse(bytes.subarray(0,used).toString('utf8'));
 }finally{closeSync(fd);}
}

// Keep resource numbers and known product enums; never retain free-form messages,
// paths, grants, credentials, environment data, or arbitrary diagnostic strings.
export function redactOwnedDiagnostics(value){
 let nodes=0,redacted=0;
 const walk=(input,depth=0)=>{
  if(++nodes>8192||depth>16)throw Error('E3_DIAGNOSTIC_STRUCTURE');
  if(input===null||typeof input==='boolean')return input;
  if(typeof input==='number')return Number.isFinite(input)?input:null;
  if(typeof input==='string'){if(codes.has(input)||enums.has(input)||/^[0-9]{1,20}$/.test(input))return input;redacted++;return '[redacted]';}
  if(Array.isArray(input)){if(input.length>256)throw Error('E3_DIAGNOSTIC_STRUCTURE');return input.map(item=>walk(item,depth+1));}
  if(!input||typeof input!=='object')throw Error('E3_DIAGNOSTIC_STRUCTURE');
  const result={};for(const [key,item]of Object.entries(input)){
   if(!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)||/message|stack|path|url|grant|token|credential|environment|canonical|original|receipt|prompt/i.test(key)){redacted++;continue;}
   result[key]=walk(item,depth+1);
  }return result;
 };
 return {value:walk(value),redacted};
}

export function writerFailureDiagnostic(value){
 return {code:codes.has(value?.code)?value.code:null,sqliteCode:Number.isSafeInteger(value?.sqliteCode)?value.sqliteCode:null};
}

export function shutdownDiagnostic(shutdown){
 if(!shutdown)return null;
 const raw=typeof shutdown.stderr==='string'?shutdown.stderr:'',prefix=raw.slice(0,16384);
 const names=['AssertionError','AggregateError','TypeError','RangeError','SyntaxError','StoreError','AssetRejection'];
 const framePaths=new Set(['tests/request-edits/observer-fixture.mjs','tests/request-edits/process-fixture.mjs','tests/request-edits/pending-diagnostic-fixture.mjs','tests/request-edits/pending-diagnostics.mjs','tests/history/returned-description-observer-fixture.mjs','server/http.js','server/storage/worker.js','server/storage/writer.js','server/storage/history.js','server/storage/raster.js','server/storage/text.js','server/storage/objects.js','server/storage/errors.js','server/storage/database.js']);
 const frames=[...prefix.matchAll(/(?:^|[ (/])((?:server|src|tests)\/[A-Za-z0-9_./-]{1,140}\.(?:mjs|js|ts)):(\d{1,8}):(\d{1,8})/gm)].filter(m=>framePaths.has(m[1])).slice(0,32).map(m=>({path:m[1],line:Number(m[2]),column:Number(m[3])}));
 return {kind:'e3-shutdown-diagnostic-1',exit:shutdown.exit?{code:Number.isInteger(shutdown.exit.code)?shutdown.exit.code:null,signal:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(shutdown.exit.signal)?shutdown.exit.signal:null}:null,
  stderr:{observedCharacters:raw.length,scannedCharacters:prefix.length,truncated:raw.length>prefix.length,names:names.filter(name=>new RegExp('\\b'+name+'\\b').test(prefix)),codes:[...codes].filter(code=>new RegExp('\\b'+code+'\\b').test(prefix)),frames}};
}

// Uses the original writer's private fixture transport, not another HTTP reader.
// The returned function is also the interval callback, so tests can drive exactly
// this observer once without starting a server or changing any product method.
export function pendingDiagnosticObserver(store,capture){
 let attempted=false;
 return ()=>{
  if(attempted)return;
  let request;try{request=readBoundedJSON(join(store.root,'e3-pending-request.json'),128);}catch(error){if(error.code==='ENOENT')return;attempted=true;return;}
  attempted=true;if(!validRequest(request))return;
  const {commandId}=request;let packet;
  try{
   const pending=store.db.prepare("SELECT json_extract(canonical,'$.command.commandId') commandId,json_extract(canonical,'$.command.body.type') operation,phase FROM history_preparations WHERE id=?").get(commandId);
   const terminal=pending?null:store.db.prepare("SELECT json_extract(CAST(original AS TEXT),'$.command.commandId') commandId,json_extract(CAST(original AS TEXT),'$.command.body.type') operation,json_extract(receipt,'$.status') status FROM commands WHERE id=?").get(commandId);
   const row=pending??terminal;
   if(!row||row.commandId!==commandId||row.operation!==operation||pending&&!['preparing','waiting-for-resources'].includes(row.phase)||terminal&&!['accepted','rejected'].includes(row.status))throw Error('E3_DIAGNOSTIC_OPERATION');
   const raw=capture(store,commandId);if(!Buffer.isBuffer(raw)||raw.length>262144)throw Error('E3_DIAGNOSTIC_BOUND');
   const owned=JSON.parse(raw);if(owned.commandId!==commandId||!['j19-owned-diagnostics-1','j19-diagnostic-unavailable-1'].includes(owned.kind))throw Error('E3_DIAGNOSTIC_IDENTITY');
   packet={kind:'e3-pending-diagnostic-1',commandId,operation,phase:pending?row.phase:null,terminalStatus:terminal?row.status:null,ownership:redactOwnedDiagnostics(store.histories.resourceOwnership()),owned:redactOwnedDiagnostics(owned)};
  }catch{packet=unavailable('capture-refused',commandId);}
  const bytes=Buffer.from(JSON.stringify(packet));if(bytes.length>DIAGNOSTIC_LIMIT)throw Error('E3_DIAGNOSTIC_BOUND');
  const output=join(store.root,'e3-pending-'+commandId+'.json'),temporary=output+'.tmp';
  // A complete temporary inode is linked exclusively: no partial JSON publication
  // and no overwrite of an earlier diagnostic, including a failed attempt.
  writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});linkSync(temporary,output);unlinkSync(temporary);
 };
}

export async function capturePendingDiagnostic(root,command){
 const request={commandId:command?.commandId,operation:command?.body?.type};
 if(!validRequest(request))return unavailable('no-matching-posted-adoption');
 try{
  writeFileSync(join(root,'e3-pending-request.json'),JSON.stringify(request),{mode:0o600,flag:'wx'});
  const output=join(root,'e3-pending-'+request.commandId+'.json');
  for(let attempt=0;attempt<20;attempt++){
   try{
    const value=readBoundedJSON(output);
    if(!['e3-pending-diagnostic-1','e3-pending-diagnostic-unavailable-1'].includes(value?.kind)||value.commandId!==request.commandId||value.operation!==operation)throw Error('E3_DIAGNOSTIC_IDENTITY');
    return value;
   }catch(error){if(error.code!=='ENOENT')throw error;}
   await delay(25);
  }
  return unavailable('capture-deadline',request.commandId);
 }catch{return unavailable('capture-refused',request.commandId);}
}
