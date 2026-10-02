// Source metadata only: no image execution, qualification fixture or inventory.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {producePNGSource,readPreviousPNGPair,pngSourceChanges,PNG_SOURCE_PRODUCER_PATHS} from '../../tooling/raster/import-issuance/produce-png-source.mjs';
import {PNG_SOURCE_PATHS,PNG_ISSUER_PATHS} from '../../tooling/raster/import-issuance/png-contract.mjs';
import {loadPinnedCanonical} from '../../tooling/raster/import-seals/pinned-canonical-source.mjs';

const trustedRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const identity=bytes=>({bytes:bytes.length,hash:digest(bytes)});
const ref=(root,path)=>({path,...identity(readFileSync(join(root,path)))});
const declaration=row=>({bytes:row.bytes,hash:row.hash});
const clone=value=>JSON.parse(JSON.stringify(value));
const {canonical}=await loadPinnedCanonical(readFileSync(join(trustedRoot,'src/protocol/json.ts')));
const definition=files=>({schemaVersion:1,kind:'png-import-source-definition-v1',transport:'png-scanline-file-cp1-v1',mediaType:'image/png',pixelPipeline:'cp1-f64-triangle-area-v1',kernel:'triangle-area-source-axis-row-norm-v1',color:'fixed-srgb-p3-orientation-v1',files});
const inputPaths=[...new Set([...PNG_SOURCE_PATHS,...PNG_ISSUER_PATHS,...PNG_SOURCE_PRODUCER_PATHS])].sort();

function fixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'ie-png-source-producer-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sourceRoot=join(root,'current'),previousRoot=join(root,'previous'),recipePath=join(root,'review','recipe.json'),output=join(root,'output');
 for(const path of inputPaths){const target=join(sourceRoot,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(join(trustedRoot,path),target);}
 mkdirSync(previousRoot,{mode:0o700});mkdirSync(dirname(recipePath),{mode:0o700});
 const current={sources:PNG_SOURCE_PATHS.map(path=>ref(sourceRoot,path)),issuer:PNG_ISSUER_PATHS.map(path=>ref(sourceRoot,path))};
 // These two declarations describe a synthetic predecessor, not old source files
 // or qualification. All current inputs are real copies of the trusted checkout.
 const previousSources=clone(current.sources),previousIssuer=clone(current.issuer);
 previousSources[0]={path:previousSources[0].path,...identity(Buffer.from('previous source declaration\n'))};
 previousIssuer[0]={path:previousIssuer[0].path,...identity(Buffer.from('previous issuer declaration\n'))};
 const oldDefinition=definition(previousSources),sourceHash=digest(canonical(oldDefinition));
 const issuer={schemaVersion:1,kind:'png-import-issuer-source-v1',sourceHash,files:previousIssuer};
 const issuerBytes=json(issuer),source={schemaVersion:1,kind:'png-import-source-v1',sourceHash,producerSourceHash:digest(issuerBytes),definition:oldDefinition};
 writeFileSync(join(previousRoot,'png-source-manifest.json'),issuerBytes,{flag:'wx'});
 writeFileSync(join(previousRoot,'png-source.json'),json(source),{flag:'wx'});
 const recipe={schemaVersion:1,kind:'png-source-production-recipe-1',previous:{source:ref(previousRoot,'png-source.json'),issuer:ref(previousRoot,'png-source-manifest.json')},current,
  changes:{sources:[{path:current.sources[0].path,previousDeclaration:declaration(previousSources[0]),currentInput:declaration(current.sources[0])}],issuer:[{path:current.issuer[0].path,previousDeclaration:declaration(previousIssuer[0]),currentInput:declaration(current.issuer[0])}]},
  producerInputs:PNG_SOURCE_PRODUCER_PATHS.map(path=>ref(sourceRoot,path))};
 const f={root,sourceRoot,previousRoot,recipePath,output,recipe,source,issuer};
 f.review=()=>{const bytes=json(f.recipe);writeFileSync(recipePath,bytes);return digest(bytes);};
 f.reviewedHash=f.review();
 f.run=(overrides={})=>producePNGSource({sourceRoot,previousRoot,recipePath,reviewedHash:f.reviewedHash,output,...overrides});
 f.snapshot=()=>new Map([...inputPaths.map(path=>join(sourceRoot,path)),join(previousRoot,'png-source.json'),join(previousRoot,'png-source-manifest.json'),recipePath].map(path=>[path,readFileSync(path)]));
 return f;
}
function unchanged(snapshot){for(const [path,bytes]of snapshot)assert.deepEqual(readFileSync(path),bytes,path+' changed');}
async function refused(f,pattern){await assert.rejects(f.run(),pattern);assert.equal(existsSync(f.output),false,'Refusal must precede creation of output');}
function resealPrevious(f){
 const issuerBytes=json(f.issuer);f.source.producerSourceHash=digest(issuerBytes);
 writeFileSync(join(f.previousRoot,'png-source-manifest.json'),issuerBytes);
 writeFileSync(join(f.previousRoot,'png-source.json'),json(f.source));
 f.recipe.previous={source:ref(f.previousRoot,'png-source.json'),issuer:ref(f.previousRoot,'png-source-manifest.json')};
 f.reviewedHash=f.review();
}

