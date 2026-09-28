import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,symlink} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {rootFor,refFor} from './helpers.mjs';

test('cooperative proofs distinguish missing and corrupt bytes while retaining unsafe-file refusal',async t=>{
 const root=await rootFor(t),objects=new Objects(root,()=>{},()=>{}),bytes=Buffer.alloc(2*1024*1024,41),ref=refFor(bytes),path=objects.path(ref);
 t.after(()=>objects.close());await mkdir(join(root,'objects','sha256',ref.hash.slice(7,9)),{mode:0o700});
 await assert.rejects(objects.prove(ref,()=>{}),{code:'MISSING_OBJECT'});
 await writeFile(path,Buffer.from('corrupt'),{mode:0o600});await assert.rejects(objects.prove(ref,()=>{}),{code:'CORRUPT_OBJECT'});await unlink(path);
 const outside=join(root,'retained-original');await writeFile(outside,bytes,{mode:0o600});await symlink(outside,path);await assert.rejects(objects.prove(ref,()=>{}),{code:'ROOT_UNSAFE'});await unlink(path);
 await writeFile(path,bytes,{mode:0o600});let checks=0;await assert.rejects(objects.prove(ref,()=>{if(++checks===2)unlinkSync(path);}),{code:'MISSING_OBJECT'});
 await writeFile(path,bytes,{mode:0o600});const proof=await objects.prove(ref,()=>{});objects.proven(ref,proof);objects.releaseProof(proof);
});
