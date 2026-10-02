import assert from 'node:assert/strict';
import {stageImportAdoption} from './capsule.mjs';
assert.equal(process.versions.node,'26.10.0');
assert.equal(process.argv.length,6,'adopt.mjs ROOT COMPLETE_CAPSULE MANIFEST_HASH NEW_OVERLAY');
const [root,capsule,manifestHash,output]=process.argv.slice(2);
const result=stageImportAdoption({root,capsule,manifestHash,output});
console.log(JSON.stringify({status:result.manifest.status,output:result.output,pipeline:result.manifest.profile,registered:false}));
