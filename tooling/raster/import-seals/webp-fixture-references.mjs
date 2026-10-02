// Schema-specific retained fixture references. The historical generic walker
// still ignores provenance files/inputs; only these actual encoded-byte copies
// are additional proof edges, under the original fixture manifest hash.
import assert from 'node:assert/strict';
import {digest, MAX_FILES, MAX_FILE_BYTES, relativePath} from './files.mjs';

export function declaredWebPFixtureEncoderReferences(value) {
  if (value?.schemaVersion !== 1 || value.kind !== 'webp-host-fixtures-v1') return [];
  const encoder = value.encoder;
  assert(encoder && encoder.schemaVersion === 1 && encoder.kind === 'webp-fixture-encoder-v1',
    'WebP fixture encoder schema differs');
  assert(Array.isArray(encoder.files) && encoder.files.length > 0 && encoder.files.length <= MAX_FILES);
  assert(Array.isArray(encoder.authority?.inputs) && encoder.authority.inputs.length === 2);
  const references = [], paths = new Set();
  for (const row of [...encoder.files, ...encoder.authority.inputs]) {
    assert(row && typeof row === 'object' && !Array.isArray(row));
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'hash', 'path', 'repositoryPath']);
    relativePath(row.repositoryPath); relativePath(row.path);
    assert.equal(row.path, 'encoder/files/' + row.repositoryPath + '.data',
      'WebP fixture retained path differs from its repository provenance');
    assert(!paths.has(row.path), 'Duplicate WebP fixture encoder reference'); paths.add(row.path);
    assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_FILE_BYTES);
    digest(row.hash); references.push({path: row.path, bytes: row.bytes, hash: row.hash});
  }
  assert(references.length <= MAX_FILES, 'WebP fixture encoder reference bound exceeded');
  return references;
}
