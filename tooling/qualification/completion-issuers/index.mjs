import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,relative,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {syntaxInventory} from '../../../tests/editor/completion/issuer-syntax.mjs';
import {classifyIssuers,NETWORK_BOUNDARIES} from '../../../tests/editor/completion/issuer-classification.mjs';
import {emittedClosure} from '../../../tests/editor/completion/issuer-closure.mjs';
import {createApplicationIdentity,auditApplicationIdentity} from '../../../tests/editor/completion/application-identity.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const entryTests=['tests/editor/composition.spec.ts','tests/editor/composition.config.ts','tests/editor/composition-save.spec.ts','tests/editor/composition-save.config.ts','tests/editor/integration.spec.ts','tests/editor/integration-reads.spec.ts','tests/editor/integration-fixture.ts','tests/editor/integration.config.ts','tests/editor/integration-regression.config.ts','tests/editor/process-completion-fixture.mjs'];
const json=value=>JSON.stringify(value,null,2)+'\n';
const historicalProducer='tooling/qualification/completion-issuers/historical/mode495-issuers.mjs';
const historicalManifest='tooling/qualification/completion-issuers/historical/host-final-issuers.json';

/** Cheap source-only seal checks, before app/server builds or browser setup. */
export function verifyCompletionSource(root){
 const read=path=>readFileSync(join(root,path));
 assert.equal(sha(read(historicalProducer)),'12e8c1bf06d156604c5a78991e635af8e60b8a6e32e3275e04a6404910737dbb','Preserved historical producer');
 assert.equal(sha(read(historicalManifest)),'717d24791050803d497fadd11f71a91f776c7751bcde506f77121b761a965c0b','Preserved prior issuer evidence');
 for(const [path,hash]of Object.entries(NETWORK_BOUNDARIES))assert.equal(sha(read(path)),hash,'Independently reviewed network source '+path);
 return {kind:'completion-source-prerequisite-1',outcome:'PASS',qualification:false};
}

