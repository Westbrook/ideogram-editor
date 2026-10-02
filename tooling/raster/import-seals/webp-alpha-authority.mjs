// Frozen source identities select one repaired producer. They do not prove
// native correctness, issue a profile, or authorize a replacement by name.
import assert from 'node:assert/strict';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Keep this tuple identical to the issuer's selected candidate authority.
export const ALPHA_SELECTED = freeze({
  producerDirectory: 'producer-alpha-repair-v1',
  version: '1.6.0-ideogram-advanced-alpha.1',
  candidate: {bytes: 385374, hash: 'sha256:5d19aef5a3a964f37aa03b53023bf8693f4dffe8d7ebcc1891e91dd2b2e85198'},
  artifact: {path: 'libideogram-webp-advanced.1.dylib', bytes: 266464, hash: 'sha256:4d62c47a574b213646d93967732294da0eb708407d43ec0fc95ca194489bcf52'},
  recipe: {bytes: 2655, hash: 'sha256:4c12ec94d93b267a40e27e9240632b0c37ae6ee7c8c3de3de2357d9e4412aa39'},
  sourceFreezeHash: 'sha256:38aefdb2a0572fc5f78cc3ef83d3fb36fe3b66cd9f1c3abce6c4c31ee8bc2ccd',
  producerHash: 'sha256:c0131b361b7c8941578c81a75f62cb2e5f6c3299a57f2dbbdec580f739e028de',
  platform: 'darwin', arch: 'arm64',
});

export const ALPHA_SOURCE = freeze({
  version: '1.6.0',
  archive: 'vendor/raster/bounded-webp/1.6.0-ideogram.1/libwebp-1.6.0.tar.gz',
  bytes: 4296070,
  hash: 'sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
});
export const ALPHA_SOURCE_FREEZE = freeze({path: 'source-freeze.json', bytes: 2080, hash: ALPHA_SELECTED.sourceFreezeHash});
export const ALPHA_REPAIR = freeze({path: 'alpha-repair-v1/repair-manifest.json', bytes: 3466,
  hash: 'sha256:5bae1ccd57b0a166a3d740c66806024f9faed2fb9333de275ecfc3ee9ffe289b'});
export const ALPHA_PREDECESSOR = freeze({path: 'producer-v2/source-manifest.json', bytes: 3924,
  hash: 'sha256:039a63df55448b0c653e9e95fdc7baf2ab5cc2f350a7ee7db74c3eb5d55703a9'});
export const ALPHA_ORIGINAL = freeze({path: 'producer/source-manifest.json', bytes: 1362,
  hash: 'sha256:b462f1eb68c46eb5730047622fa119b27f7213450582242fb6806a26846220d3'});
export const ALPHA_PRODUCER_REVIEW = freeze({path: 'MEMORY-PRODUCER-REVIEW-01.json', bytes: 3499,
  hash: 'sha256:4212c10b2afeecf235b6b03ee39f5bb29890827bfa24ed778cb6d0faa123d071'});
export const ALPHA_BASE_CODEC = 'sha256:41788495dc59578314b09974051b717b9a28f47d118b16d1bd204dca147be81e';
// This source-only predecessor is provenance, never the final host driver seal.
export const ALPHA_HOST_POLICY = freeze({directory: 'host-authority-alpha-01',
  manifest: {bytes: 3086, hash: 'sha256:621d831f4ce9242847636bc776f90733a8134d468fb3b1917c26c26fe2351bec'},
  source: {path: 'producer-policy.mjs', bytes: 27428, hash: 'sha256:ba6a3255f18b444c791cc89093b56dc1641ed7bd93b02c89e84655210a6842e4'},
});
export const ALPHA_HOST_PREDECESSOR = freeze({directory: 'host-campaigns', bytes: 12103,
  hash: 'sha256:3c4afd0b516842a035cb46dc49af11e302ae6d7406c7e0b7db8e6c73faed90f6'});

// Fixed source-template directories. Raw final manifest identities are retained
// evidence, not literal authority embedded into the implementation they bind.
export const ALPHA_ISSUER_SOURCE = freeze({directory: 'issuer-alpha-02'});
export const ALPHA_HOST_DRIVER_SOURCE = freeze({directory: 'host-campaigns-v3'});
export const ALPHA_ISSUER_VERSION = 'webp-alpha-issuer-v2';
export const ALPHA_HOST_V2_PREDECESSOR = freeze({directory: 'host-campaigns-v2', bytes: 13866,
  hash: 'sha256:5075a164e984822f8b3e5f69c5209f3667898ad1bc2ec360ac5afec697eaca55'});
