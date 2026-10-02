// Deterministic source metadata only. This neither issues a PNG profile nor
// creates qualification evidence, installs an inventory, or edits its inputs.
import assert from 'node:assert/strict';
import {closeSync,constants,existsSync,fstatSync,mkdirSync,openSync,readSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPinnedCanonical} from '../import-seals/pinned-canonical-source.mjs';
import {checkParents,digest,identity,inside,readJSON,writeJSON} from '../import-seals/files.mjs';
import {PNG_SOURCE_PATHS,PNG_ISSUER_PATHS,pngDigest,pngFileReference,validatePNGSource,validatePNGProducerSource} from './png-contract.mjs';

// This upstream producer is bound separately from the six qualification issuer
// inputs. Adding it to PNG_ISSUER_PATHS would change that independent contract.
export const PNG_SOURCE_PRODUCER_PATHS=Object.freeze([
 'src/protocol/json.ts',
 'tooling/raster/import-issuance/png-contract.mjs',
 'tooling/raster/import-issuance/produce-png-source.mjs',
 'tooling/raster/import-seals/files.mjs',
 'tooling/raster/import-seals/pinned-canonical-source.mjs',
]);
const moduleRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const exact=(value,keys)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};
const metadataBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const withoutPath=ref=>({bytes:ref.bytes,hash:ref.hash});
const fileRow=ref=>({path:ref.path,bytes:ref.bytes,hash:ref.hash});
const sameIdentity=(a,b)=>a?.bytes===b?.bytes&&a?.hash===b?.hash;
const table=(rows,paths)=>{assert(Array.isArray(rows));rows.forEach(pngFileReference);assert.deepEqual(rows.map(row=>row.path),paths);return rows;};

/** Historical metadata declarations, never an assertion that old files are
 * present or that their qualification was rerun. Both exact bytes are inputs. */
export function readPreviousPNGPair(directory,refs,canonicalStringify){
 exact(refs,['source','issuer']);pngFileReference(refs.source);pngFileReference(refs.issuer);
 assert.notEqual(refs.source.path,refs.issuer.path);
 const source=readJSON(inside(directory,refs.source.path)),issuer=readJSON(inside(directory,refs.issuer.path));
 assert.deepEqual({bytes:source.bytes.length,hash:source.hash},withoutPath(refs.source),'Previous PNG source bytes changed');
 assert.deepEqual({bytes:issuer.bytes.length,hash:issuer.hash},withoutPath(refs.issuer),'Previous PNG issuer bytes changed');
 validatePNGSource(source.value,canonicalStringify);validatePNGProducerSource(source.value,issuer.value,issuer.hash);
 return {source,issuer};
}

/** A review must name every changed declaration explicitly, including a newly
 * required source. Unchanged rows remain verified by the complete current map. */
export function pngSourceChanges(previous,current){
 const old=new Map(previous.map(row=>[row.path,row])),next=new Map(current.map(row=>[row.path,row]));
 const paths=[...new Set([...old.keys(),...next.keys()])].sort();
 return paths.filter(path=>!sameIdentity(old.get(path),next.get(path))).map(path=>({path,
  previousDeclaration:old.has(path)?withoutPath(old.get(path)):null,
  currentInput:next.has(path)?withoutPath(next.get(path)):null}));
}

function validateRecipe(recipe){
 exact(recipe,['schemaVersion','kind','previous','current','changes','producerInputs']);
 assert.equal(recipe.schemaVersion,1);assert.equal(recipe.kind,'png-source-production-recipe-1');
 exact(recipe.previous,['source','issuer']);pngFileReference(recipe.previous.source);pngFileReference(recipe.previous.issuer);
 exact(recipe.current,['sources','issuer']);table(recipe.current.sources,PNG_SOURCE_PATHS);table(recipe.current.issuer,PNG_ISSUER_PATHS);
 exact(recipe.changes,['sources','issuer']);assert(Array.isArray(recipe.changes.sources)&&Array.isArray(recipe.changes.issuer));
 table(recipe.producerInputs,PNG_SOURCE_PRODUCER_PATHS);
 return recipe;
}
function currentInputs(sourceRoot,recipe){
 const inputs=new Map();
 for(const row of [...recipe.current.sources,...recipe.current.issuer,...recipe.producerInputs]){
  const prior=inputs.get(row.path);if(prior)assert.deepEqual(prior,row,'Conflicting current input identities');else inputs.set(row.path,row);
 }
 const rows=[...inputs.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const verify=()=>{
  for(const row of rows)assert.deepEqual(identity(inside(sourceRoot,row.path)),withoutPath(row),'Current PNG input changed: '+row.path);
  // Actual executing producer/helper bytes must match the reviewed copies, not
  // merely another file carrying the same repository-relative name.
  for(const row of recipe.producerInputs)assert.deepEqual(identity(inside(moduleRoot,row.path)),withoutPath(row),'Executing PNG producer input changed: '+row.path);
 };
 verify();
 return {rows,verify};
}
function canonicalInput(root,row){
 const path=inside(root,row.path);assert(row.bytes<=65536,'Pinned canonical source must remain bounded');
 assert.deepEqual(identity(path,row.bytes),withoutPath(row));const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd,{bigint:true});assert(before.isFile()&&before.nlink===1n&&before.size===BigInt(row.bytes));
  const bytes=Buffer.alloc(row.bytes);for(let at=0;at<bytes.length;){const n=readSync(fd,bytes,at,bytes.length-at,at);assert(n>0);at+=n;}
  const after=fstatSync(fd,{bigint:true});for(const key of ['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'])assert.equal(after[key],before[key]);
  assert.deepEqual({bytes:bytes.length,hash:pngDigest(bytes)},withoutPath(row));assert.deepEqual(identity(path,row.bytes),withoutPath(row));return bytes;
 }finally{closeSync(fd);}
}
function disjoint(output,input){
 assert(output!==input&&!output.startsWith(input+'/')&&!input.startsWith(output+'/'),'PNG source output must be disjoint from input trees');
}