test('PNG source production is deterministic, preserves every input and publishes only metadata with a final receipt',async t=>{
 const f=fixture(t),before=f.snapshot(),first=await f.run(),secondOutput=join(f.root,'second-output');
 const second=await f.run({output:secondOutput});unchanged(before);
 assert.deepEqual(readdirSync(f.output).sort(),['png-source-manifest.json','png-source.json','production-receipt.json']);
 for(const path of readdirSync(f.output))assert.deepEqual(readFileSync(join(f.output,path)),readFileSync(join(secondOutput,path)),path);
 const expectedDefinition=definition(f.recipe.current.sources),sourceHash=digest(canonical(expectedDefinition));
 const expectedIssuer={schemaVersion:1,kind:'png-import-issuer-source-v1',sourceHash,files:f.recipe.current.issuer};
 const expectedSource={schemaVersion:1,kind:'png-import-source-v1',sourceHash,producerSourceHash:digest(json(expectedIssuer)),definition:expectedDefinition};
 assert.deepEqual(readFileSync(join(f.output,'png-source-manifest.json')),json(expectedIssuer));
 assert.deepEqual(readFileSync(join(f.output,'png-source.json')),json(expectedSource));
 const receiptBytes=readFileSync(join(f.output,'production-receipt.json')),receipt=JSON.parse(receiptBytes);
 assert.equal(receipt.status,'source-metadata-produced');assert.equal(receipt.qualification,'not-issued');
 assert.equal(receipt.sourceHash,sourceHash);assert.equal(receipt.producerSourceHash,expectedSource.producerSourceHash);
 assert.deepEqual(receipt.outputs,[ref(f.output,'png-source.json'),ref(f.output,'png-source-manifest.json')]);
 assert.deepEqual(receipt.recipe,identity(readFileSync(f.recipePath)));assert.deepEqual(receipt.changes,f.recipe.changes);
 assert.deepEqual(receipt.currentInputs,inputPaths.map(path=>ref(f.sourceRoot,path)));
 assert.deepEqual(first.receipt,identity(receiptBytes));assert.deepEqual(first.receipt,second.receipt);
 assert.equal(first.sourceHash,sourceHash);assert.equal(first.producerSourceHash,expectedSource.producerSourceHash);
});

test('a changed current source is refused without creating output',async t=>{
 const f=fixture(t),path=join(f.sourceRoot,PNG_SOURCE_PATHS[0]);writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n')]));
 const changed=readFileSync(path);await refused(f,/Current PNG input changed/);assert.deepEqual(readFileSync(path),changed);
});

test('a missing current source is refused without creating output',async t=>{
 const f=fixture(t);unlinkSync(join(f.sourceRoot,PNG_SOURCE_PATHS[0]));await refused(f,/ENOENT/);
});

test('input drift while the pinned serializer import yields is refused before output publication',async t=>{
 const f=fixture(t),path=join(f.sourceRoot,PNG_SOURCE_PATHS[0]),pending=f.run();
 // producePNGSource has synchronously observed its inputs, then yields while
 // loading the pinned serializer. The unchanged recipe cannot bless this edit.
 writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n// late input drift\n')]));
 await assert.rejects(pending,/Current PNG input changed/);assert.equal(existsSync(f.output),false);
});

test('all current source, issuer and executing-producer tables reject omission, duplication and reordered rows',async t=>{
 for(const field of ['sources','issuer','producerInputs'])for(const change of ['omitted','duplicate','reordered']){
  const f=fixture(t),rows=field==='producerInputs'?f.recipe.producerInputs:f.recipe.current[field];
  if(change==='omitted')rows.pop();else if(change==='duplicate')rows[1]=clone(rows[0]);else [rows[0],rows[1]]=[rows[1],rows[0]];
  f.reviewedHash=f.review();await refused(f);
 }
});

