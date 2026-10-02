import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,lstatSync,renameSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeOwnedImportOutput} from '../../dist/local/server/raster/import-producers.js';
test('native orchestration refuses a replaced output inode instead of silently claiming cleanup',t=>{
 const directory=mkdtempSync(join(tmpdir(),'import-output-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const output=join(directory,'pixels.rgba'),moved=join(directory,'retained-original');writeFileSync(output,'owned',{mode:0o600});const before=lstatSync(output);renameSync(output,moved);writeFileSync(output,'replacement',{mode:0o600});assert.throws(()=>removeOwnedImportOutput(output,before),/RASTER_INPUT_CHANGED/);assert.equal(readFileSync(output,'utf8'),'replacement');assert.equal(readFileSync(moved,'utf8'),'owned');
 rmSync(output);renameSync(moved,output);removeOwnedImportOutput(output,before);assert.equal(existsSync(output),false);
});