export async function producePNGSource({sourceRoot,previousRoot,recipePath,reviewedHash,output}){
 assert.equal(process.versions.node,'26.10.0','PNG source production requires the pinned Node runtime');
 sourceRoot=resolve(sourceRoot);previousRoot=resolve(previousRoot);recipePath=resolve(recipePath);output=resolve(output);digest(reviewedHash);
 assert(!existsSync(output),'PNG source output must be fresh');disjoint(output,sourceRoot);disjoint(output,previousRoot);disjoint(output,moduleRoot);
 assert(recipePath!==output&&!recipePath.startsWith(output+'/'),'Output cannot contain its reviewed recipe');checkParents(output);
 const retainedRecipe=readJSON(recipePath);assert.equal(retainedRecipe.hash,reviewedHash,'PNG source recipe changed');
 const recipe=validateRecipe(retainedRecipe.value),observed=currentInputs(sourceRoot,recipe);
 const canonicalRow=recipe.producerInputs.find(row=>row.path==='src/protocol/json.ts');
 const canonicalBytes=canonicalInput(sourceRoot,canonicalRow);
 const {canonical}=await loadPinnedCanonical(canonicalBytes);
 const previous=readPreviousPNGPair(previousRoot,recipe.previous,canonical);
 const changes={sources:pngSourceChanges(previous.source.value.definition.files,recipe.current.sources),issuer:pngSourceChanges(previous.issuer.value.files,recipe.current.issuer)};
 assert.deepEqual(recipe.changes,changes,'PNG source changes differ from the reviewed before/after map');
 const definition={...previous.source.value.definition,files:recipe.current.sources.map(fileRow)};
 const sourceHash=pngDigest(canonical(definition));
 const issuer={schemaVersion:1,kind:'png-import-issuer-source-v1',sourceHash,files:recipe.current.issuer.map(fileRow)};
 const issuerBytes=metadataBytes(issuer),producerSourceHash=pngDigest(issuerBytes);
 const source={schemaVersion:1,kind:'png-import-source-v1',sourceHash,producerSourceHash,definition};
 validatePNGSource(source,canonical);validatePNGProducerSource(source,issuer,producerSourceHash);
 // Recheck after async serializer loading, before any output exists. All source
 // inputs remain read-only; final checks below precede the completed receipt.
 observed.verify();readPreviousPNGPair(previousRoot,recipe.previous,canonical);
 assert.equal(readJSON(recipePath).hash,reviewedHash,'PNG source recipe changed during production');
 mkdirSync(output,{mode:0o700});
 const issuerRef=writeJSON(inside(output,'png-source-manifest.json'),issuer);
 assert.deepEqual(issuerRef,{bytes:issuerBytes.length,hash:producerSourceHash});
 const sourceRef=writeJSON(inside(output,'png-source.json'),source);
 observed.verify();readPreviousPNGPair(previousRoot,recipe.previous,canonical);
 assert.equal(readJSON(recipePath).hash,reviewedHash,'PNG source recipe changed during publication');
 assert.deepEqual(identity(inside(output,'png-source-manifest.json')),issuerRef);
 assert.deepEqual(identity(inside(output,'png-source.json')),sourceRef);
 const receipt={schemaVersion:1,kind:'png-source-production-receipt-1',status:'source-metadata-produced',qualification:'not-issued',
  recipe:{bytes:retainedRecipe.bytes.length,hash:retainedRecipe.hash},previous:{source:recipe.previous.source,issuer:recipe.previous.issuer,sourceHash:previous.source.value.sourceHash},
  currentInputs:observed.rows,producerInputs:recipe.producerInputs,changes,
  outputs:[{path:'png-source.json',...sourceRef},{path:'png-source-manifest.json',...issuerRef}],sourceHash,producerSourceHash};
 // The receipt is last; a partial output is retained and is not a completed run.
 const receiptRef=writeJSON(inside(output,'production-receipt.json'),receipt);
 return {output,sourceHash,producerSourceHash,receipt:receiptRef};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,7,'produce-png-source.mjs CURRENT_SOURCE_ROOT PREVIOUS_PAIR_ROOT REVIEWED_RECIPE SHA256 NEW_OUTPUT');
 const [sourceRoot,previousRoot,recipePath,reviewedHash,output]=process.argv.slice(2);
 console.log(JSON.stringify(await producePNGSource({sourceRoot,previousRoot,recipePath,reviewedHash,output})));
}