test('the reviewed source change map must match every before and after declaration exactly',async t=>{
 for(const change of ['omitted','duplicate','wrong-before','wrong-after','unknown-field']){
  const f=fixture(t),rows=f.recipe.changes.sources;
  if(change==='omitted')rows.pop();else if(change==='duplicate')rows.push(clone(rows[0]));
  else if(change==='wrong-before')rows[0].previousDeclaration=null;
  else if(change==='wrong-after')rows[0].currentInput.bytes++;
  else rows[0].unreviewed=true;
  f.reviewedHash=f.review();await refused(f,/reviewed before\/after map/);
 }
});

test('the reviewed issuer change map cannot omit or substitute an issuer change',async t=>{
 for(const change of ['omitted','wrong-path','wrong-before']){
  const f=fixture(t),rows=f.recipe.changes.issuer;
  if(change==='omitted')rows.pop();else if(change==='wrong-path')rows[0].path=PNG_ISSUER_PATHS[1];else rows[0].previousDeclaration.hash=digest('unreviewed');
  f.reviewedHash=f.review();await refused(f,/reviewed before\/after map/);
 }
});

test('a reviewed current identity must still match the actual input bytes',async t=>{
 const f=fixture(t);f.recipe.current.sources[0].hash=digest('different current input');f.reviewedHash=f.review();
 await refused(f,/Current PNG input changed/);
});

test('changing only recipe whitespace invalidates its reviewed raw hash',async t=>{
 const f=fixture(t);writeFileSync(f.recipePath,Buffer.concat([readFileSync(f.recipePath),Buffer.from('\n')]));
 await refused(f,/PNG source recipe changed/);
});

test('previous source and issuer bytes are independently bound before output',async t=>{
 for(const name of ['png-source.json','png-source-manifest.json']){
  const f=fixture(t),path=join(f.previousRoot,name);writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n')]));
  await refused(f,/Previous PNG (source|issuer) bytes changed/);
 }
});

test('resealing a previous JSON file cannot hide an invalid canonical source digest',async t=>{
 const f=fixture(t);f.source.definition.files[0].bytes++;resealPrevious(f);
 await refused(f);
});

test('resealing the recipe cannot hide a broken previous source-to-issuer link',async t=>{
 const f=fixture(t);f.source.producerSourceHash=digest('wrong issuer link');
 writeFileSync(join(f.previousRoot,'png-source.json'),json(f.source));f.recipe.previous.source=ref(f.previousRoot,'png-source.json');f.reviewedHash=f.review();
 await refused(f);
});

test('current inputs must be singly linked regular files even when link targets have the expected bytes',async t=>{
 for(const kind of ['symlink','hardlink']){
  const f=fixture(t),path=join(f.sourceRoot,PNG_SOURCE_PATHS[0]),target=join(f.root,'retained-source');
  copyFileSync(path,target);unlinkSync(path);if(kind==='symlink')symlinkSync(target,path);else linkSync(target,path);
  await refused(f,/singly linked regular/);
 }
});

test('previous metadata, recipe and output parents reject symbolic or hard links',async t=>{
 for(const subject of ['previous-symlink','previous-hardlink','recipe-symlink','output-parent']){
  const f=fixture(t);
  if(subject==='output-parent'){
   const parent=join(f.root,'linked-output-parent');symlinkSync(f.previousRoot,parent,'dir');
   await assert.rejects(f.run({output:join(parent,'new-output')}),/parent must be a real directory/);assert.equal(existsSync(join(f.previousRoot,'new-output')),false);
  }else{
   const path=subject==='recipe-symlink'?f.recipePath:join(f.previousRoot,'png-source.json'),target=join(f.root,'retained-json');copyFileSync(path,target);unlinkSync(path);
   if(subject==='previous-hardlink')linkSync(target,path);else symlinkSync(target,path);
   await refused(f,/singly linked regular/);
  }
 }
});

test('previous metadata paths cannot escape their reviewed root',async t=>{
 for(const path of ['../png-source.json','/png-source.json','nested/../../png-source.json']){
  const f=fixture(t);f.recipe.previous.source.path=path;f.reviewedHash=f.review();await refused(f);
 }
});

