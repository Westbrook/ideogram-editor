import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import {createProductFixture,createDocument} from '../../tooling/qualification/campaigns/backend-common.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';

test('failed fixture publication closes its writer and retains the recoverable root',{timeout:10000},async t=>{
 const output=ownTestRoot(await fs.mkdtemp(join(tmpdir(),'campaign-lifetime-'))),write=fs.writeFile;
 const failure=Error('deliberate fixture receipt failure');let root;
 const mock=t.mock.method(fs,'writeFile',async(path,...args)=>{if(String(path).startsWith(join(output,'fixture-private-'))){root=join(output,String(path).split('/').at(-1).slice('fixture-'.length,-'.json'.length));throw failure;}return write(path,...args);});
 syncBuiltinESMExports();
 try{await assert.rejects(createProductFixture({repo:process.cwd(),output}),error=>error===failure);}finally{mock.mock.restore();syncBuiltinESMExports();}
 assert(root);await fs.access(join(root,'metadata.sqlite'));
 const writer=await openWriter({root:resolve(root)});try{assert((await writer.capture()).highWater);}finally{await writer.close();}
});

test('fixture reopen refreshes its binding and keeps the exact document',{timeout:10000},async()=>{
 const output=ownTestRoot(await fs.mkdtemp(join(tmpdir(),'campaign-reopen-'))),fixture=await createProductFixture({repo:process.cwd(),output});
 try{const before=await createDocument(fixture);const epoch=fixture.writer.epoch;await fixture.reopen();assert.notEqual(fixture.writer.epoch,epoch);assert.deepEqual(await fixture.writer.document(fixture.documentId),before);}finally{await fixture.close();}
});
