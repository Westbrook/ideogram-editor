import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveImportArtifactPath} from '../../dist/local/server/raster/import-producers.js';
test('native import artifact is resolved from the trusted installed package root, with no current-directory authority',()=>{
 assert.equal(resolveImportArtifactPath('vendor/raster/advanced-webp/1.6.0-ideogram-advanced.1/darwin-arm64/libideogram-webp.dylib','/private/package'),'/private/package/vendor/raster/advanced-webp/1.6.0-ideogram-advanced.1/darwin-arm64/libideogram-webp.dylib');
 for(const path of ['/tmp/codec','../vendor/raster/codec','vendor/raster/../codec','vendor/raster/./codec','vendor/raster/a//codec','vendor/raster/a\\codec','node_modules/codec','vendor/raster/codec/'])assert.throws(()=>resolveImportArtifactPath(path,'/private/package'),/RASTER_CODEC_UNQUALIFIED/);
 assert.throws(()=>resolveImportArtifactPath('vendor/raster/codec','relative-package'),/RASTER_CODEC_UNQUALIFIED/);
});