test('overlapping trees and existing output refuse before changing any inputs or existing output',async t=>{
 const f=fixture(t),before=f.snapshot();
 for(const output of [join(f.sourceRoot,'new-output'),join(f.previousRoot,'new-output')]){
  await assert.rejects(f.run({output}),/disjoint/);assert.equal(existsSync(output),false);unchanged(before);
 }
 const executingOutput=join(trustedRoot,'artifacts','producer-refusal-'+f.root.split('/').at(-1));
 assert.equal(existsSync(executingOutput),false);await assert.rejects(f.run({output:executingOutput}),/disjoint/);assert.equal(existsSync(executingOutput),false);
 const recipeOutput=join(f.root,'contains-recipe'),insideRecipe=join(recipeOutput,'review.json');
 await assert.rejects(f.run({output:recipeOutput,recipePath:insideRecipe}),/contain its reviewed recipe/);assert.equal(existsSync(recipeOutput),false);
 mkdirSync(f.output,{mode:0o700});const marker=Buffer.from('existing output must survive\n');writeFileSync(join(f.output,'marker'),marker);
 await assert.rejects(f.run(),/must be fresh/);assert.deepEqual(readdirSync(f.output),['marker']);assert.deepEqual(readFileSync(join(f.output,'marker')),marker);unchanged(before);
});

test('reviewed copied producer bytes cannot substitute for the actually executing producer',async t=>{
 const f=fixture(t),path='tooling/raster/import-issuance/produce-png-source.mjs',target=join(f.sourceRoot,path);
 writeFileSync(target,Buffer.concat([readFileSync(target),Buffer.from('\n// different executing implementation\n')]));
 f.recipe.producerInputs[f.recipe.producerInputs.findIndex(row=>row.path===path)]=ref(f.sourceRoot,path);f.reviewedHash=f.review();
 await refused(f,/Executing PNG producer input changed/);
});

test('retained v2, Node26, cleanup and V45 source/issuer pairs remain verifiable byte-for-byte without loading old code',()=>{
 const expected={
  v2:['sha256:efb0f711844585c753ba306eb18c218eaeb03803a259a8a59b518016c4fd603d','sha256:f7beb911eb486875ffbd9d7e9132c6c90bb4536e2d874932db7b5bda35c0d3ab'],
  node26:['sha256:3ffb9251c22ff280062eabf9e9101903dfef0f432ad77770b8f4053021a3da93','sha256:b264b81cfa34101a37774a5a9c2cb31ed82bd7183440d1a77ea87a835873d5b4'],
  cleanup:['sha256:6cf0a6f9373a98423f9cfb4afa5df55dc1be4e2f1f809c89884c9874be1d5495','sha256:11ac34df1ef4a0165bc144de15510336aa83a547079c17a60ceb777682299e3d'],
  v45:['sha256:ea053bd93988dbdee838ee4cb61b1653f4035d31e8d6ffe4c8f78232e3cb3147','sha256:a976b4d7a91946d27f2493a9a634bc5fd71f7d8cd647f8a1cb56d2aded8dd87c'],
 };
 for(const name of ['v2','node26','cleanup','v45']){
  const root=join(trustedRoot,'tests/raster/fixtures/png-retained-ready-plan',name),sourceBytes=readFileSync(join(root,'png-source.json')),issuerBytes=readFileSync(join(root,'png-source-manifest.json'));
  assert.deepEqual([digest(sourceBytes),digest(issuerBytes)],expected[name]);
  const refs={source:{path:'png-source.json',...identity(sourceBytes)},issuer:{path:'png-source-manifest.json',...identity(issuerBytes)}};
  const previous=readPreviousPNGPair(root,refs,canonical);
  assert.deepEqual(previous.source.bytes,sourceBytes);assert.deepEqual(previous.issuer.bytes,issuerBytes);
  assert.equal(previous.source.value.definition.files.length,51);assert.equal(previous.issuer.value.files.length,name==='v2'?5:6);
  assert.equal(previous.source.value.producerSourceHash,refs.issuer.hash);assert.equal(previous.issuer.value.sourceHash,previous.source.value.sourceHash);
  assert.deepEqual(readFileSync(join(root,'png-source.json')),sourceBytes);assert.deepEqual(readFileSync(join(root,'png-source-manifest.json')),issuerBytes);
 }
});

test('change declarations are sorted, include added and removed paths, and leave input tables untouched',()=>{
 const row=(path,body)=>({path,...identity(Buffer.from(body))});
 const previous=[row('z.ts','removed'),row('b.ts','before'),row('same.ts','stable')],current=[row('same.ts','stable'),row('b.ts','after'),row('a.ts','added')];
 const before=clone({previous,current});
 assert.deepEqual(pngSourceChanges(previous,current),[
  {path:'a.ts',previousDeclaration:null,currentInput:declaration(current[2])},
  {path:'b.ts',previousDeclaration:declaration(previous[1]),currentInput:declaration(current[1])},
  {path:'z.ts',previousDeclaration:declaration(previous[0]),currentInput:null},
 ]);
 assert.deepEqual({previous,current},before);assert.deepEqual(pngSourceChanges(current,current),[]);
});
