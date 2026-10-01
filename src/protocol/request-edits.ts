import type { ImageVersion } from './history.js';

export type RequestSourceCapture = {
  schemaVersion: 1;
  documentId: string;
  documentRevision: string;
  image: ImageVersion;
  scope: 'single-layer' | 'visible-document' | 'selected-layers';
  layerIds: string[];
};

// Independent of the general protocol validator because raster manifests also
// validate this metadata while the protocol module is being initialized.
export function validateRequestSourceCapture(value: unknown): asserts value is RequestSourceCapture {
  const v = value as RequestSourceCapture;
  const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
  const seq = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
  const exact = (x: unknown, fields: string[]) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
  const fail = () => { throw new Error('Invalid request source capture'); };
  if (!exact(v, ['schemaVersion','documentId','documentRevision','image','scope','layerIds']) || v.schemaVersion !== 1 || !id(v.documentId) || !seq(v.documentRevision) || !['single-layer','visible-document','selected-layers'].includes(v.scope) || !Array.isArray(v.layerIds) || v.layerIds.length > 100 || !v.layerIds.every(id) || new Set(v.layerIds).size !== v.layerIds.length) fail();
  if (v.scope === 'single-layer' ? v.layerIds.length !== 1 : v.layerIds.length === 0) fail();
  const image = v.image;
  if (!exact(image, ['state','semanticDigest','compositeAssetId']) || !/^sha256:[a-f0-9]{64}$/.test(image.semanticDigest) || !(image.compositeAssetId === null || id(image.compositeAssetId))) fail();
  const state = image.state;
  if (!exact(state, ['hash','byteLength','mediaType']) || !/^sha256:[a-f0-9]{64}$/.test(state.hash) || !seq(state.byteLength) || BigInt(state.byteLength) > 65536n || state.mediaType !== 'application/json') fail();
}
