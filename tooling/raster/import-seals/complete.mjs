import assert from 'node:assert/strict';
import {completeImportCapsule} from './capsule.mjs';
assert.equal(process.versions.node,'26.10.0');
assert.equal(process.argv.length,8,'complete.mjs ROOT ISSUED_CAPSULE MANIFEST_HASH ORIGINAL_QUALIFICATION EVIDENCE_ROOT NEW_OUTPUT');
const [root,source,manifestHash,qualification,evidenceRoot,output]=process.argv.slice(2);
const result=completeImportCapsule({root,source,manifestHash,qualification,evidenceRoot,output});
console.log(JSON.stringify({status:'verified-proof-capsule',output:result.output,manifestHash:result.manifestHash,pipeline:result.profile.pipeline,registered:false}));
