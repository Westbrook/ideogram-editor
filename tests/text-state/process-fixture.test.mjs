import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {isolated} from './helpers.mjs';
import {rootFor} from '../store/helpers.mjs';

function appEnvironment(t,value){
 const before=process.env.TEXT_STATE_APP;
 if(value===undefined)delete process.env.TEXT_STATE_APP;else process.env.TEXT_STATE_APP=value;
 t.after(()=>{if(before===undefined)delete process.env.TEXT_STATE_APP;else process.env.TEXT_STATE_APP=before;});
}

test('ordinary text-state fixture needs no app and child exit rejects pending and future IPC waits', {timeout:10000},async t=>{
 appEnvironment(t,undefined);
 const f=await isolated(t);assert.equal(f.paired.status,200);
 const pending=f.wait('barrier');
 await assert.rejects(f.wait('barrier'),/already pending for barrier/);
 const refused=assert.rejects(pending,error=>error.code==='TEXT_STATE_CHILD_EXIT'&&error.signal==='SIGKILL');
 await f.kill();await refused;
 await assert.rejects(f.wait('ready'),error=>error.code==='TEXT_STATE_CHILD_EXIT'&&error.signal==='SIGKILL');
 await assert.rejects(f.memory(),error=>error.code==='TEXT_STATE_CHILD_EXIT');
});

test('explicit missing browser fixture is refused promptly with the actual child diagnostic', {timeout:10000},async t=>{
 const root=await rootFor(t);appEnvironment(t,join(root,'unbuilt-app'));
 await assert.rejects(isolated(t),error=>error.code==='TEXT_STATE_CHILD_EXIT'&&error.exitCode!==0&&/ENOENT/.test(error.message));
});

test('explicit browser fixture cannot overlap the private storage root', {timeout:10000},async t=>{
 const root=await rootFor(t);appEnvironment(t,root);
 await assert.rejects(isolated(t,{root}),error=>error.code==='TEXT_STATE_CHILD_EXIT'&&error.exitCode!==0&&/trusted browser build and private storage must be separate/.test(error.message));
});
