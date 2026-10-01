import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {textPlacementSchema,compositionSchema} from '../../dist/local/server/storage/schema.js';
// Boundary unit controls; actual migration/rollback/SIGKILL suites still use
// real SQLite and filesystems. Stop at the first admitted migration barrier.
for(const [name,migrate,version] of [['text placement',textPlacementSchema,11],['composition',compositionSchema,12]])test(`${name} migration preserves the 90% disk ceiling and exact reserve`,()=>{
 const admitted=new Error('admitted at backup barrier'),original=fs.statfsSync;
 const db={prepare(sql){return {all:()=>[],get:()=>sql==='PRAGMA user_version'?{user_version:version}:sql==='PRAGMA page_count'?{page_count:1}:{page_size:4096}};}};
 const check=(space,expected)=>{fs.statfsSync=()=>space;syncBuiltinESMExports();assert.throws(()=>migrate(db,'unused-root',()=>{throw admitted;}),error=>expected==='admitted'?error===admitted:error.code==='CAPACITY');};
 try{
  for(const used of [80n,85n,89n,90n,91n])check({blocks:100n*1024n**3n,bavail:(100n-used)*1024n**3n,bsize:1n},used<90n?'admitted':'capacity');
  const required=4096n+1024n+1024n**3n+64n*1024n**2n;
  for(const free of [required-1n,required,required+1n])check({blocks:free,bavail:free,bsize:1n},free>=required?'admitted':'capacity');
 }finally{fs.statfsSync=original;syncBuiltinESMExports();}
});
