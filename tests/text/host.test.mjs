import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startLocalServer} from '../../dist/local/server/http.js';
import {call} from '../session/helpers.mjs';
test('trusted text assets and worker-only WASM CSP preserve the static boundary',async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-text-static-')),publicRoot=join(directory,'public');
  await mkdir(publicRoot);
  const fixtures={'index.html':'<!doctype html><html><head><title>Text</title></head><body></body></html>',
    'worker.js':'self.close();','engine.wasm':'sealed test bytes','face.ttf':'font','face.otf':'font','private.json':'not public'};
  for(const [name,bytes] of Object.entries(fixtures))await writeFile(join(publicRoot,name),bytes);
  const server=await startLocalServer({root:join(directory,'private'),staticDirectory:publicRoot});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true});});
  for(const [path,type] of [['/engine.wasm','application/wasm'],['/face.ttf','font/ttf'],['/face.otf','font/otf']]){
    const r=await call(server.origin,path);assert.equal(r.status,200);assert.equal(r.headers['content-type'],type);
    assert.ok(!r.headers['content-security-policy'].includes('wasm-unsafe-eval'));
  }
  const worker=await call(server.origin,'/worker.js',{headers:{'Sec-Fetch-Dest':'worker','Sec-Fetch-Site':'same-origin'}});
  assert.equal(worker.status,200);assert.ok(worker.headers['content-security-policy'].includes("'wasm-unsafe-eval'"));
  assert.ok(!worker.headers['content-security-policy'].includes("'unsafe-eval'"));
  for(const [path,headers] of [['/',{'Sec-Fetch-Dest':'worker'}],['/worker.js',{}],['/worker.js',{'Sec-Fetch-Dest':'script'}]]){
    const r=await call(server.origin,path,{headers});assert.equal(r.status,200);assert.ok(!r.headers['content-security-policy'].includes('wasm-unsafe-eval'));
  }
  assert.equal((await call(server.origin,'/private.json')).status,404);
  const foreign=await call(server.origin,'/worker.js',{headers:{Origin:'https://example.invalid','Sec-Fetch-Dest':'worker'}});
  assert.equal(foreign.status,403);assert.ok(!foreign.headers['content-security-policy'].includes('wasm-unsafe-eval'));
});
