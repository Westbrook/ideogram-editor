import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';

test('legacy cache checks bytes, compiler identity and independent writable restoration',t=>{
 const original=process.cwd(),oldCache=process.env.IE_VALIDATION_LEGACY_CACHE;
 const root=mkdtempSync(join(tmpdir(),'legacy-cache-control-'));
 t.after(()=>{process.chdir(original);if(oldCache===undefined)delete process.env.IE_VALIDATION_LEGACY_CACHE;else process.env.IE_VALIDATION_LEGACY_CACHE=oldCache;rmSync(root,{recursive:true,force:true});});
 for(const path of ['server','src','tooling','node_modules/typescript/bin'])mkdirSync(join(root,path),{recursive:true});
 for(const path of ['server/input','src/input','tooling/input','tsconfig.server.json'])writeFileSync(join(root,path),'archived input');
 // A tiny deterministic compiler controls the cache protocol. Real historical
 // TypeScript compilation is covered by the unchanged migration callers.
 const compiler="const fs=require('node:fs'),p=require('node:path');const root=p.dirname(process.argv.at(-1));fs.mkdirSync(p.join(root,'dist'),{recursive:true});fs.writeFileSync(p.join(root,'dist/output'),fs.readFileSync(p.join(root,'server/input')));";
 writeFileSync(join(root,'node_modules/typescript/bin/tsc'),compiler);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(['init']);git(['add','server','src','tooling','tsconfig.server.json']);git(['-c','user.name=Cache test','-c','user.email=test@example.invalid','commit','-m','fixture']);const commit=git(['rev-parse','HEAD']).trim();
 process.chdir(root);process.env.IE_VALIDATION_LEGACY_CACHE=join(root,'cache');
 const a=compileLegacy(join(root,'a'),commit);assert.equal(a.mode,'compiled');
 writeFileSync(join(root,'a/dist/output'),'mutable test damage');writeFileSync(join(root,'a/server/input'),'different source');
 const b=compileLegacy(join(root,'b'),commit);assert.equal(b.mode,'reused');assert.equal(readFileSync(join(root,'b/dist/output'),'utf8'),'archived input');assert.equal(readFileSync(join(root,'b/server/input'),'utf8'),'archived input');
 writeFileSync(join(root,'cache',a.key,'content/dist/output'),'cache damage');
 const c=compileLegacy(join(root,'c'),commit);assert.equal(c.mode,'compiled');assert.equal(readFileSync(join(root,'c/dist/output'),'utf8'),'archived input');assert.ok(readdirSync(join(root,'cache')).some(x=>x.includes('.invalid-')));
 writeFileSync(join(root,'node_modules/typescript/bin/tsc'),compiler+'\n// changed compiler');
 const d=compileLegacy(join(root,'d'),commit);assert.equal(d.mode,'compiled');assert.notEqual(d.key,a.key);
 assert.throws(()=>compileLegacy(join(root,'a'),commit),/must be empty/);
 writeFileSync(join(root,'node_modules/typescript/bin/tsc'),"throw Error('compiler-negative-control');");
 assert.throws(()=>compileLegacy(join(root,'failed'),commit),/compiler-negative-control/);
 assert.ok(readdirSync(join(root,'cache')).some(x=>x.includes('.failed-')));
 writeFileSync(join(root,'node_modules/typescript/bin/tsc'),compiler);
 delete process.env.IE_VALIDATION_LEGACY_CACHE;
 assert.equal(compileLegacy(join(root,'fresh'),commit).mode,'fresh');assert.ok(existsSync(join(root,'fresh/source.tar')));
 assert.ok(!readdirSync(join(root,'cache')).some(x=>x.endsWith('.lock')||x.endsWith('.partial')));
});
