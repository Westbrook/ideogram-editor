// CONTRACT TEST DATA ONLY. These fabricated records exercise validation and
// byte binding. They do not record image work, platform execution or product
// qualification and must never be installed in an inventory or evidence tree.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG_CASES,PNG_ROLES,PNG_REFUSALS,PNG_SOURCE_PATHS,PNG_ISSUER_PATHS,PNG_HOST_SOURCE_PATHS,pngDigest} from '../../tooling/raster/import-issuance/png-contract.mjs';
import {canonical} from '../../dist/local/src/protocol/json.js';

export const canonicalStringify=canonical;
const trustedRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const LABEL='CONTRACT TEST ONLY: fabricated metadata; no image jobs or qualification occurred.';
export function makePNGFixture({platform='darwin',arch='arm64'}={}){
  const files=new Map();
  const add=(path,value)=>{const bytes=Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(value);files.set(path,bytes);return{path,bytes:bytes.length,hash:pngDigest(bytes)};};
  const leaf=(path,value)=>({...add('contract-test-only/receipts/'+path,value),path});
  const sourceFiles=PNG_SOURCE_PATHS.map(path=>add(path,readFileSync(join(trustedRoot,path))));
  const definition={schemaVersion:1,kind:'png-import-source-definition-v1',transport:'png-scanline-file-cp1-v1',mediaType:'image/png',pixelPipeline:'cp1-f64-triangle-area-v1',kernel:'triangle-area-source-axis-row-norm-v1',color:'fixed-srgb-p3-orientation-v1',files:sourceFiles};
  const sourceHash=pngDigest(canonicalStringify(definition));
  const producerManifest={schemaVersion:1,kind:'png-import-issuer-source-v1',sourceHash,files:PNG_ISSUER_PATHS.map(path=>add(path,readFileSync(join(trustedRoot,path))))};
  const producerManifestPath='contract-test-only/producer-source-manifest.json',producerManifestRef=add(producerManifestPath,json(producerManifest));
  const source={schemaVersion:1,kind:'png-import-source-v1',sourceHash,producerSourceHash:producerManifestRef.hash,definition};
  const sourceManifestPath='contract-test-only/source-manifest.json';
  const sourceManifest=add(sourceManifestPath,json(source));
  const hostSourceFiles=PNG_HOST_SOURCE_PATHS.map(repositoryPath=>{
    const ref=files.has(repositoryPath)?{path:repositoryPath,bytes:files.get(repositoryPath).length,hash:pngDigest(files.get(repositoryPath))}:add(repositoryPath,readFileSync(join(trustedRoot,repositoryPath)));
    return{repositoryPath,bytes:ref.bytes,hash:ref.hash};
  });
  const hostSourceHash=pngDigest(canonicalStringify(hostSourceFiles));
  const identityPath=platform==='darwin'?'server/raster/identity.ts':'server/raster/identities/linux-'+arch+'-v1.ts';
  const codecId=files.get(identityPath)?.toString('utf8').match(/export const CODEC_ID = ['"](sha256:[a-f0-9]{64})['"]/)[1];
  if(!codecId)throw Error('Contract fixture target lacks a retained codec identity');
  const baseCodecAuthority={platform,arch,codecId,inputs:['server/raster/codec-platform.ts',identityPath].map(path=>({path,bytes:files.get(path).length,hash:pngDigest(files.get(path))}))};
  const envelope={schemaVersion:1,status:'passed',sourceHash:source.sourceHash,sourceManifestHash:sourceManifest.hash,producerSourceHash:source.producerSourceHash,baseCodec:baseCodecAuthority.codecId,platform,arch,hostSourceHash};
  const receipts=new Map(),evidence=[];
  const outputs=(role,id)=>{
    const prefix='leaves/'+role+'/'+id,rgba=Buffer.from([17,91,203,127]);
    return{fixture:leaf(prefix+'.fixture.txt',LABEL+'\n'+role+'/'+id+'\n'),actual:leaf(prefix+'.actual.rgba',rgba),expected:leaf(prefix+'.expected.rgba',Buffer.from(rgba))};
  };
  for(const role of PNG_ROLES){
    const environment={node:'26.10.0',platform,arch,execution:'virtualized',os:LABEL};
    const logs=[leaf('logs/'+role+'.log',LABEL+'\nRole: '+role+'\n')];
    let receipt;
    if(role==='resources'){
      const jobs=PNG_CASES.resources.map((name,index)=>({id:'contract-test-'+index,case:name,status:'completed',originalWidth:5001,originalHeight:5000,width:1,height:1,operation:name==='contended-crop'?'crop':'resize',...outputs(role,name),maxRSSBytes:128*1048576,admittedBytes:256*1048576,completedOperations:name==='repeated-resize'?3:1,maxConcurrentJobs:name==='contended-crop'?2:1,contentionObserved:name==='contended-crop',remainingAllocations:0,remainingScratchBytes:0}));
      receipt={...envelope,kind:'png-import-resources-v1',environment,logs,measurement:'whole-process-rss',capBytes:512*1048576,maxRSSBytes:128*1048576,completedJobs:jobs.length,completedOperations:jobs.reduce((n,j)=>n+j.completedOperations,0),residualAllocations:0,residualScratchBytes:0,jobs};
    }else{
      const cases=PNG_CASES[role].map(id=>{
        const common={id,status:'passed-case',completedChecks:1,elapsedMs:0};
        if(role==='durability')return{...common,observations:[leaf('observations/'+id+'.txt',LABEL+'\nObservation placeholder: '+id+'\n')]};
        return{...common,originalWidth:id.startsWith('oversized-')?5001:1,originalHeight:id.startsWith('oversized-')?5000:1,width:1,height:1,...outputs(role,id),oracle:{kind:'independent-fixture',source:leaf('oracles/'+role+'/'+id+'.txt',LABEL+'\nIndependent fixture metadata contract: '+id+'\n')}};
      });
      receipt={...envelope,kind:'png-import-'+role+'-v1',environment,logs,completedCases:cases.length,completedChecks:cases.reduce((n,row)=>n+row.completedChecks,0),cases};
      if(role==='pixels'){
        receipt.refusals=PNG_REFUSALS.map(id=>{const bytes=Buffer.from(LABEL+'\nUnsupported16-bit fixture: '+id+'\n');return{id,status:'rejected-as-unsupported',code:'RASTER_DEPTH',completedChecks:1,elapsedMs:0,fixture:leaf('refusals/'+id+'.before.txt',bytes),originalAfter:leaf('refusals/'+id+'.after.txt',Buffer.from(bytes)),outputAbsent:true};});
        receipt.completedRefusals=receipt.refusals.length;
      }
    }
    receipts.set(role,receipt);evidence.push({role,...add('contract-test-only/receipts/'+role+'.json',json(receipt)),path:'receipts/'+role+'.json'});
  }
  const qualification={schemaVersion:1,kind:'png-import-cp1-qualification-v1',status:'accepted',sourceHash:source.sourceHash,sourceManifestHash:sourceManifest.hash,producerSourceHash:source.producerSourceHash,baseCodec:baseCodecAuthority.codecId,platform,arch,artifactHash:null,abiVersion:null,hostSourceFiles,hostSourceHash,evidence};
  const qualificationPath='contract-test-only/qualification.json';add(qualificationPath,json(qualification));
  return{source,sourceManifestHash:sourceManifest.hash,sourceManifestPath,producerManifest,producerManifestHash:producerManifestRef.hash,producerManifestPath,qualification,receipts,baseCodecAuthority,files,qualificationPath};
}

/** Refresh serialized test records after an intentional metadata mutation.
 * Source bindings inside receipts are NOT repaired automatically: tests need to
 * preserve stale bindings and demonstrate their refusal. */
export function syncPNGFixture(fixture){
  for(const [role,receipt]of fixture.receipts){
    const ref=fixture.qualification.evidence.find(ref=>ref.role===role);if(!ref)continue;
    const bytes=json(receipt);fixture.files.set(join(dirname(fixture.qualificationPath),ref.path),bytes);ref.bytes=bytes.length;ref.hash=pngDigest(bytes);
  }
  fixture.files.set(fixture.qualificationPath,json(fixture.qualification));
  fixture.files.set(fixture.sourceManifestPath,json(fixture.source));
  fixture.files.set(fixture.producerManifestPath,json(fixture.producerManifest));
  return fixture;
}
export function writePNGFixture(directory,fixture=makePNGFixture()){
  for(const [path,bytes]of fixture.files){const target=join(directory,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{mode:0o600,flag:'wx'});}
  return{sourceRoot:directory,canonicalStringify,source:fixture.source,sourceManifestHash:fixture.sourceManifestHash,qualificationPath:join(directory,fixture.qualificationPath),sourceManifestPath:join(directory,fixture.sourceManifestPath),baseCodecAuthority:fixture.baseCodecAuthority};
}
