// Node26 removed transform-types. Preserve the pinned implementation in this realm.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';

export const PINNED_CANONICAL_SOURCE=Object.freeze({repositoryPath:'src/protocol/json.ts',bytes:4337,hash:'sha256:2c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4'});
const declaration="export class JSONError extends Error { constructor(readonly code: 'MALFORMED_REQUEST' | 'PAYLOAD_TOO_LARGE') { super(code); } }";
const lowered='export class JSONError extends Error { code; constructor(code) { super(code); this.code = code; } }';

export function lowerPinnedCanonicalSource(bytes){
 assert(Buffer.isBuffer(bytes),'Canonical source must be exact captured bytes');
 assert.equal(bytes.length,PINNED_CANONICAL_SOURCE.bytes,'Changed canonical source length');
 assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),PINNED_CANONICAL_SOURCE.hash,'Changed canonical source identity');
 const source=bytes.toString('utf8');
 assert(source.startsWith(declaration+'\n'),'Pinned JSONError declaration must be the exact first line');
 assert.equal(source.indexOf(declaration),source.lastIndexOf(declaration),'Lower exactly one declaration');
 return lowered+source.slice(declaration.length);
}

export async function loadPinnedCanonical(bytes){
 assert.equal(process.versions.node,'26.10.0','Canonical stripping is pinned to the repository runtime');
 const source=lowerPinnedCanonicalSource(bytes);
 const javascript=stripTypeScriptTypes(source,{mode:'strip'});
 // A same-realm ESM module preserves canonical's Object.prototype identity check.
 return import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
}
