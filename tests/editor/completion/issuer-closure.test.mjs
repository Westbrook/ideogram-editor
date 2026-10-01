import test from 'node:test';
import assert from 'node:assert/strict';
import {emittedClosure} from './issuer-closure.mjs';

function fixture(){
 const files=new Map([
  ['dist/app/index.html','<script src="/assets/index-new.js"></script><link href="/assets/theme-new.css"><a href="">Reload</a>'],
  ['dist/app/.vite/manifest.json',JSON.stringify({'index.html':{src:'index.html',isEntry:true,file:'assets/index-new.js',css:['assets/theme-new.css'],assets:['assets/font.ttf']}})],
  ['dist/app/assets/index-new.js','export {};'],['dist/app/assets/theme-new.css','@font-face{src:url("./font.ttf")}'],['dist/app/assets/font.ttf','font'],
 ]);
 const options=()=>({read:path=>{assert(files.has(path),'Known fixture '+path);return Buffer.from(files.get(path));},pins:[...files.keys()].map(path=>({path}))});return {files,options};
}
test('current CSS name and relative URL close through actual HTML and manifest',()=>{const f=fixture(),result=emittedClosure(f.options());assert.deepEqual(result.css,['dist/app/assets/theme-new.css']);assert.deepEqual(result.cssEdges,[{path:'dist/app/assets/theme-new.css',value:'"./font.ttf"'}]);assert.equal(result.entryPath,'dist/app/assets/index-new.js');});
test('every emitted stylesheet is inventoried even without an entry name',()=>{const f=fixture();f.files.set('dist/app/assets/lazy.css','@import "./theme-new.css";');assert.equal(emittedClosure(f.options()).cssEdges.length,2);});
for(const value of ['https://example.test/font.ttf','//example.test/font.ttf','../../../outside.ttf','./missing.ttf','./font.ttf?fresh'])test('CSS refuses unclosed edge '+value,()=>{const f=fixture();f.files.set('dist/app/assets/theme-new.css',`a{background:url(${value})}`);assert.throws(()=>emittedClosure(f.options()));});
test('manifest cannot select a script absent from actual document',()=>{const f=fixture();f.files.set('dist/app/.vite/manifest.json',JSON.stringify({'index.html':{src:'index.html',isEntry:true,file:'assets/other.js'}}));f.files.set('dist/app/assets/other.js','');assert.throws(()=>emittedClosure(f.options()),/real HTML script/);});
test('every Vite asset must exist in the complete emitted set',()=>{const f=fixture();f.files.delete('dist/app/assets/font.ttf');f.files.set('dist/app/assets/theme-new.css','');assert.throws(()=>emittedClosure(f.options()),/Closed Vite manifest output/);});
