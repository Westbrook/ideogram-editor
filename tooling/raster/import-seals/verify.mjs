import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyImportInventory} from './capsule.mjs';
export {verifyImportInventory};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.versions.node,'26.10.0');assert(process.argv.length===2||process.argv.length===3);console.log(JSON.stringify(verifyImportInventory(resolve(process.argv[2]??'.'))));}
