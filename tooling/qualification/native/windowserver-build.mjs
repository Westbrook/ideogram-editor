// Explicit preparation only. A successful receipt records an observed build;
// it does not approve a semantic oracle, capture, or complete toolchain.
import {createHash} from 'node:crypto';
import {constants,writeSync} from 'node:fs';
import {lstat,realpath,open,mkdir,readdir,readlink,chmod} from 'node:fs/promises';
import {isAbsolute,resolve,join,dirname,basename,sep} from 'node:path';
import {platform,arch,release} from 'node:os';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {boundedChild} from '../container/bounded-child.mjs';

const KIND='windowserver-collector-build-1';
const SCOPE='pinned source/compiler executable/SDK observed build';
const SDK_KIND='windowserver-sdk-tree-1';
const MAX_SOURCE=4*1024**2,MAX_COMPILER=512*1024**2,MAX_BINARY=64*1024**2;
const MAX_MANIFEST=128*1024**2,MAX_RECEIPT=128*1024,MAX_SDK_BYTES=32*1024**3;
const MAX_SDK_ENTRIES=1_000_000,MAX_SDK_FILE=1024**3,MAX_TIMEOUT=30*60_000;
const MAX_VERIFY_TIMEOUT=60_000;
const EVIDENCE_KIND='windowserver-build-evidence-1';
const EVIDENCE_MEMBERS=[['build-receipt.json',MAX_RECEIPT,0o600],['collector.swift',MAX_SOURCE,0o600],['sdk-manifest.json',MAX_MANIFEST,0o600],['version.stdout.log',1024**2,0o600],['version.stderr.log',1024**2,0o600],['build.stdout.log',16*1024**2,0o600],['build.stderr.log',16*1024**2,0o600],['windowserver-capture',MAX_BINARY,0o700]];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const pin=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(left,right,label)=>{if(JSON.stringify(left)!==JSON.stringify(right))throw Error(label);};
const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs];
const fail=message=>{throw Error(message);};
function exact(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))fail('Invalid '+label+' fields');
}
function absolute(path,label){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||path==='/'||/[\x00-\x1f\x7f]/.test(path))fail('Expected canonical absolute '+label);
  return path;
}
function deadline(timeoutMs,external){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT)fail('Invalid build timeout');
  const controller=new AbortController(),end=performance.now()+timeoutMs;
  const relay=()=>controller.abort(external.reason??'Build cancelled');
  external?.addEventListener('abort',relay,{once:true});if(external?.aborted)relay();
  const timer=setTimeout(()=>controller.abort('Build deadline exceeded'),timeoutMs);
  return {signal:controller.signal,check(){if(controller.signal.aborted)fail(String(controller.signal.reason));if(performance.now()>=end)fail('Build deadline exceeded');},
    remaining(){this.check();return Math.max(1,Math.floor(end-performance.now()));},
    close(){clearTimeout(timer);external?.removeEventListener('abort',relay);}};
}
async function physical(path,type){
  const value=await lstat(path);
  if(value.isSymbolicLink()||!(type==='directory'?value.isDirectory():value.isFile())||await realpath(path)!==path)fail('Expected physical '+type+': '+path);
  return value;
}
async function privateDirectory(path){
  const value=await physical(path,'directory');
  if(value.uid!==process.getuid()||(value.mode&0o777)!==0o700)fail('Output directory must be owned and mode 0700');
  return value;
}
async function heldFile(path,maxBytes,context,{collect=false,owned=false}={}){
  context.check();const before=await physical(path,'file');
  if(before.size>maxBytes||before.size<0||owned&&(before.uid!==process.getuid()||before.nlink!==1))fail('Invalid bounded file: '+path);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),digest=createHash('sha256');
  const block=Buffer.alloc(Math.min(1024**2,Math.max(1,before.size))),chunks=[];let bytes=0;
  try{
    same(stamp(before),stamp(await handle.stat()),'File changed before reading');
    for(;;){context.check();const part=await handle.read(block,0,block.length,null);if(!part.bytesRead)break;
      bytes+=part.bytesRead;if(bytes>maxBytes||bytes>before.size)fail('File grew while reading');
      const data=block.subarray(0,part.bytesRead);digest.update(data);if(collect)chunks.push(Buffer.from(data));
    }
    const after=await handle.stat(),current=await lstat(path);
    same(stamp(before),stamp(after),'Held file changed');same(stamp(after),stamp(current),'File path changed');
    if(bytes!==before.size||await realpath(path)!==path)fail('File changed during hashing');context.check();
    return {identity:{bytes,sha256:digest.digest('hex'),mode:before.mode&0o777},...(collect?{data:Buffer.concat(chunks)}:{})};
  }finally{await handle.close();}
}
async function exclusive(path,bytes){
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function checkSdkLinks(entries,root,context){
  const rows=new Map(entries.map(row=>[row.path,row]));
  let work=0,links=0,resolutionBytes=0;
  for(const link of entries.filter(row=>row.type==='link')){
    if(++links%256===0)await yieldTurn();context.check();
    let pending=link.path.split('/'),resolved=[],hops=0;const visited=new Set();
    while(pending.length){
      if(++work>10_000_000)fail('SDK link resolution bound exceeded');if(work%32===0)context.check();
      const part=pending.shift();if(part===''||part==='.')continue;
      if(part==='..'){if(!resolved.length)fail('SDK link escapes root');resolved.pop();continue;}
      const path=[...resolved,part].join('/'),row=rows.get(path);if(!row)fail('Dangling SDK link: '+link.path);
      if(row.type==='link'){
        const stateBytes=Buffer.byteLength(path)+1+pending.reduce((total,part)=>total+Buffer.byteLength(part)+1,0);
        resolutionBytes+=stateBytes;if(stateBytes>65_536||resolutionBytes>MAX_MANIFEST||pending.length>1024)fail('SDK link expansion bound exceeded');
        const state=path+'\0'+pending.join('/');if(visited.has(state)||++hops>64)fail('Cyclic or excessive SDK link chain');visited.add(state);
        let target=row.target;
        if(isAbsolute(target)){
          if(target!==root&&!target.startsWith(root+sep))fail('External SDK link');
          target=target.slice(root.length);resolved=[];
        }
        const parts=target.split('/');if(parts.length+pending.length>1024||Buffer.byteLength(target)+stateBytes>65_536)fail('SDK link expansion bound exceeded');
        pending=[...parts,...pending];continue;
      }
      if(pending.length&&row.type!=='directory')fail('SDK link traverses a file');resolved.push(part);
    }
    if(!rows.has(resolved.join('/')||'.'))fail('Dangling SDK link');
  }
}
async function sdkIdentity(root,context){
  const entries=[];let total=0,manifestBudget=128;
  const add=row=>{manifestBudget+=Buffer.byteLength(JSON.stringify(row))+128;if(manifestBudget>MAX_MANIFEST)fail('SDK manifest bound exceeded');entries.push(row);};
  async function walk(path,relative,depth){
    context.check();if(depth>128||entries.length>=MAX_SDK_ENTRIES)fail('SDK inventory bound exceeded');
    const before=await physical(path,'directory');add({path:relative||'.',type:'directory',mode:before.mode&0o777});
    const names=(await readdir(path)).sort();
    for(const name of names){
      context.check();if(entries.length>=MAX_SDK_ENTRIES||/[\x00-\x1f\x7f\\]/.test(name))fail('Invalid SDK inventory entry');
      const full=join(path,name),member=relative?relative+'/'+name:name,stat=await lstat(full);
      if(stat.isDirectory())await walk(full,member,depth+1);
      else if(stat.isFile()){
        const {identity}=await heldFile(full,MAX_SDK_FILE,context);total+=identity.bytes;if(total>MAX_SDK_BYTES)fail('SDK byte bound exceeded');
        add({path:member,type:'file',...identity});
      }else if(stat.isSymbolicLink()){
        const target=await readlink(full);if(!target||target.length>16_384||/[\x00-\x1f\x7f\\]/.test(target))fail('Invalid SDK link');
        same(stamp(stat),stamp(await lstat(full)),'SDK link changed');if(await readlink(full)!==target)fail('SDK link changed');
        add({path:member,type:'link',mode:stat.mode&0o777,target});
      }else fail('SDK contains a special file');
    }
    same(names,(await readdir(path)).sort(),'SDK directory membership changed');
    same(stamp(before),stamp(await physical(path,'directory')),'SDK directory changed');
  }
  await walk(root,'',0);entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);await checkSdkLinks(entries,root,context);context.check();
  const manifest={kind:SDK_KIND,entries},bytes=json(manifest);if(bytes.length>MAX_MANIFEST)fail('SDK manifest bound exceeded');
  return {digest:hash(JSON.stringify(manifest)),manifest,bytes};
}
async function retainedSdkIdentity(manifest,root,context){
  exact(manifest,['kind','entries'],'retained SDK manifest');
  if(manifest.kind!==SDK_KIND||!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>MAX_SDK_ENTRIES)fail('Invalid retained SDK inventory');
  const rows=new Map();let total=0,previous='',manifestBudget=128;
  for(const [index,row]of manifest.entries.entries()){
    if(index%256===0)await yieldTurn();context.check();
    if(!row||typeof row.path!=='string'||typeof row.type!=='string')fail('Invalid retained SDK row');
    exact(row,row.type==='directory'?['path','type','mode']:row.type==='file'?['path','type','bytes','sha256','mode']:['path','type','mode','target'],'retained SDK row');
    if(!['directory','file','link'].includes(row.type)||!Number.isSafeInteger(row.mode)||row.mode<0||row.mode>0o777)fail('Invalid retained SDK type or mode');
    if(index&&row.path<=previous)fail('Invalid retained SDK member ordering');
    if(row.path==='.'){if(row.type!=='directory')fail('Retained SDK root missing');}
    else if(!row.path||isAbsolute(row.path)||/[\x00-\x1f\x7f\\]/.test(row.path)||row.path.split('/').some(part=>!part||part==='.'||part==='..')||row.path.split('/').length>(row.type==='directory'?128:129))fail('Invalid retained SDK member path');
    const parent=dirname(row.path);if(row.path!=='.'&&parent!=='.'&&rows.get(parent)?.type!=='directory')fail('Retained SDK member has no physical parent');
    if(row.type==='file'){
      if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>MAX_SDK_FILE||!pin(row.sha256))fail('Invalid retained SDK file');
      total+=row.bytes;if(total>MAX_SDK_BYTES)fail('Retained SDK byte bound exceeded');
    }
    if(row.type==='link'&&(typeof row.target!=='string'||!row.target||row.target.length>16_384||/[\x00-\x1f\x7f\\]/.test(row.target)))fail('Invalid retained SDK link');
    manifestBudget+=Buffer.byteLength(JSON.stringify(row))+128;if(manifestBudget>MAX_MANIFEST)fail('Retained SDK manifest bound exceeded');
    rows.set(row.path,row);previous=row.path;
  }
  if(rows.get('.')?.type!=='directory')fail('Retained SDK root missing');
  await checkSdkLinks(manifest.entries,root,context);context.check();return hash(JSON.stringify(manifest));
}
function recordedFile(identity,maxBytes,label){
  exact(identity,['bytes','sha256','mode'],label);
  if(!Number.isSafeInteger(identity.bytes)||identity.bytes<0||identity.bytes>maxBytes||!pin(identity.sha256)||!Number.isSafeInteger(identity.mode)||identity.mode<0||identity.mode>0o777)fail('Invalid '+label+' identity');
}
function targetFor(architecture){
  if(!['arm64','x64'].includes(architecture))fail('Unsupported collector architecture');
  return (architecture==='x64'?'x86_64':'arm64')+'-apple-macosx15.0';
}
function contract(directory,compilerPath,sdkPath,architecture){
  const moduleCache=join(directory,'module-cache'),binaryPath=join(directory,'windowserver-capture');
  const environment={PATH:dirname(compilerPath)+':/usr/bin:/bin',HOME:join(directory,'home'),TMPDIR:join(directory,'tmp'),LANG:'C',LC_ALL:'C',SDKROOT:sdkPath,SWIFT_MODULECACHE_PATH:moduleCache,CLANG_MODULE_CACHE_PATH:moduleCache};
  return {environment,binaryPath,version:['--driver-mode=swiftc','--version'],
    build:['--driver-mode=swiftc','-O','-target',targetFor(architecture),'-sdk',sdkPath,'-module-cache-path',moduleCache,'-o',binaryPath,join(directory,'collector.swift')]};
}
async function command(stage,args,compilerPath,directory,environment,context){
  const controller=new AbortController(),relay=()=>controller.abort(context.signal.reason);context.signal.addEventListener('abort',relay,{once:true});if(context.signal.aborted)relay();
  const limit=stage==='version'?1024**2:16*1024**2,handles=[];let total=0,logError=null,result;
  const logs={stdout:{path:stage+'.stdout.log'},stderr:{path:stage+'.stderr.log'}};
  try{
    for(const channel of ['stdout','stderr'])handles.push(await open(join(directory,logs[channel].path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
    const append=index=>chunk=>{
      if(logError)return;
      try{
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),available=Math.max(0,limit-total),retained=bytes.subarray(0,available);
        for(let offset=0;offset<retained.length;){const count=writeSync(handles[index].fd,retained,offset,retained.length-offset);if(count<=0)fail('Log write made no progress');offset+=count;}
        total+=retained.length;if(retained.length!==bytes.length)fail('Build log byte limit exceeded');
      }catch(error){logError=String(error).slice(0,2048);controller.abort(logError);}
    };
    result=await boundedChild(compilerPath,args,{cwd:directory,env:environment,timeoutMs:context.remaining(),graceMs:1000,abortSignal:controller.signal,onStdout:append(0),onStderr:append(1)});
  }catch(error){result={code:null,signal:null,timedOut:false,interrupted:controller.signal.aborted,error:String(error).slice(0,2048)};}
  finally{context.signal.removeEventListener('abort',relay);for(const handle of handles){try{await handle.sync();}catch(error){logError??=String(error).slice(0,2048);}finally{try{await handle.close();}catch(error){logError??=String(error).slice(0,2048);}}}}
  const sealing=deadline(10_000);
  try{for(const channel of ['stdout','stderr']){const {identity}=await heldFile(join(directory,logs[channel].path),limit,sealing,{owned:true});logs[channel]={...logs[channel],bytes:identity.bytes,sha256:identity.sha256};}}
  finally{sealing.close();}
  return {stage,executable:compilerPath,args,cwd:directory,environment,
    result:{code:result.code??null,signal:result.signal??null,timedOut:result.timedOut===true,interrupted:result.interrupted===true,error:result.error??logError,timeoutMs:result.timeoutMs??null},logs};
}
function success(record){return record.result.code===0&&record.result.signal===null&&record.result.timedOut===false&&record.result.interrupted===false&&record.result.error===null;}
async function binaryIdentity(path,architecture,context){
  const {identity,data}=await heldFile(path,MAX_BINARY,context,{owned:true,collect:true});if(!identity.bytes||(identity.mode&0o777)!==0o700)fail('Collector binary must be private executable');
  if(data.length<32||data.readUInt32LE(0)!==0xfeedfacf||data.readUInt32LE(4)!==(architecture==='arm64'?0x0100000c:0x01000007)||data.readUInt32LE(12)!==2)fail('Expected matching 64-bit Mach-O executable');
  return identity;
}
function resultFor(receiptPath,receiptSha256,receipt){return {receiptPath,receiptSha256,sourceSha256:receipt.pins.sourceSha256,binaryPath:join(dirname(receiptPath),'windowserver-capture'),binarySha256:receipt.binary.sha256,compilerSha256:receipt.pins.compilerSha256,sdkTreeDigest:receipt.pins.sdkTreeDigest,qualification:false};}

export async function inspectWindowServerSdk(options){
  // Explicit read-only pin preparation. The observed identity is not a build;
  // build preparation still checks this pin before and after compiler execution.
  exact(options,['sdkPath','timeoutMs',...(Object.hasOwn(options??{},'abortSignal')?['abortSignal']:[])],'SDK inspection options');
  const {sdkPath,timeoutMs,abortSignal}=options;absolute(sdkPath,'SDK');const context=deadline(timeoutMs,abortSignal);
  try{
    const observed=await sdkIdentity(sdkPath,context),manifestSha256=hash(observed.bytes);context.check();
    return {sdkPath,sdkTreeDigest:observed.digest,entryCount:observed.manifest.entries.length,manifestBytes:observed.bytes.length,manifestSha256,qualification:false};
  }finally{context.close();}
}

export async function buildWindowServerCollector(options){
  exact(options,['sourcePath','sourceSha256','compilerPath','compilerSha256','sdkPath','sdkTreeDigest','outputDirectory','timeoutMs',...(Object.hasOwn(options??{},'abortSignal')?['abortSignal']:[])],'build options');
  const {sourcePath,sourceSha256,compilerPath,compilerSha256,sdkPath,sdkTreeDigest,outputDirectory,timeoutMs,abortSignal}=options;
  for(const [path,label]of [[sourcePath,'source'],[compilerPath,'compiler'],[sdkPath,'SDK'],[outputDirectory,'output']])absolute(path,label);
  if(![sourceSha256,compilerSha256,sdkTreeDigest].every(pin))fail('Explicit SHA-256 pins are required');
  if(basename(compilerPath)==='xcrun'||/^\/usr\/bin\/swift(?:c)?$/.test(compilerPath))fail('Compiler discovery shims are not admitted');
  if(outputDirectory===sdkPath||outputDirectory.startsWith(sdkPath+sep))fail('Build output must be outside SDK');
  const context=deadline(timeoutMs,abortSignal);let directoryCreated=false,receiptPath;
  const receipt={kind:KIND,schemaVersion:1,scope:SCOPE,qualification:false,status:'FAIL',startedAt:new Date().toISOString(),endedAt:null,host:{platform:platform(),arch:arch(),release:release()},timeoutMs,
    pins:{sourceSha256,compilerSha256,sdkTreeDigest},source:{path:sourcePath,retainedPath:'collector.swift',before:null,after:null,retained:null},compiler:{path:compilerPath,before:null,after:null},
    sdk:{path:sdkPath,manifestPath:'sdk-manifest.json',manifest:null,beforeDigest:null,afterDigest:null,entryCount:null},commands:[],binaryBefore:'unobserved',binary:null,error:null};
  try{
    context.check();await physical(dirname(outputDirectory),'directory');await mkdir(outputDirectory,{mode:0o700});directoryCreated=true;receiptPath=join(outputDirectory,'build-receipt.json');await privateDirectory(outputDirectory);
    for(const member of ['home','tmp','module-cache'])await mkdir(join(outputDirectory,member),{mode:0o700});
    const source=await heldFile(sourcePath,MAX_SOURCE,context,{collect:true});receipt.source.before=source.identity;if(source.identity.sha256!==sourceSha256)fail('Source pin mismatch');
    await exclusive(join(outputDirectory,'collector.swift'),source.data);receipt.source.retained=(await heldFile(join(outputDirectory,'collector.swift'),MAX_SOURCE,context,{owned:true})).identity;
    if(receipt.source.retained.sha256!==sourceSha256||receipt.source.retained.bytes!==source.identity.bytes)fail('Retained source pin mismatch');
    receipt.compiler.before=(await heldFile(compilerPath,MAX_COMPILER,context)).identity;if(receipt.compiler.before.sha256!==compilerSha256||(receipt.compiler.before.mode&0o111)===0)fail('Compiler pin or executable mode mismatch');
    const sdk=await sdkIdentity(sdkPath,context);receipt.sdk.beforeDigest=sdk.digest;receipt.sdk.entryCount=sdk.manifest.entries.length;if(sdk.digest!==sdkTreeDigest)fail('SDK pin mismatch');
    await exclusive(join(outputDirectory,'sdk-manifest.json'),sdk.bytes);const sdkSeal=(await heldFile(join(outputDirectory,'sdk-manifest.json'),MAX_MANIFEST,context,{owned:true})).identity;receipt.sdk.manifest={bytes:sdkSeal.bytes,sha256:sdkSeal.sha256};
    const invocation=contract(outputDirectory,compilerPath,sdkPath,receipt.host.arch);
    for(const stage of ['version','build']){
      if(stage==='build'){const existing=await lstat(invocation.binaryPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(existing)fail('Binary existed before compiler invocation');receipt.binaryBefore=null;}
      const observed=await command(stage,invocation[stage],compilerPath,outputDirectory,invocation.environment,context);receipt.commands.push(observed);if(!success(observed))fail('Compiler '+stage+' failed');
    }
    const binary=await physical(invocation.binaryPath,'file');if(binary.uid!==process.getuid()||binary.nlink!==1||(binary.mode&0o111)===0)fail('Compiler output is not an owned executable');
    await chmod(invocation.binaryPath,0o700);receipt.binary=await binaryIdentity(invocation.binaryPath,receipt.host.arch,context);
    receipt.source.after=(await heldFile(sourcePath,MAX_SOURCE,context)).identity;same(receipt.source.before,receipt.source.after,'Source changed during build');
    same(receipt.source.retained,(await heldFile(join(outputDirectory,'collector.swift'),MAX_SOURCE,context,{owned:true})).identity,'Retained source changed');
    receipt.compiler.after=(await heldFile(compilerPath,MAX_COMPILER,context)).identity;same(receipt.compiler.before,receipt.compiler.after,'Compiler changed during build');
    receipt.sdk.afterDigest=(await sdkIdentity(sdkPath,context)).digest;if(receipt.sdk.afterDigest!==sdkTreeDigest)fail('SDK changed during build');
    await privateDirectory(outputDirectory);context.check();receipt.status='PASS';
  }catch(error){receipt.error=String(error).slice(0,2048);}
  finally{context.close();}
  if(!directoryCreated)throw Error(receipt.error??'Build preparation failed');
  receipt.endedAt=new Date().toISOString();const bytes=json(receipt);if(bytes.length>MAX_RECEIPT)fail('Build receipt bound exceeded');
  const sealing=deadline(10_000);
  try{sealing.check();await exclusive(receiptPath,bytes);const {identity}=await heldFile(receiptPath,MAX_RECEIPT,sealing,{owned:true});
    same(identity,{bytes:bytes.length,sha256:hash(bytes),mode:0o600},'Build receipt seal mismatch');sealing.check();
    if(receipt.status!=='PASS')throw Object.assign(Error(receipt.error??'Build failed'),{receiptPath,receiptSha256:identity.sha256,outputDirectory});
    return resultFor(receiptPath,identity.sha256,receipt);
  }catch(error){error.outputDirectory??=outputDirectory;throw error;}finally{sealing.close();}
}

function verificationContext(options){
  exact(options,[...(Object.hasOwn(options??{},'abortSignal')?['abortSignal']:[]),...(Object.hasOwn(options??{},'timeoutMs')?['timeoutMs']:[])],'verification options');
  const timeoutMs=options.timeoutMs??10_000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_VERIFY_TIMEOUT)fail('Invalid verification timeout');
  return deadline(timeoutMs,options.abortSignal);
}
async function verifyBuildMembers({receiptPath,receiptSha256,sourceSha256},context,{live}){
  absolute(receiptPath,'receipt');if(basename(receiptPath)!=='build-receipt.json'||!pin(receiptSha256)||!pin(sourceSha256))fail('Invalid build receipt pin');
  const directory=dirname(receiptPath);
    context.check();await privateDirectory(directory);const retained=await heldFile(receiptPath,MAX_RECEIPT,context,{collect:true,owned:true});if(retained.identity.sha256!==receiptSha256)fail('Build receipt hash mismatch');
    const receipt=JSON.parse(retained.data.toString('utf8'));
    exact(receipt,['kind','schemaVersion','scope','qualification','status','startedAt','endedAt','host','timeoutMs','pins','source','compiler','sdk','commands','binaryBefore','binary','error'],'receipt');
    if(receipt.kind!==KIND||receipt.schemaVersion!==1||receipt.scope!==SCOPE||receipt.qualification!==false||receipt.status!=='PASS'||receipt.error!==null||receipt.binaryBefore!==null)fail('Build receipt is not an admitted successful observed build');
    exact(receipt.pins,['sourceSha256','compilerSha256','sdkTreeDigest'],'pins');if(!Object.values(receipt.pins).every(pin)||receipt.pins.sourceSha256!==sourceSha256)fail('Build source pin mismatch');
    exact(receipt.host,['platform','arch','release'],'host');targetFor(receipt.host.arch);
    if(typeof receipt.host.platform!=='string'||typeof receipt.host.release!=='string'||!Number.isSafeInteger(receipt.timeoutMs)||receipt.timeoutMs<1||receipt.timeoutMs>MAX_TIMEOUT||typeof receipt.startedAt!=='string'||typeof receipt.endedAt!=='string'||!Number.isFinite(Date.parse(receipt.startedAt))||!Number.isFinite(Date.parse(receipt.endedAt))||Date.parse(receipt.endedAt)<Date.parse(receipt.startedAt))fail('Invalid build metadata');
    exact(receipt.source,['path','retainedPath','before','after','retained'],'source');exact(receipt.compiler,['path','before','after'],'compiler');exact(receipt.sdk,['path','manifestPath','manifest','beforeDigest','afterDigest','entryCount'],'SDK');
    absolute(receipt.source.path,'source');absolute(receipt.compiler.path,'compiler');absolute(receipt.sdk.path,'SDK');
    if(!Array.isArray(receipt.commands)||receipt.commands.length!==2)fail('Missing build commands');
    const originalDirectory=absolute(receipt.commands[0]?.cwd,'historical build directory');
    if(live&&originalDirectory!==directory)fail('Runtime build directory changed');
    if(basename(receipt.compiler.path)==='xcrun'||/^\/usr\/bin\/swift(?:c)?$/.test(receipt.compiler.path)||originalDirectory===receipt.sdk.path||originalDirectory.startsWith(receipt.sdk.path+sep))fail('Invalid build input boundaries');
    if(receipt.source.retainedPath!=='collector.swift'||receipt.sdk.manifestPath!=='sdk-manifest.json')fail('Unexpected retained build member');
    const copy=(await heldFile(join(directory,'collector.swift'),MAX_SOURCE,context,{owned:true})).identity;
    recordedFile(receipt.source.before,MAX_SOURCE,'source before');recordedFile(receipt.source.after,MAX_SOURCE,'source after');
    same(receipt.source.before,receipt.source.after,'Source before/after mismatch');
    if(copy.sha256!==sourceSha256||copy.sha256!==receipt.source.before.sha256||copy.bytes!==receipt.source.before.bytes)fail('Build source bytes mismatch');
    same(copy,receipt.source.retained,'Retained source mismatch');
    let source;if(live){source=(await heldFile(receipt.source.path,MAX_SOURCE,context)).identity;if(source.sha256!==sourceSha256)fail('Build source bytes mismatch');same(source,receipt.source.before,'Source before mismatch');}
    recordedFile(receipt.compiler.before,MAX_COMPILER,'compiler before');recordedFile(receipt.compiler.after,MAX_COMPILER,'compiler after');
    if(!receipt.compiler.before.bytes||receipt.compiler.before.sha256!==receipt.pins.compilerSha256||(receipt.compiler.before.mode&0o111)===0)fail('Build compiler mismatch');same(receipt.compiler.before,receipt.compiler.after,'Compiler before/after mismatch');
    const manifest=await heldFile(join(directory,'sdk-manifest.json'),MAX_MANIFEST,context,{collect:true,owned:true});
    same({bytes:manifest.identity.bytes,sha256:manifest.identity.sha256},receipt.sdk.manifest,'Retained SDK manifest identity mismatch');
    const sdkManifest=JSON.parse(manifest.data.toString('utf8')),sdkDigest=await retainedSdkIdentity(sdkManifest,receipt.sdk.path,context);
    if(sdkDigest!==receipt.pins.sdkTreeDigest||sdkDigest!==receipt.sdk.beforeDigest||sdkDigest!==receipt.sdk.afterDigest||sdkManifest.entries.length!==receipt.sdk.entryCount)fail('Build SDK mismatch');
    const invocation=contract(originalDirectory,receipt.compiler.path,receipt.sdk.path,receipt.host.arch);
    for(const [index,stage]of ['version','build'].entries()){
      const observed=receipt.commands[index];exact(observed,['stage','executable','args','cwd','environment','result','logs'],'command');
      if(observed.stage!==stage||observed.executable!==receipt.compiler.path||observed.cwd!==originalDirectory)fail('Unexpected compiler invocation');same(observed.args,invocation[stage],'Compiler argv mismatch');same(observed.environment,invocation.environment,'Compiler environment mismatch');
      exact(observed.result,['code','signal','timedOut','interrupted','error','timeoutMs'],'command result');if(!success(observed)||!Number.isSafeInteger(observed.result.timeoutMs)||observed.result.timeoutMs<1||observed.result.timeoutMs>receipt.timeoutMs)fail('Unsuccessful compiler observation');
      exact(observed.logs,['stdout','stderr'],'command logs');let combined=0;
      for(const channel of ['stdout','stderr']){
        const log=observed.logs[channel];exact(log,['path','bytes','sha256'],'log');if(log.path!==stage+'.'+channel+'.log')fail('Unexpected compiler log path');
        const actual=(await heldFile(join(directory,log.path),16*1024**2,context,{owned:true})).identity;combined+=actual.bytes;same({path:log.path,bytes:actual.bytes,sha256:actual.sha256},log,'Compiler log mismatch');
      }
      if(combined>(stage==='version'?1024**2:16*1024**2))fail('Compiler logs exceed bound');
    }
    same(await binaryIdentity(join(directory,'windowserver-capture'),receipt.host.arch,context),receipt.binary,'Collector binary identity mismatch');
    if(live)same(source,(await heldFile(receipt.source.path,MAX_SOURCE,context)).identity,'Source changed during verification');
    same(retained.identity,(await heldFile(receiptPath,MAX_RECEIPT,context,{owned:true})).identity,'Receipt changed during verification');await privateDirectory(directory);context.check();
    return resultFor(receiptPath,receiptSha256,receipt);
}
export async function verifyWindowServerBuild(inputs,options={}){
  // receiptSha256 comes from the separately trusted build handoff. Self-consistent
  // caller-authored provenance is not execution authority. Only explicit build
  // preparation scans live compiler/SDK bytes; campaign admission reads retained
  // build evidence plus current source/binary under its own deadline.
  exact(inputs,['receiptPath','receiptSha256','sourceSha256'],'verification inputs');
  const context=verificationContext(options);
  try{return await verifyBuildMembers(inputs,context,{live:true});}finally{context.close();}
}
function evidenceResult(directory,identity,manifest){
  return {directory,manifestPath:join(directory,'manifest.json'),manifestBytes:identity.bytes,manifestSha256:identity.sha256,
    sourceSha256:manifest.sourceSha256,receiptSha256:manifest.receiptSha256,binaryPath:join(directory,'windowserver-capture'),binarySha256:manifest.binarySha256,qualification:false};
}
async function verifyEvidenceMembers({directory,manifestSha256,sourceSha256},context){
  absolute(directory,'build evidence directory');if(!pin(manifestSha256)||!pin(sourceSha256))fail('Invalid build evidence pin');
  context.check();await privateDirectory(directory);
  const manifestPath=join(directory,'manifest.json'),retained=await heldFile(manifestPath,MAX_RECEIPT,context,{owned:true,collect:true});
  if(retained.identity.sha256!==manifestSha256||retained.identity.mode!==0o600)fail('Build evidence manifest mismatch');
  const manifest=JSON.parse(retained.data.toString('utf8'));
  exact(manifest,['kind','schemaVersion','scope','qualification','sourceSha256','receiptSha256','binarySha256','compilerSha256','sdkTreeDigest','members'],'build evidence manifest');
  if(manifest.kind!==EVIDENCE_KIND||manifest.schemaVersion!==1||manifest.scope!==SCOPE||manifest.qualification!==false||manifest.sourceSha256!==sourceSha256||![manifest.sourceSha256,manifest.receiptSha256,manifest.binarySha256,manifest.compilerSha256,manifest.sdkTreeDigest].every(pin))fail('Invalid build evidence identity');
  if(!Array.isArray(manifest.members)||manifest.members.length!==EVIDENCE_MEMBERS.length)fail('Invalid build evidence members');
  const expectedNames=['manifest.json',...EVIDENCE_MEMBERS.map(([path])=>path)].sort();
  same((await readdir(directory)).sort(),expectedNames,'Unexpected build evidence inventory');
  for(const [index,[path,maxBytes,mode]]of EVIDENCE_MEMBERS.entries()){
    const member=manifest.members[index];exact(member,['path','bytes','sha256','mode'],'build evidence member');
    if(member.path!==path||member.mode!==mode)fail('Invalid build evidence member path or mode');
    const actual=(await heldFile(join(directory,path),maxBytes,context,{owned:true})).identity;
    same({path,...actual},member,'Build evidence member mismatch');
  }
  const built=await verifyBuildMembers({receiptPath:join(directory,'build-receipt.json'),receiptSha256:manifest.receiptSha256,sourceSha256},context,{live:false});
  for(const key of ['sourceSha256','receiptSha256','binarySha256','compilerSha256','sdkTreeDigest'])if(built[key]!==manifest[key])fail('Build evidence receipt mismatch');
  same(retained.identity,(await heldFile(manifestPath,MAX_RECEIPT,context,{owned:true})).identity,'Build evidence manifest changed');
  same((await readdir(directory)).sort(),expectedNames,'Build evidence inventory changed');await privateDirectory(directory);context.check();
  return evidenceResult(directory,retained.identity,manifest);
}
export async function verifyWindowServerBuildEvidence(inputs,options={}){
  // Offline evidence checks use retained members only. The manifest pin must be
  // authenticated by the containing campaign packet; this is still not an oracle.
  exact(inputs,['directory','manifestSha256','sourceSha256'],'build evidence inputs');
  const context=verificationContext(options);
  try{return await verifyEvidenceMembers(inputs,context);}finally{context.close();}
}
export async function retainWindowServerBuildEvidence(inputs,options){
  exact(inputs,['receiptPath','receiptSha256','sourceSha256'],'retention inputs');
  exact(options,['directory',...(Object.hasOwn(options??{},'abortSignal')?['abortSignal']:[]),...(Object.hasOwn(options??{},'timeoutMs')?['timeoutMs']:[])],'retention options');
  const {directory,...limits}=options;absolute(directory,'build evidence directory');
  const context=verificationContext(limits);let created=false;
  try{
    const build=await verifyBuildMembers(inputs,context,{live:true});
    const originalDirectory=dirname(build.receiptPath);if(directory===originalDirectory||directory.startsWith(originalDirectory+sep))fail('Build evidence must be outside build output');
    const originalReceipt=await heldFile(build.receiptPath,MAX_RECEIPT,context,{owned:true,collect:true});if(originalReceipt.identity.sha256!==build.receiptSha256)fail('Build receipt changed before retention');
    const sdkPath=JSON.parse(originalReceipt.data.toString('utf8')).sdk.path;if(directory===sdkPath||directory.startsWith(sdkPath+sep))fail('Build evidence must be outside SDK');
    context.check();await physical(dirname(directory),'directory');await mkdir(directory,{mode:0o700});created=true;await privateDirectory(directory);
    const members=[];
    for(const [path,maxBytes,mode]of EVIDENCE_MEMBERS){
      const original=await heldFile(join(originalDirectory,path),maxBytes,context,{owned:true,collect:true});
      if(original.identity.mode!==mode)fail('Unexpected retained build member mode');
      context.check();await exclusive(join(directory,path),original.data);if(mode!==0o600)await chmod(join(directory,path),mode);
      const copy=(await heldFile(join(directory,path),maxBytes,context,{owned:true})).identity;same(original.identity,copy,'Build evidence copy mismatch');members.push({path,...copy});
    }
    const manifest={kind:EVIDENCE_KIND,schemaVersion:1,scope:SCOPE,qualification:false,sourceSha256:build.sourceSha256,receiptSha256:build.receiptSha256,binarySha256:build.binarySha256,compilerSha256:build.compilerSha256,sdkTreeDigest:build.sdkTreeDigest,members};
    const copied=await verifyBuildMembers({receiptPath:join(directory,'build-receipt.json'),receiptSha256:build.receiptSha256,sourceSha256:build.sourceSha256},context,{live:false});
    if(copied.binarySha256!==build.binarySha256)fail('Copied build identity mismatch');
    const bytes=json(manifest);if(bytes.length>MAX_RECEIPT)fail('Build evidence manifest bound exceeded');context.check();await exclusive(join(directory,'manifest.json'),bytes);
    const result=await verifyEvidenceMembers({directory,manifestSha256:hash(bytes),sourceSha256:build.sourceSha256},context);
    same(await verifyBuildMembers(inputs,context,{live:true}),build,'Build changed during retention');context.check();return result;
  }catch(error){if(created)error.evidenceDirectory=directory;throw error;}finally{context.close();}
}

async function main(args){
  if(args.length!==3||!['build','sdk-identity'].includes(args[0]))fail('Usage: windowserver-build.mjs build CONFIG_JSON NEW_OUTPUT_DIRECTORY | sdk-identity SDK_PATH TIMEOUT_MS');
  const controller=new AbortController(),interrupt=()=>controller.abort('SIGINT'),terminate=()=>controller.abort('SIGTERM');process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  try{
    if(args[0]==='sdk-identity'){
      if(!/^[1-9][0-9]*$/.test(args[2]))fail('Expected explicit SDK inspection timeout in milliseconds');
      console.log(JSON.stringify(await inspectWindowServerSdk({sdkPath:absolute(args[1],'SDK'),timeoutMs:Number(args[2]),abortSignal:controller.signal})));return;
    }
    const configPath=absolute(args[1],'build configuration'),context=deadline(10_000,controller.signal);let data;
    try{data=(await heldFile(configPath,64*1024,context,{collect:true})).data;}finally{context.close();}
    const config=JSON.parse(data.toString('utf8'));exact(config,['sourcePath','sourceSha256','compilerPath','compilerSha256','sdkPath','sdkTreeDigest','timeoutMs'],'CLI configuration');
    console.log(JSON.stringify(await buildWindowServerCollector({...config,outputDirectory:absolute(args[2],'output'),abortSignal:controller.signal})));
  }
  finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
if(import.meta.main)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({error:String(error),receiptPath:error.receiptPath??null,receiptSha256:error.receiptSha256??null,qualification:false}));process.exitCode=1;});
