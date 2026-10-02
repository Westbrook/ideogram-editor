import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,openSync,writeSync,fstatSync,closeSync,renameSync,writeFileSync,readFileSync,existsSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeJPEGScratch} from '../../dist/local/server/raster/jpeg-import/scratch.js';
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'jpeg-scratch-')),path=join(directory,'raw'),fd=openSync(path,'wx+',0o600),stamp=fstatSync(fd,{bigint:true});t.after(()=>{closeSync(fd);rmSync(directory,{recursive:true,force:true});});return {directory,path,fd,stamp};}
test('owned P3 normalization changes bytes/mtime without changing scratch unlink authority',t=>{const f=fixture(t);writeSync(f.fd,Buffer.from([11,22,33,255]),0,4,0);writeSync(f.fd,Buffer.from([20,30,40,255]),0,4,0);assert.equal(fstatSync(f.fd).size,4);removeJPEGScratch(f.path,f.fd,f.stamp);assert.equal(existsSync(f.path),false);assert.equal(fstatSync(f.fd,{bigint:true}).nlink,0n);});
test('replacement inode cannot be removed or reported reclaimed; repair permits exact retry',t=>{const f=fixture(t),moved=join(f.directory,'moved');writeSync(f.fd,'original');renameSync(f.path,moved);writeFileSync(f.path,'foreign',{mode:0o600});assert.throws(()=>removeJPEGScratch(f.path,f.fd,f.stamp),/RASTER_INPUT_CHANGED/);assert.equal(readFileSync(f.path,'utf8'),'foreign');assert.equal(fstatSync(f.fd,{bigint:true}).nlink,1n);unlinkSync(f.path);renameSync(moved,f.path);removeJPEGScratch(f.path,f.fd,f.stamp);assert.equal(fstatSync(f.fd,{bigint:true}).nlink,0n);});
test('missing pathname from rename retains disk authority while proved unlink is releasable',t=>{const f=fixture(t),moved=join(f.directory,'moved');renameSync(f.path,moved);assert.throws(()=>removeJPEGScratch(f.path,f.fd,f.stamp),/RASTER_INPUT_CHANGED/);unlinkSync(moved);assert.doesNotThrow(()=>removeJPEGScratch(f.path,f.fd,f.stamp));});
