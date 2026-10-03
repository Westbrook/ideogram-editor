import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { CANVAS2D_RENDERER_CONTRACT, REVIEWED_RENDERER_OWNERSHIP, captureRendererOwnershipProof,
  verifyRendererOwnershipProof, isRendererTextureNotApplicable, validateRendererWorkerProvenance } from '../../tooling/qualification/campaigns/renderer-ownership.mjs';

function context() {
  // Intentionally unreviewed in-memory inputs. A caller cannot approve these
  // by signing its own manifest, and this test must never read a live build.
  const sourceFiles = [{ path: 'src/unreviewed-renderer.ts', bytes: 1, sha256: digest('x').slice(7) }];
  const buildFiles = [{ path: 'dist/app/unreviewed.js', bytes: 1, sha256: digest('x') }];
  const executableIdentity = { sourceDigest: digestJSON(sourceFiles), buildDigest: digest(buildFiles), toolsDigest: digest('test tools') };
  return { sourceFiles, buildFiles, executableIdentity };
}
function unreviewedProof() {
  return { kind: 'renderer-ownership-proof-1', reviewId: 'unreviewed-test-renderer', reviewSha256: digest('self-declared review'),
    contract: 'canvas2d-owned-rgba-v1', executableIdentity: context().executableIdentity,
    artifact: { path: '/retained/renderer-ownership.json', retainedPath: 'renderer-ownership.json', bytes: 1, sha256: digest('x') } };
}
const claim = bytes => ({ ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: bytes });

test('renderer contract records Canvas2D ownership without inventing a hardware texture limit', () => {
  assert.deepEqual(CANVAS2D_RENDERER_CONTRACT, { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d',
    appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable' });
  assert.equal(Object.hasOwn(CANVAS2D_RENDERER_CONTRACT, 'deviceTextureLimit'), false);
  assert.equal(Object.hasOwn(CANVAS2D_RENDERER_CONTRACT, 'rgbaBackingEstimateBytes'), false);
  assert(Object.isFrozen(CANVAS2D_RENDERER_CONTRACT));
  assert(Object.isFrozen(CANVAS2D_RENDERER_CONTRACT.appOwnedTextureAPIs));
  assert(Object.isFrozen(REVIEWED_RENDERER_OWNERSHIP));
});

test('unreviewed production bytes fail closed before any filesystem reads or evidence writes', async () => {
  const result = await captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...context() });
  assert.deepEqual(result, { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] });
});

test('renderer capture binds both independent parent manifests before considering a source approval', async () => {
  const changes = [
    value => { value.sourceFiles[0].bytes++; },
    value => { value.buildFiles[0].bytes++; },
    value => { value.executableIdentity.sourceDigest = digest('other source').slice(7); },
    value => { value.executableIdentity.buildDigest = digest('other build'); },
    value => { value.executableIdentity.toolsDigest = 'not a digest'; },
    value => { value.sourceFiles.push({ ...value.sourceFiles[0] }); value.executableIdentity.sourceDigest = digestJSON(value.sourceFiles); },
    value => { value.buildFiles[0].path = '../app/unreviewed.js'; value.executableIdentity.buildDigest = digest(value.buildFiles); },
  ];
  for (const change of changes) {
    const value = context(); change(value);
    await assert.rejects(captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...value }), Error);
  }
});

test('compact renderer metadata survives serialization but cannot approve its own review', async () => {
  const proof = unreviewedProof(), text = JSON.stringify(proof), parsed = JSON.parse(text);
  assert(Buffer.byteLength(text) < 1024);
  assert.deepEqual(parsed, proof);
  let reads = 0;
  await assert.rejects(verifyRendererOwnershipProof(parsed, { output: '/retained', ...context(), readRetained: async () => { reads++; return Buffer.from('x'); } }), /no exact approved source review/);
  assert.equal(reads, 0);
  assert.equal(isRendererTextureNotApplicable(claim(4096), parsed, { gpuBytes: 4096 }), false);
});

test('renderer proof replay rejects oversized or unknown metadata before reading retained input', async () => {
  const proof = unreviewedProof(); proof.artifact.path = '/' + 'x'.repeat(2048) + '/renderer-ownership.json';
  await assert.rejects(verifyRendererOwnershipProof(proof, { ...context(), readRetained: async () => { throw Error('must not read'); } }), /Malformed renderer ownership proof metadata/);
  const forged = { ...unreviewedProof(), status: 'PASS' };
  await assert.rejects(verifyRendererOwnershipProof(forged), /Malformed renderer ownership proof metadata/);
});

