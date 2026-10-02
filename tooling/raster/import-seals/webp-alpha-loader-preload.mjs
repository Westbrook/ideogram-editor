// Render reviewed preload bytes as data. The returned text is never executed here.
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Render only the reviewed embedded bootstrap; never execute retained source. */
export function renderCandidatePreload({helperRecords,helperRoot,authorizationPath,authorizationHash}){
 const runtimeURL=pathToFileURL(join(helperRoot,'runtime.mjs')).href;
 return `// Explicit candidate-only preload; inherited in worker execArgv.
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const helpers=${JSON.stringify(helperRecords.map(row=>({path:join(helperRoot,row.repositoryPath),bytes:row.bytes,hash:row.hash})))};
const capturedHelpers=new Map();
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].map(String).join(':');
for (const row of helpers) {
 assert(realpathSync(row.path)===row.path);
 const fd=openSync(row.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd,{bigint:true});assert(before.isFile()&&before.nlink===1n&&before.size===BigInt(row.bytes));
  const source=Buffer.alloc(row.bytes);
  for(let offset=0;offset<source.length;){const n=readSync(fd,source,offset,source.length-offset,offset);assert(n>0);offset+=n;}
  assert.equal(stamp(before),stamp(fstatSync(fd,{bigint:true})));assert.equal(stamp(before),stamp(lstatSync(row.path,{bigint:true})));
  assert.equal('sha256:'+createHash('sha256').update(source).digest('hex'),row.hash);
  capturedHelpers.set(pathToFileURL(row.path).href,{format:row.path.endsWith('.json')?'json':'module',source});
 } finally {closeSync(fd);}
}
const helperPrefix=${JSON.stringify(pathToFileURL(helperRoot).href+'/')};
const helperBuiltins=new Set(['node:assert/strict','node:crypto','node:fs','node:path','node:module','node:url']);
registerHooks({resolve(specifier,context,nextResolve){
 if(capturedHelpers.has(specifier))return {url:specifier,shortCircuit:true};
 if(capturedHelpers.has(context.parentURL)){
  if(helperBuiltins.has(specifier))return {url:specifier,shortCircuit:true};
  const url=new URL(specifier,context.parentURL).href;
  assert(capturedHelpers.has(url),'Unsealed candidate helper dependency');
  return {url,shortCircuit:true};
 }
 assert(!specifier.startsWith(helperPrefix),'Unsealed candidate helper specifier');
 return nextResolve(specifier,context);
},load(url,context,nextLoad){
 const captured=capturedHelpers.get(url);
 if(captured)return {...captured,shortCircuit:true};
 assert(!url.startsWith(helperPrefix),'Unsealed candidate helper URL');
 return nextLoad(url,context);
}});
const {installCandidateHooks}=await import(${JSON.stringify(runtimeURL)});
installCandidateHooks(${JSON.stringify(authorizationPath)},${JSON.stringify(authorizationHash)});
`;
}