/** Create a source-bound candidate, with optional explicit adoption after static review. */
export async function prepareCompletionIssuers(output,root,{adopt=false}={}){
 const repo=resolve(root),destination=resolve(output);assert.equal(process.versions.node,'26.10.0','Pinned producer Node');
 assert(!existsSync(destination),'Fresh issuer receipt directory required');
 const read=path=>readFileSync(join(repo,path));
 verifyCompletionSource(repo);
 const identity=createApplicationIdentity({root:repo}),identityText=json(identity);
 const virtualRead=path=>path==='tests/editor/completion/application-identity.json'?Buffer.from(identityText):read(path);
 const all=directory=>readdirSync(join(repo,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?all(directory+'/'+entry.name):[directory+'/'+entry.name]);
 const reached=new Set();function follow(path){if(reached.has(path))return;assert(path==='tests/editor/completion/application-identity.json'||existsSync(join(repo,path)),'Test import closure '+path);reached.add(path);if(!/\.(ts|mjs|js)$/.test(path))return;
  for(const edge of syntaxInventory(path,virtualRead(path).toString()).edges){if(!edge.value.startsWith('.'))continue;let dest=relative(repo,resolve(repo,dirname(path),edge.value));assert(!dest.startsWith('..'),'Repository-owned import closure');if(dest.startsWith('dist/local/'))continue;if(!existsSync(join(repo,dest))&&dest.endsWith('.js'))dest=dest.slice(0,-3)+'.ts';follow(dest);}
 }
 entryTests.forEach(follow);
 const assets=all('dist/app'),sourceInputs=identity.build.inputs.map(pin=>pin.path);
 const packageInputs=['node_modules/rolldown/package.json','node_modules/@en-reve/elements/package.json','node_modules/@en-reve/primitives/package.json','node_modules/lit/package.json','node_modules/playwright/package.json'];
 const files=[...new Set([...assets,...sourceInputs,...reached,...packageInputs])].sort();
 const pins=files.map(path=>{const b=virtualRead(path),role=path.startsWith('tests/')?'injection':path==='dist/app'+identity.expected.workerPath?'worker':path.includes('editor-panels-')?'dynamic':path.includes('icon-')?'vendor':path.startsWith('dist/')?'emitted':'source';return {path,bytes:b.length,sha256:sha(b),role};});
 const modules=pins.filter(pin=>/\.(js|mjs|ts)$/.test(pin.path)).map(pin=>({path:pin.path,syntax:syntaxInventory(pin.path,virtualRead(pin.path).toString())}));
 const closure=emittedClosure({read:virtualRead,pins}),network=classifyIssuers(modules,{read:virtualRead,workerPath:'dist/app'+identity.expected.workerPath,entryPath:closure.entryPath});
 for(const module of modules)if(module.path.startsWith('src/'))assert.equal(module.syntax.keepalive.length,0,'No undeclared production keepalive option');
 const prior=JSON.parse(read(historicalManifest));
 const bodyIssuers=structuredClone(prior.browserBodyIssuers);for(const issuer of bodyIssuers.slice(0,3)){const rows=network.classifiedNetworking.filter(row=>row.kind===issuer.kind);assert.equal(rows.length,1);issuer.emitted=rows[0].path+':'+rows[0].at;}
 const manifest={kind:'SOURCE-BOUND-APPLICATION-ISSUERS-1',applicationIdentitySHA256:sha(JSON.stringify(identity)),
  nodeOnlyMetadataAssets:modules.find(module=>module.path==='tests/editor/completion/host-final-issuers.mjs').syntax.assets,
  computedAssetPrefixes:prior.computedAssetPrefixes,documentEdges:closure.documentEdges,cssEdges:closure.cssEdges,
  pins,modules,assetFiles:readdirSync(join(repo,'dist/app/assets')).sort(),...network,browserBodyIssuers:bodyIssuers,
  bodylessIssuers:[{kind:'modulepreload',sources:network.classifiedNetworking.filter(row=>row.kind==='modulepreload'),scope:'Pinned Vite preload GET; no request body or keepalive'},
   {kind:'sealed-asset',sources:network.classifiedNetworking.filter(row=>row.kind==='sealed-asset'),scope:'Source-reviewed original GET, same-origin, redirect error and original signal'},
   {kind:'static-assets',sources:closure.documentEdges,scope:'Closed emitted HTML/CSS/module/Worker/font assets'},
   {kind:'canvaskit-fallback',sources:network.workerFallbacks,scope:'Five AST-checked bodyless GET fallbacks; no global reachability claim'}],
  injectionMap:prior.injectionMap,
  closure:{html:'dist/app/index.html',css:closure.css,entryPath:closure.entryPath,testEntries:entryTests,
   vendor:'Pinned package-lock and installed package identities; dependencies materialized in exact emitted chunks',
   worker:'Exact application identity plus AST-checked actual Worker URL edge; source-start seal ties worker inputs to the emitted build',
   server:prior.closure.server},unknownIssuers:[],limits:prior.limits,
  review:{networkBoundaries:NETWORK_BOUNDARIES,priorManifestSHA256:sha(read(historicalManifest)),priorProducerSHA256:sha(read(historicalProducer)),sourceScope:'Independent static review of source-pinned local session/recovery/text issuers and owned command/draft helpers: local API routes, same-origin policy and mutation CSRF are retained; session setup delegates its composed signal and bounded original response reader to pinned ownership helpers. Cleanup rejection retains its original resource and is not a completion receipt. Provider operations use the existing local command transport. These source pins do not establish final emitted counts, native cancellation, browser completion or product qualification.'}};
 mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'application-identity.json'),identityText);writeFileSync(join(destination,'host-final-issuers.json'),json(manifest));
 const producerInputs=['tooling/qualification/completion-issuers/index.mjs','tests/editor/completion/issuer-syntax.mjs','tests/editor/completion/issuer-classification.mjs','tests/editor/completion/issuer-closure.mjs','tests/editor/completion/application-identity.mjs','tests/editor/completion/host-final-issuers.mjs'].map(path=>({path,bytes:read(path).length,sha256:sha(read(path))}));
 const {auditHostIssuers}=await import(pathToFileURL(join(repo,'tests/editor/completion/host-final-issuers.mjs')).href);
 const audit=auditHostIssuers(manifest,{read:virtualRead,list:path=>readdirSync(join(repo,path)),applicationIdentity:identity});
 const receipt={schema:1,kind:'COMPLETION-ISSUER-ADOPTION-1',createdAt:new Date().toISOString(),status:adopt?'adopted':'prepared',command:'node tooling/qualification/completion-issuers/index.mjs --output <fresh-directory>'+ (adopt?' --adopt':''),producerInputs,
  historical:{producerSHA256:sha(read(historicalProducer)),manifestSHA256:sha(read(historicalManifest))},
  applicationIdentity:auditApplicationIdentity(identity,{read}),candidateFiles:['application-identity.json','host-final-issuers.json'].map(path=>{const b=readFileSync(join(destination,path));return {path,bytes:b.length,sha256:sha(b)};}),
  audit,pins:pins.length,modules:modules.length,classifications:network.classifiedNetworking,workerFallbacks:network.workerFallbacks,
  scope:'Source/build identity and static issuer contract only; no native, browser, CSP, transport-completion or product-qualification pass is inherited from historical receipts.'};
 if(adopt){copyFileSync(join(destination,'application-identity.json'),join(repo,'tests/editor/completion/application-identity.json'));copyFileSync(join(destination,'host-final-issuers.json'),join(repo,'tests/editor/completion/host-final-issuers.json'));
 }
 writeFileSync(join(destination,'receipt.json'),json(receipt));return {output:destination,adopted:adopt,receipt:join(destination,'receipt.json'),env:{COMPLETION_APPLICATION_IDENTITY:join(destination,'application-identity.json'),COMPLETION_ISSUER_MANIFEST:join(destination,'host-final-issuers.json')}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.includes('--check-source')){console.log(JSON.stringify(verifyCompletionSource(process.cwd())));process.exit(0);}const at=process.argv.indexOf('--output');assert(at!==-1&&process.argv[at+1],'--output <fresh-directory> is required');console.log(JSON.stringify(await prepareCompletionIssuers(process.argv[at+1],process.cwd(),{adopt:process.argv.includes('--adopt')})));}