test('missing or caller-declared Canvas2D evidence never grants texture-limit N/A', () => {
  for (const proof of [null, {}, { status: 'PASS' }, { ...unreviewedProof(), reviewed: true }, unreviewedProof()]) {
    assert.equal(isRendererTextureNotApplicable(claim(4096), proof, { gpuBytes: 4096 }), false);
  }
  // The real reviewed registry intentionally has no synthetic test override.
  // A positive N/A regression requires actual reviewed production pins.
  for (const producer of [
    claim(0), claim(4096), claim(-1), claim(NaN), { ...claim(4096), appOwnedTextureAPIs: ['WebGLRenderingContext'] },
    { ...claim(4096), appOwnedTextureCount: 1 }, { ...claim(4096), textureLimitApplicability: 'applicable' },
    { ...claim(4096), backend: 'webgpu' }, { ...claim(4096), deviceTextureLimit: 16384 },
  ]) assert.equal(isRendererTextureNotApplicable(producer, unreviewedProof(), { gpuBytes: 4096 }), false);
});

test('changing a serialized review digest cannot introduce an approval', () => {
  const proof = unreviewedProof(); proof.reviewSha256 = digest({ review: 'new renderer declaration', contract: CANVAS2D_RENDERER_CONTRACT });
  assert.equal(isRendererTextureNotApplicable(claim(128), proof, { gpuBytes: 128 }), false);
  assert.equal(isRendererTextureNotApplicable(claim(128), proof, { gpuBytes: 0 }), false);
});


// These deliberately synthetic structural operands do not supply a registry
// approval. They exercise the worker-to-final-output join independently of an
// outer artifact checksum, so resealed malformed metadata cannot pass it.
function workerProvenance(){
 const nativeFiles=[['package','package.json'],['loader','bin/canvaskit.js'],['wasm','bin/canvaskit.wasm']].map(([role,path])=>({role,path:'node_modules/canvaskit-wasm/'+path,bytes:10,sha256:digest(role),encoding:role==='wasm'?'base64':'utf8'}));
 const modules=['src/text/worker.ts',nativeFiles[1].path],imports=[],file='assets/worker.js',bytes=42,sha256=digest('worker').slice(7);
 const workerBundle={schema:1,phase:'generateBundle',format:'iife',entry:modules[0],chunkEntry:true,facade:modules[0],file,bytes,sha256,modules:[...modules],imports:[...imports]};
 return {nativeFiles,evidence:{nativeInputs:nativeFiles.map(({path,bytes,sha256})=>({path,bytes,sha256:sha256.slice(7)})),outputs:[{file,bytes,sha256,modules,imports,entry:false,workerBundle}]}};
}
test('worker provenance binds native identities and exact emitted asset metadata without granting approval',()=>{
 const {nativeFiles,evidence}=workerProvenance();assert.doesNotThrow(()=>validateRendererWorkerProvenance(evidence,nativeFiles));
 assert.equal(isRendererTextureNotApplicable(claim(4096),{status:'PASS',evidence},{gpuBytes:4096}),false);
});
test('worker provenance rejects omitted native inputs and changed native identities after outer resealing',()=>{
 for(const change of [e=>{delete e.nativeInputs;},e=>{e.nativeInputs.pop();},e=>{e.nativeInputs[1].sha256=digest('other loader').slice(7);},e=>{e.nativeInputs.push(e.nativeInputs[0]);}]){
  const {nativeFiles,evidence}=workerProvenance();change(evidence);assert.throws(()=>validateRendererWorkerProvenance(evidence,nativeFiles),/sealed native|compiled native inputs differ/);
 }
});
test('worker provenance rejects omitted, duplicated or inconsistent worker-to-output joins after outer resealing',()=>{
 const mutations=[
  e=>{delete e.outputs[0].workerBundle;},e=>{e.outputs[0].workerBundle.bytes++;},e=>{e.outputs[0].workerBundle.sha256=digest('other chunk').slice(7);},
  e=>{e.outputs[0].workerBundle.file='assets/other.js';},e=>{e.outputs[0].workerBundle.modules.pop();},e=>{e.outputs[0].workerBundle.imports.push('assets/other.js');},
  e=>{e.outputs[0].workerBundle.facade='src/other.ts';},e=>{e.outputs[0].workerBundle.chunkEntry=false;},e=>{e.outputs[0].workerBundle.entry='../outside.ts';},
  e=>{e.outputs[0].entry=true;},e=>{e.outputs[0].workerBundle.phase='writeBundle';},e=>{e.outputs[0].workerBundle.format='es';},
  e=>{e.outputs.push(structuredClone(e.outputs[0]));},e=>{e.outputs[0].workerBundle.unknown=true;},
  e=>{const o=e.outputs[0];o.modules=o.workerBundle.modules=['src/text/worker.ts','node_modules/other/node_modules/canvaskit-wasm/bin/canvaskit.js'];},
 ];
 for(const change of mutations){const {nativeFiles,evidence}=workerProvenance();change(evidence);const resealed=JSON.parse(JSON.stringify(evidence));assert.throws(()=>validateRendererWorkerProvenance(resealed,nativeFiles),Error);}
});
