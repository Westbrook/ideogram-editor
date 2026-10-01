import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {product,phase,createProductFixture,createDocument,stageBlob,finish,envelope} from './backend-common.mjs';

export const supportedCells=Object.freeze(['WJ25','WJ26','WJ27','WJ28','WJ29','WJ30']);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const dataURL=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');

/** Load the shipped browser admission algorithm without duplicating its rules.
 * Contracts contain browser helpers, but importing them does not call those
 * helpers. Only scanText executes. Source and transformed identities accompany
 * every observation; this is not a server text-shaping/acceptance shortcut.
 */
export async function loadNativeAdmission(context){
 const repo=resolve(context.repo??process.cwd()),require=createRequire(join(repo,'package.json'));
 const vitePath=require.resolve('vite'),vite=await import(pathToFileURL(vitePath).href);
 if(typeof vite.transformWithOxc!=='function')throw Object.assign(Error('Pinned Vite TypeScript transformer unavailable'),{code:'NATIVE_ADMISSION_TRANSFORM_UNAVAILABLE'});
 const paths=['src/text/contracts.ts','src/text/admission.ts'];
 const sources=await Promise.all(paths.map(path=>readFile(join(repo,path),'utf8')));
 const transformed=await Promise.all(sources.map((source,i)=>vite.transformWithOxc(source,paths[i])));
 const contracts=dataURL(transformed[0].code),specifier=/(['"])\.\/contracts\1/g;
 const imports=transformed[1].code.match(specifier)??[];
 assert.equal(imports.length,1,'Admission must retain exactly one production contracts import');
 const admissionCode=transformed[1].code.replace(specifier,JSON.stringify(contracts));
 const api=await import(dataURL(admissionCode));
 assert.equal(typeof api.scanText,'function');
 const {Texts}=await product(context,'server/storage/text.js');
 assert.equal(typeof Texts?.prototype.limits,'function');
 return {scanText:api.scanText,documentLimits:Texts.prototype.limits,identity:{
  transformer:'pinned-vite-transformWithOxc',transformerEntryHash:hash(await readFile(vitePath)),
  sources:paths.map((path,i)=>({path,sha256:hash(sources[i]),transformedHash:hash(transformed[i].code)})),
  documentLimits:{path:'dist/local/server/storage/text.js',sha256:hash(await readFile(join(repo,'dist/local/server/storage/text.js')))}
 }};
}

/** Finite admission only. Document source lookup is a disclosed metadata
 * fixture: the real Texts.limits method counts the exact scanText byte lengths.
 * It neither approves native source versions nor substitutes for font shaping.
 */
export function inspectNativeAdmission(api,value){
 assert(value&&Array.isArray(value.texts)&&value.texts.every(text=>typeof text==='string'));
 const layers=[],sources=new Map(),outcomes=[];
 for(const [index,text] of value.texts.entries()){
  try{
   const scanned=api.scanText(text),source={hash:'fixture_native_source_'+index};
   sources.set(source.hash,{text:{textUtf8:{byteLength:String(scanned.bytes)},fonts:[]}});
   layers.push({kind:'text',source});outcomes.push({index,status:'admitted',...scanned});
  }catch(error){
   if(!['TEXT_BYTES','TEXT_LINES','TEXT_SURROGATE'].includes(error?.code))throw error;
   outcomes.push({index,status:'rejected',code:error.code});
  }
 }
 let code=outcomes.find(outcome=>outcome.status==='rejected')?.code??null,documentChecked=false;
 if(code===null){
  documentChecked=true;
  try{api.documentLimits.call({source:ref=>{assert(sources.has(ref.hash));return sources.get(ref.hash);}},{layers});}
  catch(error){if(error?.reason!=='TEXT_DOCUMENT_LIMIT')throw error;code=error.reason;}
 }
 return {code,outcomes,documentChecked,admittedTextBytes:outcomes.reduce((sum,value)=>sum+(value.bytes??0),0),layers:value.texts.length};
}

/** Observe the real Texts.source path, including immutable source and text-byte
 * reads. The wrapper delegates every decision to the production implementation;
 * it supplies no replacement source metadata and is restored before returning.
 */
export function inspectStoredAdmission(api,store,state,id){
 assert(state&&Array.isArray(state.layers));
 const source=store.texts.source,sources=[];
 store.texts.source=function(ref){
  const value=source.call(this,ref),bytes=store.objects.verify(value.text.textUtf8,true);
  assert(bytes instanceof Uint8Array);assert.equal(hash(bytes),value.text.textUtf8.hash);assert.equal(String(bytes.length),value.text.textUtf8.byteLength);
  const scanned=api.scanText(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
  sources.push({source:ref.hash,text:value.text.textUtf8.hash,bytes:scanned.bytes,lines:scanned.lines});
  return value;
 };
 let code=null;
 try{store.texts.limits(state);}catch(error){if(error?.reason!=='TEXT_DOCUMENT_LIMIT')throw error;code=error.reason;}
 finally{store.texts.source=source;}
 const textBytes=sources.reduce((sum,item)=>sum+item.bytes,0);
 assert(sources.length>0,'real native source fixture is required');
 if(id==='WJ26'){assert.equal(code,'TEXT_DOCUMENT_LIMIT');assert.equal(textBytes,1048577);assert(state.layers.length<=100);}
 else {assert.equal(code,null);if(id==='WJ29'){assert(sources.some(item=>item.bytes===16384));assert(sources.some(item=>item.lines===256));}if(id==='WJ30'){assert.equal(sources.length,75);assert.equal(textBytes,1048576);}}
 return {code,textBytes,layers:state.layers.length,nativeLayers:sources.length,sources};
}

/** Small mailbox descriptors name only owned immutable sample inputs. The
 * native state itself never has to fit the control channel's 64KiB limit. */
export async function readNativeStateFile(root,descriptor){
 assert.equal(typeof root,'string');assert(descriptor&&typeof descriptor==='object');
 assert.match(descriptor.path??'',/^qualification-composition-inputs\/native-[a-f0-9-]{36}\.json$/);
 assert.match(descriptor.sha256??'',/^sha256:[a-f0-9]{64}$/);assert.match(String(descriptor.byteLength),/^[1-9][0-9]*$/);
 assert(Number(descriptor.byteLength)<=1048576,'native state metadata exceeds bounded input limit');
 const directory=await lstat(join(root,'qualification-composition-inputs'));assert(directory.isDirectory()&&!directory.isSymbolicLink());
 const path=join(root,descriptor.path),before=await lstat(path);assert(before.isFile()&&!before.isSymbolicLink());
 const bytes=await readFile(path),after=await lstat(path);
 assert.equal(bytes.length,Number(descriptor.byteLength));assert.equal(hash(bytes),descriptor.sha256);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],'native state input changed');
 const state=JSON.parse(bytes.toString('utf8'));assert(state&&Array.isArray(state.layers));return state;
}

/** Runs inside the retained production writer, without closing/reopening it.
 * Loading the shipped validator and reading the immutable case descriptor are
 * setup; only actual admission and durable-source loading enter R33's span. */
export async function runNativeWorkerAdmission(store,payload,config){
 assert.equal(payload.action,'native-admission');assert(supportedCells.includes(payload.caseId));
 const state=config.state??await readNativeStateFile(config.root,payload.stateFile);
 const {makeCompositionFixture}=await import('./backend-composition.mjs'),specimen=makeCompositionFixture(payload.caseId);
 if(payload.corpusHash)assert.equal(payload.corpusHash,specimen.sha256,'worker uses the same sealed native case');
 const value=JSON.parse(specimen.bytes.toString('utf8')),api=await loadNativeAdmission(config),phases=[];
 let storedAdmission=null,admission=null,error=null;
 try{
  admission=await phase(phases,'text.admission',()=>{
   const result=inspectNativeAdmission(api,value);storedAdmission=inspectStoredAdmission(api,store,state,payload.caseId);
   assert.equal(result.code,value.expected);return result;
  });
 }catch(failure){error={name:failure.name??'Error',code:failure.code??null,message:String(failure.message??failure)};}
 // Errors within the measured operation cross the mailbox as data so its
 // failing span survives. The controller reconstructs and reports the error.
 return {phase:phases[0],admission,storedAdmission,implementation:api.identity,...error?{error}:{}};
}

async function workerState(fixture,state){
 const directory=join(fixture.root,'qualification-composition-inputs');await mkdir(directory,{recursive:true,mode:0o700});
 const path='qualification-composition-inputs/native-'+randomUUID()+'.json',bytes=Buffer.from(JSON.stringify(state));
 assert(bytes.length<=1048576);await writeFile(join(fixture.root,path),bytes,{flag:'wx',mode:0o600});
 return {path,sha256:hash(bytes),byteLength:String(bytes.length)};
}

async function specimen(context,id){
 const {makeCompositionFixture}=await import('./backend-composition.mjs'),expected=makeCompositionFixture(id);
 const entry=context.fixture?.corpus?.files?.find(value=>value.id===id);
 if(!entry)return {...expected,sealed:false};
 const bytes=await readFile(resolve(context.fixture.root??'',entry.path));
 assert.equal(hash(bytes).replace(/^sha256:/,''),String(entry.sha256).replace(/^sha256:/,''),'sealed native corpus hash');
 assert.equal(hash(bytes),expected.sha256,'native corpus is the exact named fixture');
 assert.equal(bytes.length,expected.byteLength);assert.equal(Number(entry.byteLength),bytes.length,'sealed native corpus byte length');
 return {...expected,bytes,sealed:true};
}

function identifier(cell){
 for(const value of [typeof cell==='string'?cell:cell?.operation,cell?.parameters?.caseId,cell?.id])if(supportedCells.includes(value))return value;
 return null;
}

export async function runCell(context,cell){
 const id=identifier(cell),phases=[],out={cellId:id??cell?.id??null,status:'pass',phases,assertions:[],observations:{},evidence:[],missing:[]};
 if(!id){out.status='inconclusive';out.missing.push('unsupported native composition case');return out;}
 let fixture,ownedFixture=false;
 try{
  context.signal?.throwIfAborted();
  const corpus=await specimen(context,id),originalHash=hash(corpus.bytes);
  // Parse the original JSON wrapper. In particular, never pass a lone UTF-16
  // surrogate to Buffer.from(text), which would irreversibly replace it.
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(corpus.bytes));
  fixture=context.productFixture;
  if(!fixture){fixture=await phase(phases,'native-admission.private-writer-setup',()=>createProductFixture(context));ownedFixture=true;await phase(phases,'native-admission.document-setup',()=>createDocument(fixture));}
  const retained=!!context.productFixture;
  if(retained&&(!fixture.compositionState||!fixture.compositionWorker))throw Object.assign(Error('Retained native admission requires its production writer mailbox'),{code:'NATIVE_RETAINED_WORKER_UNAVAILABLE'});
  const before=await fixture.writer.imageState(fixture.documentId),bindings=structuredClone(before.composition?.bindings??{});
  const configured=context.fixture?.nativeAdmissionCases?.[id]??context.fixture?.observed?.nativeAdmissionCases?.[id];
  const storedState=configured?.state??(['WJ25','WJ27','WJ28','WJ30'].includes(id)&&before.layers.some(layer=>layer.kind==='text')?before:null);
  let storedAdmission=null,admission,implementation,stateFile=null;
  if(retained&&storedState){
   stateFile=await workerState(fixture,storedState);
   const observed=await fixture.compositionWorker.execute({action:'native-admission',caseId:id,stateFile,corpusHash:corpus.sha256});
   assert.equal(observed.phase?.name,'text.admission');phases.push(observed.phase);
   if(observed.error)throw Object.assign(Error(observed.error.message),{name:observed.error.name??'Error',code:observed.error.code??undefined});
   admission=observed.admission;storedAdmission=observed.storedAdmission;implementation=observed.implementation;
  }else{
   const api=await phase(phases,'native-admission.load-shipped-implementation',()=>loadNativeAdmission(context));implementation=api.identity;
   // A retained writer is never closed merely to exercise the totals kernel.
   // Without durable sources, preserve the explicit inconclusive result below.
   const stored=storedState&&!retained?await fixture.direct():null;
   admission=await phase(phases,'text.admission',()=>{const result=inspectNativeAdmission(api,value);if(stored)storedAdmission=inspectStoredAdmission(api,stored,storedState,id);return result;});
   if(stored)await phase(phases,'native-admission.restore-writer-after-source-validation',()=>fixture.reopen());
  }
  assert.equal(admission.code,value.expected,'exact native admission outcome');
  if(id==='WJ26'){assert(admission.outcomes.every(outcome=>outcome.status==='admitted'));assert.equal(admission.admittedTextBytes,1048577);assert(admission.documentChecked);}
  if(id==='WJ29'){assert.equal(admission.outcomes[0].bytes,16384);assert.equal(admission.outcomes[1].lines,256);assert(admission.documentChecked);}
  if(id==='WJ30'){assert.equal(admission.layers,75);assert.equal(admission.admittedTextBytes,1048576);assert(admission.documentChecked);}
  if(id==='WJ28'){assert(corpus.bytes.includes(Buffer.from('\\ud800')));assert.equal(value.texts[0].charCodeAt(0),0xd800);assert(!corpus.bytes.includes(Buffer.from([0xef,0xbf,0xbd])));}
  out.assertions.push({name:'every layer runs shipped scanText and exact named outcome is retained',passed:true});
  if(admission.documentChecked)out.assertions.push({name:'production Texts.limits applies document byte and layer totals',passed:true});
  if(storedAdmission)out.assertions.push({name:'real stored native source and text bytes validated and loaded inside the R33 admission phase',passed:true});
  const composition=await product(context,'src/composition/core.js');
  let graph;
  if(before.composition){
   const ref=before.composition.value,bytes=await readFile(join(fixture.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7)));
   assert.equal(hash(bytes),ref.hash);graph=JSON.parse(bytes.toString('utf8'));composition.validateComposition(graph);assert.equal(graph.id,before.composition.id);
   graph.id=randomUUID();graph.review=null;
  }else graph=composition.emptyComposition(before.width,before.height,randomUUID());
  let original,graphRef;
  await phase(phases,'native-admission.retain-exact-recovery-json',async()=>{
   original=await stageBlob(fixture,corpus.bytes,'text','application/octet-stream');
   graph.raw.push(original.blob);
   const storedGraph=await stageBlob(fixture,Buffer.from(JSON.stringify(graph)),'text','application/octet-stream');
   graphRef={...storedGraph.blob,mediaType:'application/json'};
  });
  const request=envelope({type:'CommitCompositionVersion',composition:{id:graph.id,value:graphRef,bindings},draft:null},{documentId:fixture.documentId,expectedDocumentRevision:await fixture.writer.documentRevision(fixture.documentId)});
  const accepted=await phase(phases,'native-admission.composition-history-append',()=>finish(fixture.writer,request,'historyCommand',context.signal));
  assert(accepted.events.some(event=>event.type==='ImageEdited'));
  const acceptedDocument=await fixture.writer.document(fixture.documentId);
  assert.equal(acceptedDocument.compositionVersion,graph.id);
  await phase(phases,retained?'native-admission.verify-original-closure-with-retained-writer':'native-admission.reopen-and-verify-original-closure',async()=>{
   if(!retained)await fixture.reopen();
   const document=await fixture.writer.document(fixture.documentId);assert.deepEqual(document,acceptedDocument);
   const replayed=await fixture.writer.commandState(request.command.commandId);assert.deepEqual(replayed.record.receipt,accepted.receipt);
   const state=await fixture.writer.imageState(fixture.documentId);assert.equal(state.composition.id,graph.id);assert.deepEqual(state.layers,before.layers);assert.equal(state.width,before.width);assert.equal(state.height,before.height);assert.deepEqual(state.composition.bindings,bindings);
   let cursor='',rooted=false;
   do{const page=await fixture.writer.historyClosure(fixture.documentId,cursor);rooted ||= page.items.some(ref=>ref.hash===original.blob.hash);cursor=page.next;}while(cursor);
   assert(rooted,'Original recovery JSON is a retained composition-history dependency');
   const restored=await readFile(join(fixture.root,'objects','sha256',original.blob.hash.slice(7,9),original.blob.hash.slice(7)));
   assert.equal(hash(restored),originalHash);assert.deepEqual(restored,corpus.bytes);assert.deepEqual(JSON.parse(restored.toString('utf8')),value);
   if(id==='WJ28')assert.equal(JSON.parse(restored.toString('utf8')).texts[0].charCodeAt(0),0xd800);
  });
  out.assertions.push({name:retained?'exact original JSON is retained by accepted composition history and closure in the existing writer':'exact original JSON survives accepted composition history, closure rooting and writer restart',passed:true},{name:'admission fixture never manufactures a shaped native layer or accepted native text source',passed:true});
  out.observations={id,scope:storedAdmission?'stored-native-admission-and-durable-recovery':'finite-native-admission-and-durable-recovery',admission,storedAdmission,implementation,sealedCorpus:corpus.sealed,originalBytes:corpus.bytes.length,originalHash,providerEffects:0,existingLayersPreserved:before.layers.length,documentGrid:{width:before.width,height:before.height},retainedWriter:retained,writer:retained?fixture.compositionWorker.descriptor??{epoch:fixture.writer.epoch}:null,substitutedBoundary:storedAdmission?null:'Texts.source metadata lookup for Texts.limits only; byte lengths come from actual scanText',cacheBehavior:retained?'Existing production writer and its validator module/cache remain alive; text.admission runs inside that writer through the no-network mailbox.':'Fresh owned namespace and writer; shipped validator remains in the calling process, stored-source validator runs in that process through the sole database owner.',notClaimed:['font loading or shaping','CreateTextLayer or CommitTextEdit acceptance','native layout/raster correctness',...(!storedAdmission?['R33 complete durable-source validation/loading cost']:[])]};
  out.evidence.push({root:fixture.root,originalRef:original.blob,graphRef,commandId:request.command.commandId,receipt:accepted.receipt,...stateFile?{stateFile}:{}});
  if(!corpus.sealed){out.status='inconclusive';out.missing.push('presealed WJ native corpus manifest');}
  // A real scanText invocation plus the real totals kernel does not include
  // Texts.source validation/loading. Disclosing the substitute is insufficient
  // to qualify the R33 cell: keep it explicitly incomplete until that real
  // stored-source path is exercised with a sealed WX fixture.
  if(!storedAdmission){out.status='inconclusive';out.missing.push('R33 durable native source validation/loading is not exercised by the metadata-only document-limit fixture');}
  return out;
 }catch(error){
  const absent=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','NATIVE_ADMISSION_TRANSFORM_UNAVAILABLE','NATIVE_RETAINED_WORKER_UNAVAILABLE','ABORT_ERR'].includes(error?.code)||error?.name==='AbortError';
  out.status=absent?'inconclusive':'fail';
  if(absent)out.missing.push({code:error.code??error.name,message:error.message});
  else out.assertions.push({name:'native admission or durable recovery invariant',passed:false,error:{code:error?.code??null,message:String(error?.message??error)}});
  return out;
 }finally{if(fixture&&ownedFixture)await fixture.close();}
}
