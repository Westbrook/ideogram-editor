import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { digest, exclusiveJSON } from './common.mjs';

const EVIDENCE_FILE = 'renderer-ownership.json';
const APP_EVIDENCE_FILE = 'renderer-ownership-v2.json';
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_PROOF_BYTES = 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const BARE_HASH = /^[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (actual, expected, message) => { if (!isDeepStrictEqual(actual, expected)) throw Error(message); };
const frozen = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; };
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}

export const CANVAS2D_RENDERER_CONTRACT = frozen({ contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d',
  appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable' });
export const APP_OWNED_ALLOCATION_CONTRACT = frozen({ contract: 'application-owned-conservative-reservations-v1',
  scope: 'application-owned-conservative-reservations', resourceKeys: ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'],
  excluded: ['native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations'], globalCoverageComplete: false });

export const TEXT_RESOURCE_OWNERSHIP_CONTRACT = frozen({contract:'font-shaping-reservations-and-owned-glyphs-v1',
  scope:'font-shaping-conservative-owned-reservations', cpuKinds:['font','text','control','prompt','staging','scratch','copy'],
  textPool:'text-category-only', nativeCoverage:['font-parser','shaping-worker','bounded-wasm-heap','font-cache','prepared-output'],
  includesSharedBookkeeping:true, glyphGpu:'application-owned-software-renderer-zero', physicalAllocations:false});

/** Approval is an explicit review result, never discovered from live files.
 * Staged display code is deliberately absent. Add a review only after its
 * production source closure and sealed native renderer have been reviewed.
 *
 * Each entry is {id, sourceFiles:[{path,bytes,sha256,encoding}],
 * nativeFiles:[{role:'package'|'loader'|'wasm',path,bytes,sha256,encoding}],
 * nativeRenderer:{package,version,rasterProfile,js:{bytes,sha256},wasm:{bytes,sha256}}}.
 * All hashes use the sha256: prefix. Sources cover every src/ file and the
 * application build/entry inputs below; extra reviewed source inputs are fine.
 * An optional appAllocation is {contract:APP_OWNED_ALLOCATION_CONTRACT,
 * appBuildFiles:[{path,bytes,sha256}], runtimeInputs:[{role:'correctness-receipt',
 * path,bytes,sha256,encoding:'utf8'|'base64'}]}. These are independently reviewed
 * actual runtime receipts and the exact production build they exercised, not
 * caller declarations that tests passed. Runtime bytes are retained unchanged.
 * Review the application source/native/build closure before approving these
 * pins. Do not bind preapproval runtime to the full campaign sourceDigest:
 * adding this registry entry changes tooling, not the reviewed application.
 * The new proof still binds the full current parent executableIdentity.
 * No function accepts a caller-supplied review or replaces this registry. */
export const REVIEWED_RENDERER_OWNERSHIP = frozen([
  {
    "id": "ideogram-editor-app-8f94442c-r18-r35-app335-20261003",
    "sourceFiles": [
      {
        "path": ".progress-report/project.json",
        "bytes": 1689,
        "sha256": "sha256:fbb5739c4d01fdc4d8e53ba6c6334b87e74dad79d98cd7bab79a508019800fc2",
        "encoding": "utf8"
      },
      {
        "path": "index.html",
        "bytes": 881,
        "sha256": "sha256:2a5f972699a6c978cf2444720572542fd616f5e9741c614d1f567f44517a90a0",
        "encoding": "utf8"
      },
      {
        "path": "package-lock.json",
        "bytes": 71848,
        "sha256": "sha256:b4700ee8777c6f5f7f8f44298475b347c1c097c310259cc51617666fbf3c7333",
        "encoding": "utf8"
      },
      {
        "path": "package.json",
        "bytes": 5176,
        "sha256": "sha256:2fcb28caad63553a8aff9eaaea85d3dacdb68d5bd5006e92cbe96f2a9fb27ab6",
        "encoding": "utf8"
      },
      {
        "path": "server/static.ts",
        "bytes": 5903,
        "sha256": "sha256:a4c7634028f7ad97cfc14089a8851b28c1c4e049ffefb276be29dca82a1db00f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/profile.ts",
        "bytes": 5995,
        "sha256": "sha256:ccf144b64485a45f6188334947fbde9fa932e5bcb4ddb29a89b8de33ed13590f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/structure.ts",
        "bytes": 7417,
        "sha256": "sha256:fd16dd585940450b95e3106eb14973111cd71ea10cc8fe06c9ec50351a3b33a7",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/core.ts",
        "bytes": 23205,
        "sha256": "sha256:6fba62d8f28ecfad1469fbb4e9f29d9c64eb8e42a647452ea2abc0c155d2f5a5",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/draft.ts",
        "bytes": 4951,
        "sha256": "sha256:b544c10527e482822676ed4c5c1a06b226b5ca688835932fed454868c4b2318e",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/memory.ts",
        "bytes": 10016,
        "sha256": "sha256:f528c9ef6bd1ff53dab071d4ebcfc4cb726404f494011de27bccd31476c1e391",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/text-export.ts",
        "bytes": 9739,
        "sha256": "sha256:5c4f6491e1d6ac67f68390d5b9d2471d9753b782a5c1a883cf72fd5bca328f20",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/view.ts",
        "bytes": 506,
        "sha256": "sha256:8b784acc9948ca8a519ef415722668834ee454768cb67c1fd555013b21a7b930",
        "encoding": "utf8"
      },
      {
        "path": "src/main.ts",
        "bytes": 964,
        "sha256": "sha256:d185215040eaa0675747b0da9de615683abc0c99d0d228b9590821d668a4febb",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload-hook.ts",
        "bytes": 1214,
        "sha256": "sha256:756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload.ts",
        "bytes": 13589,
        "sha256": "sha256:77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/allocations.ts",
        "bytes": 40091,
        "sha256": "sha256:31a220cd0df3df7577212c64b5e5db3a21c16dc3c95de99f77721c4c6e77ac06",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser-worker-observations.ts",
        "bytes": 3117,
        "sha256": "sha256:00cd9c0b7e19f8a72878d92d31dd79b3578a49df24023b25b2acb343bb8300d2",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser.ts",
        "bytes": 21101,
        "sha256": "sha256:bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/composition-observations.ts",
        "bytes": 16019,
        "sha256": "sha256:966cf50aea8c77470a0dad9ffc08accf03ae974f99bb05292b1cefe23de93cfc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/diagnostic-memory.ts",
        "bytes": 7157,
        "sha256": "sha256:1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-control.ts",
        "bytes": 1647,
        "sha256": "sha256:455f5f15d48cac494525de9817ee685db8f476a4161e9887c10eca7f26b8f0a4",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-preview.ts",
        "bytes": 20859,
        "sha256": "sha256:938f3ea3c85c2eb491b4629c4840d107f0d60e2ffe7ed5315b4b5c2414231b8e",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-scheduler.ts",
        "bytes": 2969,
        "sha256": "sha256:0a41dc42a8fb9e17efd36d53a3c4f54fd79944473300e11c7349859bb6d2efae",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/model-memory.ts",
        "bytes": 5243,
        "sha256": "sha256:79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/navigation-observations.ts",
        "bytes": 5156,
        "sha256": "sha256:ddcbdfec01b890238fde7a9d33f4843661264aa375a8d3660e4608a239c58490",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/owned-preview.ts",
        "bytes": 5274,
        "sha256": "sha256:0bd894009708bf330aea1c7d217a1e1a0ee5e20aa8b474a366f6a8f0987ea762",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/phases.ts",
        "bytes": 10214,
        "sha256": "sha256:b50dcdadc22f9fbdbbbf6a19d9f453b60a5af94a3dfc17da9990503a81bb265b",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/prompt-memory.ts",
        "bytes": 6877,
        "sha256": "sha256:65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/recovery-memory.ts",
        "bytes": 6093,
        "sha256": "sha256:52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/adapters.ts",
        "bytes": 10834,
        "sha256": "sha256:49cff659b62eeb5ba4df9c21ba589aba60bb42a887734523edcf255db42bf51d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/asset-projection.ts",
        "bytes": 1312,
        "sha256": "sha256:49db7085d8cb0626cd22dba2b87f585b867be8ba6cb101efecbfe54187cd0931",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/assets.ts",
        "bytes": 2837,
        "sha256": "sha256:4e80ddb80e6244f8c30cec7272185fa6548a3ac2c0f5a5172d93cd5684130724",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidate-placement-review.ts",
        "bytes": 6833,
        "sha256": "sha256:dcca33d598d7de3dc6732cfbab57c9104e5f783c9f7c7fb60542bcc2dac5dbfc",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidates.ts",
        "bytes": 4080,
        "sha256": "sha256:3452fe398348f40a1c321931ad013b1c4147ccd898c4c976f9e763ce34d5b91c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/deletion.ts",
        "bytes": 893,
        "sha256": "sha256:8eaf9365f73bc56022476de004b4411a76176645029202407dc5baa3a96e3557",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/display.ts",
        "bytes": 2630,
        "sha256": "sha256:28c738c8080ff9765f937b5a312f58be8785c610b9c52a306addf53823963f5e",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/document-creation.ts",
        "bytes": 2150,
        "sha256": "sha256:d281fd9fe57717bde67c4db75026972090c3b36ac16119682fc073b648b4c311",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/encoded-rebuild.ts",
        "bytes": 6540,
        "sha256": "sha256:d6abc810868df34b1cf4aa495baed7d11e255b37c0075e2c25e93f426f839f32",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/export.ts",
        "bytes": 1750,
        "sha256": "sha256:bea072e2d3a6ff5cdc0308da33daca529a40ba4ffcc285570543622e2c9a5b5f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history-validation.ts",
        "bytes": 8071,
        "sha256": "sha256:110fb9cfeb47182bf48d4959e51b987488d2a230ffc801dbab84b1bbff9659e7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history.ts",
        "bytes": 8792,
        "sha256": "sha256:c31f9c89237f6f1d40b1068b3fc447a3853a0d6fd478b8f0b652538b4dceaeb7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/json.ts",
        "bytes": 4337,
        "sha256": "sha256:2c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/portable.ts",
        "bytes": 3500,
        "sha256": "sha256:c3788b41d0ab977590f0a22df0f533b364384c57b8dbec2ae76529c7548fb6fd",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/projection-schema.ts",
        "bytes": 3544,
        "sha256": "sha256:f6d7e8de3b2e7636335fcf87936fe3ec91d1a6fd52f4f11721754c4a7a53ab1a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/provider.ts",
        "bytes": 2379,
        "sha256": "sha256:48a05e2bd47d9afc606aa608d1ab96268dca74d52beb39cf347f95d15907c296",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue-events.ts",
        "bytes": 305,
        "sha256": "sha256:cdc923af08d68ce5bd260a2128a92c91dfbb75f2e3dcd593bceee8e22108e545",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue.ts",
        "bytes": 4678,
        "sha256": "sha256:7e29a16bdd3459d70611eb44f7f9813e4a06b87b8b64cb95c3ab9a2141012282",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster-import.ts",
        "bytes": 8151,
        "sha256": "sha256:e6216dc80bbc31a66a559a1d13adfae6580a4f8899ad60332ac447787ac7c86d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster.ts",
        "bytes": 2620,
        "sha256": "sha256:4908943e55c50e8ce5af54f9d86de9b5faec800e28de39a69d8c5c25317f7b86",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/recovery.ts",
        "bytes": 2964,
        "sha256": "sha256:7fc1be8bf95007250a6fb6942c999170c88460f02db56cf01450d393dc4c7f7c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/request-edits.ts",
        "bytes": 1980,
        "sha256": "sha256:5eef93ccfc9f3ac930301ba13ca2779b5ce3b3f3e14e06901d28cd263fc9453f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/session.ts",
        "bytes": 1646,
        "sha256": "sha256:2e3f10e47615fdfee3edaca39f8f7ccfa86635094de4a9f787d45c28f26e1ad4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/sha256.ts",
        "bytes": 2672,
        "sha256": "sha256:6125bfb8366910293774bd3efb05edcbc8f37fddd3642d6c43a7921ed0e73684",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage-repair.ts",
        "bytes": 3715,
        "sha256": "sha256:d07414e14b3cfb5f0648a79ee02058b2639cb4bf21066a0f212857a10ed6582c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage.ts",
        "bytes": 9085,
        "sha256": "sha256:9fe7a525099ab25fb12a0ba4aa7e1655fc24ca50eceaa96bf8c3f0a4aad15df4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/store.ts",
        "bytes": 3628,
        "sha256": "sha256:f8fd2bdee1da82c4c8f4bbde51c50f186ac06b40da079330f76511ad5863930a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text-budget.ts",
        "bytes": 5405,
        "sha256": "sha256:cca773c4442c8a1ec218c11c2344ff8e2811067ee8b10e48fae1c0aba85db590",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text.ts",
        "bytes": 11601,
        "sha256": "sha256:cee1e8e4a1cf2053ba0d14a58f6ea4200ff5bce36da657fa54ab34b342472abe",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/ui.ts",
        "bytes": 2104,
        "sha256": "sha256:bfbb2b10abfef1ea423751dba691e185ded9618d944ca0614846e23c8039c8d5",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/v45-inputs.ts",
        "bytes": 5738,
        "sha256": "sha256:e72fae2dbdaed62bf64588db0cbeda80e3971a805a5a10914ca8cddb6e6fa84b",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/validate.ts",
        "bytes": 33128,
        "sha256": "sha256:e330cf3ebcfb4ad3482d642ff029b3b6b07c0a319f782bced20621a21f777e38",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/core.ts",
        "bytes": 8804,
        "sha256": "sha256:d8de114ca50149e77c02c5cb5fa5b17b38f2d56cc6933db85a19242c6cd168b3",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mapping.ts",
        "bytes": 1899,
        "sha256": "sha256:b642fac2ac9a0864bb1d4deaef4a31243c5ad1e21adc26aaeeab158c50f87156",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mask.ts",
        "bytes": 9339,
        "sha256": "sha256:7b1fa5636a925c7b6845002a2c862cf3a2c30efbc534cec66baba2f7f7d5e47c",
        "encoding": "utf8"
      },
      {
        "path": "src/request/core.ts",
        "bytes": 29030,
        "sha256": "sha256:1047aa48fe5d1e7d2af795aa3b05f1b27a8a15c1f987e8b2e582557d6a61deb9",
        "encoding": "utf8"
      },
      {
        "path": "src/request/family.ts",
        "bytes": 9739,
        "sha256": "sha256:77f824dcba1464784d6c39ca3e05fd78a9d9c18e6be0657344ae672a0b38b4e0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/raster-plan.ts",
        "bytes": 26419,
        "sha256": "sha256:3b1b7cbbbae5b42907614d8b05d623653cc44454e92b679696310f0e471a50dc",
        "encoding": "utf8"
      },
      {
        "path": "src/request/review.ts",
        "bytes": 6237,
        "sha256": "sha256:7dfc05b8eee3d434b94ba74177c465855563afc2f1c371c8e6dcfd57b1837bb0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/text-treatment.ts",
        "bytes": 45353,
        "sha256": "sha256:2ab56b85fb685b72a0218b8d00110aab19d32c5a67e572bdb65914c85c52de9d",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-edit.ts",
        "bytes": 15680,
        "sha256": "sha256:fae51b0499780c5fae51d540e822a7871768a32d689f11b13b2be2c1d2f608f5",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-family-edit.ts",
        "bytes": 11475,
        "sha256": "sha256:d971b8173a06ef55dead0e084dd8daa0fbf1154e04fba692fe8d3803c4b97c44",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-prompt.ts",
        "bytes": 1619,
        "sha256": "sha256:bb584866ec006afcabb9081ad39c50f59470a832a330803b8b745f5bfa4c3452",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-stages.ts",
        "bytes": 1622,
        "sha256": "sha256:f2b093d6b930ce1b191051fce4e362916f98d6033d7d7cd437e09f1b5724fdd2",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45.ts",
        "bytes": 8473,
        "sha256": "sha256:d7cc0c18f7b8c8cda92beadc89f78aeceee13c015b62c75d869c39f2ecc56bf8",
        "encoding": "utf8"
      },
      {
        "path": "src/state/browser-journal.ts",
        "bytes": 4709,
        "sha256": "sha256:e6b6a51bb724608f1ccffe5c6ccbfe277e9d7b366e9523be00f73f6bc334011e",
        "encoding": "utf8"
      },
      {
        "path": "src/state/command-results.ts",
        "bytes": 15408,
        "sha256": "sha256:b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b",
        "encoding": "utf8"
      },
      {
        "path": "src/state/control-memory.ts",
        "bytes": 3960,
        "sha256": "sha256:80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75",
        "encoding": "utf8"
      },
      {
        "path": "src/state/destination.ts",
        "bytes": 22122,
        "sha256": "sha256:d1c6644511370e65f549ec04b0a392d2b2f60a35dee1deb2d2e568b0fe454222",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-lifecycle.ts",
        "bytes": 1760,
        "sha256": "sha256:1cfc86cc3a7f5bca57bbe531ec5cb99d47b3bc99c90a283df2aeb62cc79f0fed",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-list.ts",
        "bytes": 2443,
        "sha256": "sha256:71d02b4df1df808913e57db74a23e797038a0292e9749879cfb29f01675aec57",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-persistence.ts",
        "bytes": 21470,
        "sha256": "sha256:677621bcddf8c2edebd9ba703552db3d3e41062a38e22e050dd7c0fd09060bdd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-values.ts",
        "bytes": 11215,
        "sha256": "sha256:9c8c592ed3d3374728d33cb8b6bd274a96f5b21c4d929f09c30657c32cb295d1",
        "encoding": "utf8"
      },
      {
        "path": "src/state/editor-client.ts",
        "bytes": 127262,
        "sha256": "sha256:da4f0b401496715287ca10832a227bc753e2a460dceae5993ae6e1469e7609a1",
        "encoding": "utf8"
      },
      {
        "path": "src/state/export-options.ts",
        "bytes": 2632,
        "sha256": "sha256:9e4064cb4d4b37c8e0173d6c4020e6bf8a05aa8e999571f32e801ac9bb72f1f3",
        "encoding": "utf8"
      },
      {
        "path": "src/state/history-availability.ts",
        "bytes": 1318,
        "sha256": "sha256:51b1c63b3959a18fccfef51662cd974a01eb3ee52070f6a5eedbcc4eff671e5d",
        "encoding": "utf8"
      },
      {
        "path": "src/state/idb-ownership.ts",
        "bytes": 7990,
        "sha256": "sha256:bad165b4193384168a9f0cca3f265796c8389885a5fc1446351dc1452b981291",
        "encoding": "utf8"
      },
      {
        "path": "src/state/keyboard-preferences.ts",
        "bytes": 544,
        "sha256": "sha256:64e4db9f76cce85cf501fb0da6f670df94e70bd8ddda25b7771729c75059dd01",
        "encoding": "utf8"
      },
      {
        "path": "src/state/projection.ts",
        "bytes": 2058,
        "sha256": "sha256:9cf86f8a121bcef8b07879405d5989189df615684b46aa64185da9e0cb0b63f5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/queued-replacement-fence.ts",
        "bytes": 3345,
        "sha256": "sha256:d401f3df1f7b6b92990c52dc0492e48046fea53a46e18ed11ad8607a05f3f5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-cache.ts",
        "bytes": 8215,
        "sha256": "sha256:6171ea3ac2b90d73c7bb7e80963fd272a625f678aea2aed75b3de64aa7dd825f",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-client.ts",
        "bytes": 24263,
        "sha256": "sha256:faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/session-client.ts",
        "bytes": 10034,
        "sha256": "sha256:7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a",
        "encoding": "utf8"
      },
      {
        "path": "src/state/view-models.ts",
        "bytes": 14498,
        "sha256": "sha256:027400635ced364c8138e61e806b6c8ce00ea1b9649489e93a53d7567c08ab13",
        "encoding": "utf8"
      },
      {
        "path": "src/text/admission.ts",
        "bytes": 4357,
        "sha256": "sha256:be0ae31c17e9d0497a27a49d0b15f1be7672c20c5752e8423ad71f0f06fc5e1a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi-data.json",
        "bytes": 19070,
        "sha256": "sha256:df36e677252814e1d84009c9ab735c12ac67deb7460695d64b477beee00b955a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi.ts",
        "bytes": 632,
        "sha256": "sha256:9fbc954b46188247d44c829ce82bba259de40dbcbb0100380c43aa8e7b961350",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bundled-fonts.ts",
        "bytes": 1857,
        "sha256": "sha256:14772cc968adf2512319ee2be18062db6b8ab32a591e1c0bdc3efe0305494c84",
        "encoding": "utf8"
      },
      {
        "path": "src/text/client.ts",
        "bytes": 10443,
        "sha256": "sha256:797c8a655b93bc9991b33d9f11c8ab694f868ea7a5c83625f6a1e5472ed297d4",
        "encoding": "utf8"
      },
      {
        "path": "src/text/contracts.ts",
        "bytes": 9434,
        "sha256": "sha256:08207c5aab6d234ac693fda1d8a0e4f3542bf446d67fc0b8370a5d8b9b024ca3",
        "encoding": "utf8"
      },
      {
        "path": "src/text/core.ts",
        "bytes": 20578,
        "sha256": "sha256:ba210ea0538daab09ded2d4013b1e5eb4948c47cf935afcdc6acd0ef707a7003",
        "encoding": "utf8"
      },
      {
        "path": "src/text/durable.ts",
        "bytes": 9424,
        "sha256": "sha256:6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52",
        "encoding": "utf8"
      },
      {
        "path": "src/text/engine.ts",
        "bytes": 1476,
        "sha256": "sha256:c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830",
        "encoding": "utf8"
      },
      {
        "path": "src/text/font.ts",
        "bytes": 4272,
        "sha256": "sha256:76a715d1e84212ae66dcbe34c55ae8a879e473bfea299987018a7d7bd9380b01",
        "encoding": "utf8"
      },
      {
        "path": "src/text/layout-writer.ts",
        "bytes": 5701,
        "sha256": "sha256:2edb8376e51f8988af0dbb3fdce5789b0c22a2d236835e5e651ca918255477ea",
        "encoding": "utf8"
      },
      {
        "path": "src/text/memory.ts",
        "bytes": 8104,
        "sha256": "sha256:7c2e1c7a90f053ee6ce26898bded8988bcfdc8c7e2abc8086170bc0d9cf81c7b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/profile.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/1c399d52.json",
        "bytes": 18008,
        "sha256": "sha256:140b72169cfae3e5fe727f58a0395b3a21ec7da6cf36283e87c9320a6a6c6ee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/2e9362c1.json",
        "bytes": 18885,
        "sha256": "sha256:acd1585535b30b39843af8615e2a40f95291b178a167e40535bea16528918427",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/304528c9.json",
        "bytes": 15748,
        "sha256": "sha256:13f8dc3e3cbe8b7f572b2c624068a7cbdf683a04bb91a3de87a021621e030033",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/4fd6f6a1.json",
        "bytes": 16958,
        "sha256": "sha256:3b5159888dd22ea25a4a660bc36f788e13eb526db558bb72e6bab44aedee7dcd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/68efa85f.json",
        "bytes": 17134,
        "sha256": "sha256:ea257991e81f2a1ebe4f2c3172c6071628b1a30b4230a5ec7c9b92d35db6c99e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6d77f925.json",
        "bytes": 17478,
        "sha256": "sha256:a00135bd564fa7926b97752024a1a00ec7c23ba520f4aecca63b74ad1cd2e599",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6e8a481e.json",
        "bytes": 15396,
        "sha256": "sha256:15634d19418bc21841fa8093de2ae7598b752c2f158be90f6e7e06216d79d6da",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6f7be5be.json",
        "bytes": 19214,
        "sha256": "sha256:c631086528d51d967a6a692777ff8fd5004ddf410e47b003f3ef7cbd0311a4bf",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/7a4dbc6c.json",
        "bytes": 16782,
        "sha256": "sha256:808650b42cc817012dd5d68df0124171ac78679ce497acd6a6c031409886052d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/891a4688.json",
        "bytes": 18360,
        "sha256": "sha256:f7c063fd77161f6be59b2a20559ddfda42e4bf8fcd2d04297d7321d324232a17",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/95244362.json",
        "bytes": 19390,
        "sha256": "sha256:96403bc29e02fc5e5162a6dbff1ef1387f2d892df9021b74efc2b625f5dd515e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b89503d3.json",
        "bytes": 14238,
        "sha256": "sha256:39b0190db275a08547f01494eb3f2725cdb7d2d3cb7a8e92abe42bbae6c5dee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b96236b0.json",
        "bytes": 18536,
        "sha256": "sha256:0c2857d4033926a7db23957fd3bf002929aa33a201e059626a9f8f286227d288",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c19791ae.json",
        "bytes": 12986,
        "sha256": "sha256:80d5dfb1f0f89548969c97348b57d0ddc6e8098f719de97dfb9feb9839734d2b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c6ca02c2.json",
        "bytes": 17655,
        "sha256": "sha256:d3ef40a7cbf8b4119627dc2f4ce1a11cb1bb1c9eedfb6b9d8321e04afeb249dd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/d047f5be.json",
        "bytes": 15572,
        "sha256": "sha256:d2cd5204fa8822a0ae17f610ada9add6b083ab90097d16b14397193522f54b1e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/e648eede.json",
        "bytes": 18184,
        "sha256": "sha256:1015d4832862ab35edb4fe9010d129d88a8d2fe4d1cefae4ffbe63054e62a6e5",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/f5e8bd34.json",
        "bytes": 16101,
        "sha256": "sha256:2b874883288b0e197153220b4e44ff1dcb751d34c164a3f558668b40733e7d3b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/ff24a513.json",
        "bytes": 15924,
        "sha256": "sha256:82bbff0efe60f4633875efe51917e9526464a2ddc54ab28c2dc048d44267ef36",
        "encoding": "utf8"
      },
      {
        "path": "src/text/returned-description.ts",
        "bytes": 9029,
        "sha256": "sha256:4c20cc4152f1c6777d73a92623cd2d8f0467dd9660f2a13d1ef7e189333e8c40",
        "encoding": "utf8"
      },
      {
        "path": "src/text/split.ts",
        "bytes": 3841,
        "sha256": "sha256:19b7c1b5a41f920f51d163e2cc3d2ecbf05459471554b36f001aee171016590d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/worker.ts",
        "bytes": 2089,
        "sha256": "sha256:7f60b4d87d0557bbe79e3472d643c6fb233ddbfe4923e7738e823fde86fe38be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/appearance.ts",
        "bytes": 676,
        "sha256": "sha256:c35f3badddd70240e30ee8198e7353f0dbb4c9020afcda9380b6e23f7996d787",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/density.ts",
        "bytes": 1236,
        "sha256": "sha256:26cf58af3eb0a582f4b51397ecd18bf5bcdc3f83176a410728e440be5525950b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/shell.css",
        "bytes": 28285,
        "sha256": "sha256:5e0187129b25eb5b6d415b474ef18a909856b0b7fb80af0883df3d63b0cc7d90",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.companion.css",
        "bytes": 27494,
        "sha256": "sha256:58c83bba8e5560b838a1b822ada08adab200be353ce7ba45be6756fcd88e45be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.css",
        "bytes": 49741,
        "sha256": "sha256:ca1216ca1efc6dd6c99be79b94a366f95939f593bb13eeec73fd5b0b84e6444b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.companion.css",
        "bytes": 58517,
        "sha256": "sha256:83d713adb38f1114fa4f18c38e3882c81240df56ddb42142f95e914c51e3565b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.css",
        "bytes": 99593,
        "sha256": "sha256:0f9d2b4d8a0cc498e73b29dcda5c3990b973d028f4cab58055dc4c953a76284c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapter-library.ts",
        "bytes": 54986,
        "sha256": "sha256:2d74226de4868f840641a453d874cead9a35e432b23471d6b3d7e282ee595d80",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapters.ts",
        "bytes": 1338,
        "sha256": "sha256:8a3a2476552dba3e8bd33b6d1bbc35e7b6663472e92cbe7999e5409f105b7514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/authoring.ts",
        "bytes": 65513,
        "sha256": "sha256:96eee099eb24452775f166b7c604ac9d46f23ebd2f7c53a2d686045b563d5b53",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.css",
        "bytes": 1614,
        "sha256": "sha256:acea87503cdcb9135eda4c9dccd532596ca05810d10b5b6fd5b4d78ee8f5384e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.ts",
        "bytes": 12975,
        "sha256": "sha256:7343f2ac9a0e23d7acdd76a5c13be86113ce319f97d529b3a0f5ac2ab6fcee9c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-selection.ts",
        "bytes": 1972,
        "sha256": "sha256:77450803a9a542d5eff9518c42bd219a3881162f5499654082233fccddfa4136",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-text-treatment.ts",
        "bytes": 22157,
        "sha256": "sha256:298b25ec1aca29a179432a34d617d7a0cd900a9dfe1879cab08adaba00671125",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/canvas-view.ts",
        "bytes": 23346,
        "sha256": "sha256:69e5d914e0b783e0e1bd39a9570cd0f840ee287a8b7b261e3a4df08759fd04db",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/command-search.ts",
        "bytes": 11251,
        "sha256": "sha256:105d950b9cc16e35f70a4482ced6183d3599ee9ab6ba7e38be72158e0dd543ec",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-view.ts",
        "bytes": 8320,
        "sha256": "sha256:f692decf866069b8cb09101b18dc28512d97e32ddf7b06513b9261fa2ac665c3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-viewport.ts",
        "bytes": 2313,
        "sha256": "sha256:66881c5d3b8a7db109d47f75aae2d46130912f9adfddc37d9f5a08513d17cdf9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition-lifetime.ts",
        "bytes": 3633,
        "sha256": "sha256:2d33911edae29aace3d0e28fbd3b3037408c5d07fb15e357bbeee6499ff1438a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition.ts",
        "bytes": 72688,
        "sha256": "sha256:78b3938609555f581fecca318b16f06f9a384c9ed62791996b6214badf877f80",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/deletion.ts",
        "bytes": 16953,
        "sha256": "sha256:46836f9fbcf8eef5d5e10797f1d42afc751094823a17c9029a7a778e5c1ea25d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/dialog-ownership.ts",
        "bytes": 3550,
        "sha256": "sha256:2d73cd25c25542b1a07ca870431e92831bbbe8ef9d9e825f4bea02ae028a6101",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-image.ts",
        "bytes": 2275,
        "sha256": "sha256:5a4f4b2206f8c79cc1e3804d3756760f073a1e24d9d34774a6e1988961af6eea",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-tiles.ts",
        "bytes": 21376,
        "sha256": "sha256:1227c3d78426138eca9f99d174b5b55f1866db45963a7fed75f9bccb48033092",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/editor-panels.ts",
        "bytes": 222,
        "sha256": "sha256:317eb7d341385707685a0051b0a0f845106b90216415d784ba37147775633b29",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export-memory.ts",
        "bytes": 4385,
        "sha256": "sha256:2f64b75340851239a90d8b5baad68b7f1f48171bfa42d04d087385eda6207330",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export.ts",
        "bytes": 29218,
        "sha256": "sha256:cfde6a3159485b3436f80571839fa7235109f5239baf38488812a42331bb175f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/font-relink.ts",
        "bytes": 795,
        "sha256": "sha256:f01c60678b5c2228b310b3b381d0fd4fed163ca255e1d03ed73c939f72760a89",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/icons.ts",
        "bytes": 1127,
        "sha256": "sha256:71ce0b0bf30ad2ead51133eb6cfd6d2866f05c6af3ba656fdae8f0ab91eff6f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/image-import.ts",
        "bytes": 39682,
        "sha256": "sha256:967bce89ddcba2922730a0ac1be42df2dd4880bd04d3886238cc4f9b692c7584",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-model.ts",
        "bytes": 6018,
        "sha256": "sha256:e90972c20a71cecbc1e48fc9f66aaa8da5293fa636ac510a008e300dd226969f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-transform.ts",
        "bytes": 3730,
        "sha256": "sha256:5deb71bb46fd6b2b9cc72b22b230772049d560007701d8eb2b7ed4e426c92c9d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/keyboard-scope.ts",
        "bytes": 2505,
        "sha256": "sha256:e2f4a3c60a4939ea34aeae97b2fd14310cb97d8d00586c0d3cf72abe6cf079cd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/model-owner.ts",
        "bytes": 5793,
        "sha256": "sha256:b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-control-memory.ts",
        "bytes": 3643,
        "sha256": "sha256:b8b811e36e6b73f27d01a2a412a657010809f7f8a43923c6bfb02b9a458d18b3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text-preview.ts",
        "bytes": 1165,
        "sha256": "sha256:9d22637412b77397f650608d1494ccab5367015ca61ed2d70464ca26475c65d9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text.ts",
        "bytes": 107073,
        "sha256": "sha256:2cf4f6d756cda567a9b8eb801d1ac0d493e01a1af6f1b06ea75d37d4c2ca777a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/new-document.ts",
        "bytes": 13476,
        "sha256": "sha256:d1ea4f98e67bacfd65fc1f1003e2dff920653c6436edf7377a5f778185989419",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider-payload.ts",
        "bytes": 4230,
        "sha256": "sha256:a100964fd08b21515369099dc3fafa851f209177e7826c1dd25d12f930044368",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider.ts",
        "bytes": 19559,
        "sha256": "sha256:cbf18fa6031136a1f802c9a12a8a259389831cd488b3c75d00aca7542cfc8f17",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/render-models.ts",
        "bytes": 1966,
        "sha256": "sha256:2623824d32f272039dae67ec047622079f4e25c4f01954494ee361b6ae78b9f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-composition-text.ts",
        "bytes": 7915,
        "sha256": "sha256:7d06fbadfddea5bd716d8496362b780d38598885806047e145cad42d28e4da6d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edit-models.ts",
        "bytes": 8234,
        "sha256": "sha256:5c6c04aac0972f4c67dd5b3f16aabcb510ce4a64da83af410aca58b9cc479514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.css",
        "bytes": 1715,
        "sha256": "sha256:37bdaea25e0c49f5ae97136d852e2623099b942ee6fdeccfbc09e3c59668b73a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.ts",
        "bytes": 137286,
        "sha256": "sha256:542adfbc5157a48328f4d24066ebf9abf9e498755243a2a4f4b1d3710e92f35c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-entry-memory.ts",
        "bytes": 2129,
        "sha256": "sha256:830a6cba622d2d11486590e2cd478095f9ad9334b8182d83a23cb96e78d196bd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-mask-memory.ts",
        "bytes": 4243,
        "sha256": "sha256:a81f870a76006531b2e769203921925263a2e09241ec3fc7bbbd4e24702720fd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-navigation-memory.ts",
        "bytes": 10321,
        "sha256": "sha256:c3d51c297dc391edfd41d683dab4bb5b82352d253e49af5d3d8c85a84311dbaa",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-prompt-memory.ts",
        "bytes": 9994,
        "sha256": "sha256:32aac1783ba960cd5085af75280d9af8a86035d597b45719e98b8447c7650d1b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-edit.ts",
        "bytes": 25042,
        "sha256": "sha256:e9d0ea843bfdd5ffcdbe9e822bf9fee6fdfdaf955e34acbe3d4cce1cdf9c0e75",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-memory.ts",
        "bytes": 3821,
        "sha256": "sha256:b4a8851853e00ce39c1c2f8770d92c916150299e4c8e5577dd3eed2288e2948c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45.ts",
        "bytes": 6428,
        "sha256": "sha256:242a196022be95eb18486fd22411aeee42f6ac494dbbccb6d449f69a14cac5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request.ts",
        "bytes": 141295,
        "sha256": "sha256:c5bd629ecc132b216d6b77485b53a3f95c52c9c2a6ca320ae79ed6c9b47dae52",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/returned-description.ts",
        "bytes": 11135,
        "sha256": "sha256:661db3b3aa1ca2f21eeb8a857d66f3fbc99ba3b356503735cc22d28f35c62fc6",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell-wordmark.ts",
        "bytes": 346,
        "sha256": "sha256:0dfcfe84e68da30bf6a0d66bb4159ef197ae718638989f7716009c66ad1b8aad",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell.ts",
        "bytes": 143021,
        "sha256": "sha256:38cc90f8d3ebe1c8c33574d6d45161c716bb315db9bb646a69878f141571291e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/storage-library.ts",
        "bytes": 26895,
        "sha256": "sha256:d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-library.ts",
        "bytes": 8785,
        "sha256": "sha256:e8906796f9508e7de560754ed9e44a17cd11009ca13c1b7e3850d053248dcf50",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-treatment.ts",
        "bytes": 35667,
        "sha256": "sha256:d43659f80639eadf89a4acebc4285d15cc095f8b5011b4fb5fdc03e88f86b7d3",
        "encoding": "utf8"
      },
      {
        "path": "tooling/build-evidence.ts",
        "bytes": 20934,
        "sha256": "sha256:483a863f126ff181d94897b3ca5defcbe00ff7104584bfbd8fa42478e54070c7",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/README.txt",
        "bytes": 2039,
        "sha256": "sha256:59d6581f2edc979d0629d088a13c6b4752fcfcf37904df54cec50b16a5cf8255",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.generated.json",
        "bytes": 2017,
        "sha256": "sha256:571457b38a697b09191224d87a72bfd52c7328fff19c2dadb5c9722f5659fe27",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.mjs",
        "bytes": 2585,
        "sha256": "sha256:21e8e47b0ab53f49111824eeef296bc78e09fa85b5d23b8aad8d0e3ee11a2198",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum-source.mjs",
        "bytes": 2195,
        "sha256": "sha256:a45376271626e5b7e9c0d6a296ec7a0d3d4d17d5b7aca98984ab06df6bfdb149",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum.mjs",
        "bytes": 1563,
        "sha256": "sha256:e93a08d41a58da0ebdb78039228412f770eca8a7d50d419b6b4269a6cea4c91f",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.app.json",
        "bytes": 349,
        "sha256": "sha256:1d7a7d0c87b2b0f55f4de437d8e014e0e840cde5d51c42feda80d6f98063db38",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.json",
        "bytes": 394,
        "sha256": "sha256:a65cb3aa05b5e70e54442976cd3b96b21671ebac5c4c5d5cb9ea295cd29cc044",
        "encoding": "utf8"
      },
      {
        "path": "vendor/text/manifest.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "vite.app.config.ts",
        "bytes": 554,
        "sha256": "sha256:ba4874b23f6f789ac56db7916bb0d0b1304bf3d2ff7c9a00bb0b4f298fe6c024",
        "encoding": "utf8"
      }
    ],
    "nativeFiles": [
      {
        "role": "package",
        "path": "node_modules/canvaskit-wasm/package.json",
        "bytes": 270,
        "sha256": "sha256:30863ad6290d1702ff4ef01dcf1f85aaa4f29e5bde0d0fb5ed8ee0666758bf2e",
        "encoding": "utf8"
      },
      {
        "role": "loader",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.js",
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f",
        "encoding": "utf8"
      },
      {
        "role": "wasm",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.wasm",
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19",
        "encoding": "base64"
      }
    ],
    "nativeRenderer": {
      "package": "canvaskit-wasm",
      "version": "0.40.0-ideogram.3",
      "rasterProfile": "ck040-custom3-cpu-rgba8888-unpremul-srgb-transparent-zero-1",
      "js": {
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f"
      },
      "wasm": {
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
      }
    },
    "appAllocation": {
      "contract": APP_OWNED_ALLOCATION_CONTRACT,
      "textResources": TEXT_RESOURCE_OWNERSHIP_CONTRACT,
      "appBuildFiles": [
        {
          "path": "dist/app/.vite/manifest.json",
          "bytes": 5530,
          "sha256": "sha256:af6217537431cd591e7a094e850f2d5444cae3b1d8c1c2ad15f306f335f0811a"
        },
        {
          "path": "dist/app/assets/NotoSans-Regular-Dpf_lrdO.ttf",
          "bytes": 569208,
          "sha256": "sha256:b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5"
        },
        {
          "path": "dist/app/assets/NotoSansArabic-Regular-CEibNoL-.ttf",
          "bytes": 240456,
          "sha256": "sha256:ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b"
        },
        {
          "path": "dist/app/assets/NotoSansCJKsc-Regular-DxgKpThH.otf",
          "bytes": 16437364,
          "sha256": "sha256:2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"
        },
        {
          "path": "dist/app/assets/NotoSansSymbols2-Regular-Dcz4cXYm.ttf",
          "bytes": 656852,
          "sha256": "sha256:630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6"
        },
        {
          "path": "dist/app/assets/adapter-upload-ZJUl3sV6.js",
          "bytes": 7945,
          "sha256": "sha256:d770fe65afcc4272804ae9f68fbb859b0dfc6676a81f7419e14d803856e622cb"
        },
        {
          "path": "dist/app/assets/adapter-upload-hook-CZQz_zNG.js",
          "bytes": 148,
          "sha256": "sha256:9167561d48d065cd38224808ab8b4f74db38565eb546e2aed8a6081961fba99b"
        },
        {
          "path": "dist/app/assets/adapters-CoFyKvlB.js",
          "bytes": 568,
          "sha256": "sha256:6bfc66dea0b20c87dd428e790c5a438e1e38817ee7d1aa682b195418f763beb6"
        },
        {
          "path": "dist/app/assets/browser-BlAjsNLe.js",
          "bytes": 22209,
          "sha256": "sha256:423aa3fd78b26420d404903f3620a9397ef49e7672ff5440c513cbcac5f96e9c"
        },
        {
          "path": "dist/app/assets/canvaskit-B2Vb3rWN.wasm",
          "bytes": 4979358,
          "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
        },
        {
          "path": "dist/app/assets/control-memory-Eee2cnCW.js",
          "bytes": 2239,
          "sha256": "sha256:8a58feb1339afe21b4d6018fbe5058f7db4e535a13a1208a9a119f312f6d3677"
        },
        {
          "path": "dist/app/assets/density-b6s3w18k.js",
          "bytes": 917,
          "sha256": "sha256:9660db15fb7713a9dda7b12697cbe194054453f7c7256a8c1508a46fb7733046"
        },
        {
          "path": "dist/app/assets/display-image-BXlXvtE1.js",
          "bytes": 111081,
          "sha256": "sha256:027a854cc755ec72c5e83533396e35da45b3ab1ffea7bdac94fe3499f6532d8e"
        },
        {
          "path": "dist/app/assets/editor-panels-Uvj1nNX6.js",
          "bytes": 9441,
          "sha256": "sha256:108c31fe7c71e64b407c398c82ffc7333afce7e8b9dd5e525091abe7aac22733"
        },
        {
          "path": "dist/app/assets/export-B6GlwDVw.js",
          "bytes": 24691,
          "sha256": "sha256:c0ae962eb24d2cec57abf704f09669333ba63f6bcd79eb9a2eb70c5b28f06d4b"
        },
        {
          "path": "dist/app/assets/icon-bM7BnQq1.js",
          "bytes": 122573,
          "sha256": "sha256:8c3b0c399c780b8bfd9336d3643669e3a11b3a01740fd70211e8d4519486a597"
        },
        {
          "path": "dist/app/assets/image-import-CzkouyFB.js",
          "bytes": 28815,
          "sha256": "sha256:d2a6913c7e56d48e25484baa36861f7896cea9f7e458884fb08b36ecaec0bf5d"
        },
        {
          "path": "dist/app/assets/index-Dq5DRTU3.js",
          "bytes": 1860,
          "sha256": "sha256:7f8396c206063280aa943b560888770b2ab48b071784c68c8a295f8406ca376f"
        },
        {
          "path": "dist/app/assets/index-W-r-eRIr.css",
          "bytes": 301468,
          "sha256": "sha256:80803d3fb97275ebbbf6098e703144cd64ed0c35d7d1feef36aeddbd1ed8a6a8"
        },
        {
          "path": "dist/app/assets/lit-tfDubpWu.js",
          "bytes": 15020,
          "sha256": "sha256:2aa46cc767b30e74b9f957c198780472518bb82cdb1d634b10ab5a575aff9e3d"
        },
        {
          "path": "dist/app/assets/model-memory-CTO-q7Az.js",
          "bytes": 40902,
          "sha256": "sha256:830aaec073215e4b9c739eaef66abed77805f7e177bdeeaebb1e8284daa8b555"
        },
        {
          "path": "dist/app/assets/model-owner-7fizWpfl.js",
          "bytes": 3438,
          "sha256": "sha256:4e1c3239a43214f0ae5b545ed74f4439a69794717235fae815eba400b6c6c4f3"
        },
        {
          "path": "dist/app/assets/preload-helper-BZ1Pz5am.js",
          "bytes": 1218,
          "sha256": "sha256:8820987e6a8afb54d776f21e305917e1ecf83cef678b4db38c2e5a405d04a8bf"
        },
        {
          "path": "dist/app/assets/profile-DER1-N6t.json",
          "bytes": 19566,
          "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a"
        },
        {
          "path": "dist/app/assets/sha256-BfK23X-R.js",
          "bytes": 2060,
          "sha256": "sha256:5bb1f7b8d2fdd5177d6f7ed6b25c7c59ec036088c36d98b9f571c8e51ba680e6"
        },
        {
          "path": "dist/app/assets/shell-C-lJpzF4.js",
          "bytes": 1226765,
          "sha256": "sha256:074f84b6e52db07bfafceb1d9d3969cc21e470cd8b18fd66c7505ebbd8bf2655"
        },
        {
          "path": "dist/app/assets/shell-C8ihFI8n.css",
          "bytes": 2815,
          "sha256": "sha256:b66733d44b18f5f0c0dec80f5982f92ee084a7eed278c6b15e7864329578d368"
        },
        {
          "path": "dist/app/assets/storage-library-D2zc068i.js",
          "bytes": 26847,
          "sha256": "sha256:d2e8c6c38396b58ca990fade3ef1b2344a5018f136d71fb62ff85c512a67b867"
        },
        {
          "path": "dist/app/assets/worker-MSy9aYeE.js",
          "bytes": 310316,
          "sha256": "sha256:e6d3d6882ae83b73c982b8ffa6ab003d1435a543451b2d6d06acf8a292c5609a"
        },
        {
          "path": "dist/app/build-evidence.json",
          "bytes": 75877,
          "sha256": "sha256:471ee50ec15d9c0507d55a689db6a46a7bcb542c1984762a803a838791a85f5f"
        },
        {
          "path": "dist/app/index.html",
          "bytes": 1083,
          "sha256": "sha256:b71edc6eb352a3f3c7181ea8931492b0495f54f4f22daeae3e0eb0d4c53a93ff"
        }
      ],
      "runtimeInputs": [
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-03/run-202/receipt.json",
          "bytes": 830348,
          "sha256": "sha256:a764db1f0280365649b3056b56b7f726caba8b2aaa56382e693622ac063789a4",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-03/run-298/receipt.json",
          "bytes": 840623,
          "sha256": "sha256:ef1a494f83a2b9c9e379207318c504191dabc22ae3bd044a3775946c77c64b42",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-04/run-249/receipt.json",
          "bytes": 832472,
          "sha256": "sha256:e59a9d1a6eaeceb4c17f15bea90b6be56cdc3770962f64e67a5fa09912dfa6ea",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-04/run-250/receipt.json",
          "bytes": 843682,
          "sha256": "sha256:e2d138ffee348f727c06dea4cea29e57c3ca3125ccc2aa06a6f86d82e1bb949e",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-04/run-286/receipt.json",
          "bytes": 837447,
          "sha256": "sha256:f0472713943729f55a64aaad045b7b42e807eebb4dbbe8bbf1be4a9237f924f0",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-05/run-356/receipt.json",
          "bytes": 867171,
          "sha256": "sha256:9215fd8d4bf32163a12ba635f42f8fa20bace0ebae9fd1bdc27a0a0c43481cd2",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-05/run-359/receipt.json",
          "bytes": 859645,
          "sha256": "sha256:f42cf094960c7677e1e8324682de27590a672619bbde25b800fe5eeea39537cf",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-06/run-357/receipt.json",
          "bytes": 867315,
          "sha256": "sha256:893b28f95b525782406f36ee3817c20401fff5fac772dcdb70967d7ffe56c744",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-06/run-360/receipt.json",
          "bytes": 859841,
          "sha256": "sha256:a33f64a507402f3758eb1cc6686b16446a88756d86e11e726371f79ffa67905d",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-07/run-358/receipt.json",
          "bytes": 867265,
          "sha256": "sha256:9356856223c8610a37a0070e267839f08476c1bb3b6ef5e4fe0c025e21619f15",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/evidence-browser-07/run-361/receipt.json",
          "bytes": 859817,
          "sha256": "sha256:5149fbdd6f7c36ca60924143db4991455ae76b1c855dc68df55e95ba42728226",
          "encoding": "utf8"
        }
      ]
    }
  },
  {
    "id": "ie-r18-6d08921-20261004",
    "sourceFiles": [
      {
        "path": ".progress-report/project.json",
        "bytes": 1689,
        "sha256": "sha256:fbb5739c4d01fdc4d8e53ba6c6334b87e74dad79d98cd7bab79a508019800fc2",
        "encoding": "utf8"
      },
      {
        "path": "index.html",
        "bytes": 881,
        "sha256": "sha256:2a5f972699a6c978cf2444720572542fd616f5e9741c614d1f567f44517a90a0",
        "encoding": "utf8"
      },
      {
        "path": "package-lock.json",
        "bytes": 71848,
        "sha256": "sha256:b4700ee8777c6f5f7f8f44298475b347c1c097c310259cc51617666fbf3c7333",
        "encoding": "utf8"
      },
      {
        "path": "package.json",
        "bytes": 5176,
        "sha256": "sha256:2fcb28caad63553a8aff9eaaea85d3dacdb68d5bd5006e92cbe96f2a9fb27ab6",
        "encoding": "utf8"
      },
      {
        "path": "server/static.ts",
        "bytes": 5903,
        "sha256": "sha256:a4c7634028f7ad97cfc14089a8851b28c1c4e049ffefb276be29dca82a1db00f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/profile.ts",
        "bytes": 5995,
        "sha256": "sha256:ccf144b64485a45f6188334947fbde9fa932e5bcb4ddb29a89b8de33ed13590f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/structure.ts",
        "bytes": 7417,
        "sha256": "sha256:fd16dd585940450b95e3106eb14973111cd71ea10cc8fe06c9ec50351a3b33a7",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/core.ts",
        "bytes": 23205,
        "sha256": "sha256:6fba62d8f28ecfad1469fbb4e9f29d9c64eb8e42a647452ea2abc0c155d2f5a5",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/draft.ts",
        "bytes": 4951,
        "sha256": "sha256:b544c10527e482822676ed4c5c1a06b226b5ca688835932fed454868c4b2318e",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/memory.ts",
        "bytes": 10016,
        "sha256": "sha256:f528c9ef6bd1ff53dab071d4ebcfc4cb726404f494011de27bccd31476c1e391",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/text-export.ts",
        "bytes": 9739,
        "sha256": "sha256:5c4f6491e1d6ac67f68390d5b9d2471d9753b782a5c1a883cf72fd5bca328f20",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/view.ts",
        "bytes": 506,
        "sha256": "sha256:8b784acc9948ca8a519ef415722668834ee454768cb67c1fd555013b21a7b930",
        "encoding": "utf8"
      },
      {
        "path": "src/main.ts",
        "bytes": 964,
        "sha256": "sha256:d185215040eaa0675747b0da9de615683abc0c99d0d228b9590821d668a4febb",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload-hook.ts",
        "bytes": 1214,
        "sha256": "sha256:756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload.ts",
        "bytes": 13589,
        "sha256": "sha256:77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/allocations.ts",
        "bytes": 40091,
        "sha256": "sha256:31a220cd0df3df7577212c64b5e5db3a21c16dc3c95de99f77721c4c6e77ac06",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser-worker-observations.ts",
        "bytes": 3117,
        "sha256": "sha256:00cd9c0b7e19f8a72878d92d31dd79b3578a49df24023b25b2acb343bb8300d2",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser.ts",
        "bytes": 21101,
        "sha256": "sha256:bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/composition-observations.ts",
        "bytes": 16019,
        "sha256": "sha256:966cf50aea8c77470a0dad9ffc08accf03ae974f99bb05292b1cefe23de93cfc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/diagnostic-memory.ts",
        "bytes": 7157,
        "sha256": "sha256:1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-control.ts",
        "bytes": 1647,
        "sha256": "sha256:455f5f15d48cac494525de9817ee685db8f476a4161e9887c10eca7f26b8f0a4",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-preview.ts",
        "bytes": 20859,
        "sha256": "sha256:938f3ea3c85c2eb491b4629c4840d107f0d60e2ffe7ed5315b4b5c2414231b8e",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-scheduler.ts",
        "bytes": 2969,
        "sha256": "sha256:0a41dc42a8fb9e17efd36d53a3c4f54fd79944473300e11c7349859bb6d2efae",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/model-memory.ts",
        "bytes": 5243,
        "sha256": "sha256:79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/navigation-observations.ts",
        "bytes": 5156,
        "sha256": "sha256:ddcbdfec01b890238fde7a9d33f4843661264aa375a8d3660e4608a239c58490",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/owned-preview.ts",
        "bytes": 5274,
        "sha256": "sha256:0bd894009708bf330aea1c7d217a1e1a0ee5e20aa8b474a366f6a8f0987ea762",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/phases.ts",
        "bytes": 10214,
        "sha256": "sha256:b50dcdadc22f9fbdbbbf6a19d9f453b60a5af94a3dfc17da9990503a81bb265b",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/prompt-memory.ts",
        "bytes": 6877,
        "sha256": "sha256:65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/recovery-memory.ts",
        "bytes": 6093,
        "sha256": "sha256:52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/adapters.ts",
        "bytes": 10834,
        "sha256": "sha256:49cff659b62eeb5ba4df9c21ba589aba60bb42a887734523edcf255db42bf51d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/asset-projection.ts",
        "bytes": 1312,
        "sha256": "sha256:49db7085d8cb0626cd22dba2b87f585b867be8ba6cb101efecbfe54187cd0931",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/assets.ts",
        "bytes": 2837,
        "sha256": "sha256:4e80ddb80e6244f8c30cec7272185fa6548a3ac2c0f5a5172d93cd5684130724",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidate-placement-review.ts",
        "bytes": 6833,
        "sha256": "sha256:dcca33d598d7de3dc6732cfbab57c9104e5f783c9f7c7fb60542bcc2dac5dbfc",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidates.ts",
        "bytes": 4080,
        "sha256": "sha256:3452fe398348f40a1c321931ad013b1c4147ccd898c4c976f9e763ce34d5b91c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/deletion.ts",
        "bytes": 893,
        "sha256": "sha256:8eaf9365f73bc56022476de004b4411a76176645029202407dc5baa3a96e3557",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/display.ts",
        "bytes": 2630,
        "sha256": "sha256:28c738c8080ff9765f937b5a312f58be8785c610b9c52a306addf53823963f5e",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/document-creation.ts",
        "bytes": 2150,
        "sha256": "sha256:d281fd9fe57717bde67c4db75026972090c3b36ac16119682fc073b648b4c311",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/encoded-rebuild.ts",
        "bytes": 6540,
        "sha256": "sha256:d6abc810868df34b1cf4aa495baed7d11e255b37c0075e2c25e93f426f839f32",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/export.ts",
        "bytes": 1750,
        "sha256": "sha256:bea072e2d3a6ff5cdc0308da33daca529a40ba4ffcc285570543622e2c9a5b5f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history-validation.ts",
        "bytes": 8071,
        "sha256": "sha256:110fb9cfeb47182bf48d4959e51b987488d2a230ffc801dbab84b1bbff9659e7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history.ts",
        "bytes": 8792,
        "sha256": "sha256:c31f9c89237f6f1d40b1068b3fc447a3853a0d6fd478b8f0b652538b4dceaeb7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/json.ts",
        "bytes": 4337,
        "sha256": "sha256:2c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/portable.ts",
        "bytes": 3500,
        "sha256": "sha256:c3788b41d0ab977590f0a22df0f533b364384c57b8dbec2ae76529c7548fb6fd",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/projection-schema.ts",
        "bytes": 3544,
        "sha256": "sha256:f6d7e8de3b2e7636335fcf87936fe3ec91d1a6fd52f4f11721754c4a7a53ab1a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/provider.ts",
        "bytes": 2379,
        "sha256": "sha256:48a05e2bd47d9afc606aa608d1ab96268dca74d52beb39cf347f95d15907c296",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue-events.ts",
        "bytes": 305,
        "sha256": "sha256:cdc923af08d68ce5bd260a2128a92c91dfbb75f2e3dcd593bceee8e22108e545",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue.ts",
        "bytes": 4678,
        "sha256": "sha256:7e29a16bdd3459d70611eb44f7f9813e4a06b87b8b64cb95c3ab9a2141012282",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster-import.ts",
        "bytes": 8151,
        "sha256": "sha256:e6216dc80bbc31a66a559a1d13adfae6580a4f8899ad60332ac447787ac7c86d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster.ts",
        "bytes": 2620,
        "sha256": "sha256:4908943e55c50e8ce5af54f9d86de9b5faec800e28de39a69d8c5c25317f7b86",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/recovery.ts",
        "bytes": 2964,
        "sha256": "sha256:7fc1be8bf95007250a6fb6942c999170c88460f02db56cf01450d393dc4c7f7c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/request-edits.ts",
        "bytes": 1980,
        "sha256": "sha256:5eef93ccfc9f3ac930301ba13ca2779b5ce3b3f3e14e06901d28cd263fc9453f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/session.ts",
        "bytes": 1646,
        "sha256": "sha256:2e3f10e47615fdfee3edaca39f8f7ccfa86635094de4a9f787d45c28f26e1ad4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/sha256.ts",
        "bytes": 2672,
        "sha256": "sha256:6125bfb8366910293774bd3efb05edcbc8f37fddd3642d6c43a7921ed0e73684",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage-repair.ts",
        "bytes": 3715,
        "sha256": "sha256:d07414e14b3cfb5f0648a79ee02058b2639cb4bf21066a0f212857a10ed6582c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage.ts",
        "bytes": 9085,
        "sha256": "sha256:9fe7a525099ab25fb12a0ba4aa7e1655fc24ca50eceaa96bf8c3f0a4aad15df4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/store.ts",
        "bytes": 3628,
        "sha256": "sha256:f8fd2bdee1da82c4c8f4bbde51c50f186ac06b40da079330f76511ad5863930a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text-budget.ts",
        "bytes": 5405,
        "sha256": "sha256:cca773c4442c8a1ec218c11c2344ff8e2811067ee8b10e48fae1c0aba85db590",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text.ts",
        "bytes": 11601,
        "sha256": "sha256:cee1e8e4a1cf2053ba0d14a58f6ea4200ff5bce36da657fa54ab34b342472abe",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/ui.ts",
        "bytes": 2104,
        "sha256": "sha256:bfbb2b10abfef1ea423751dba691e185ded9618d944ca0614846e23c8039c8d5",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/v45-inputs.ts",
        "bytes": 5738,
        "sha256": "sha256:e72fae2dbdaed62bf64588db0cbeda80e3971a805a5a10914ca8cddb6e6fa84b",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/validate.ts",
        "bytes": 33128,
        "sha256": "sha256:e330cf3ebcfb4ad3482d642ff029b3b6b07c0a319f782bced20621a21f777e38",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/core.ts",
        "bytes": 8804,
        "sha256": "sha256:d8de114ca50149e77c02c5cb5fa5b17b38f2d56cc6933db85a19242c6cd168b3",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mapping.ts",
        "bytes": 1899,
        "sha256": "sha256:b642fac2ac9a0864bb1d4deaef4a31243c5ad1e21adc26aaeeab158c50f87156",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mask.ts",
        "bytes": 9339,
        "sha256": "sha256:7b1fa5636a925c7b6845002a2c862cf3a2c30efbc534cec66baba2f7f7d5e47c",
        "encoding": "utf8"
      },
      {
        "path": "src/request/core.ts",
        "bytes": 29030,
        "sha256": "sha256:1047aa48fe5d1e7d2af795aa3b05f1b27a8a15c1f987e8b2e582557d6a61deb9",
        "encoding": "utf8"
      },
      {
        "path": "src/request/family.ts",
        "bytes": 9739,
        "sha256": "sha256:77f824dcba1464784d6c39ca3e05fd78a9d9c18e6be0657344ae672a0b38b4e0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/raster-plan.ts",
        "bytes": 26419,
        "sha256": "sha256:3b1b7cbbbae5b42907614d8b05d623653cc44454e92b679696310f0e471a50dc",
        "encoding": "utf8"
      },
      {
        "path": "src/request/review.ts",
        "bytes": 6237,
        "sha256": "sha256:7dfc05b8eee3d434b94ba74177c465855563afc2f1c371c8e6dcfd57b1837bb0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/text-treatment.ts",
        "bytes": 45353,
        "sha256": "sha256:2ab56b85fb685b72a0218b8d00110aab19d32c5a67e572bdb65914c85c52de9d",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-edit.ts",
        "bytes": 15680,
        "sha256": "sha256:fae51b0499780c5fae51d540e822a7871768a32d689f11b13b2be2c1d2f608f5",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-family-edit.ts",
        "bytes": 11475,
        "sha256": "sha256:d971b8173a06ef55dead0e084dd8daa0fbf1154e04fba692fe8d3803c4b97c44",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-prompt.ts",
        "bytes": 1619,
        "sha256": "sha256:bb584866ec006afcabb9081ad39c50f59470a832a330803b8b745f5bfa4c3452",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-stages.ts",
        "bytes": 1622,
        "sha256": "sha256:f2b093d6b930ce1b191051fce4e362916f98d6033d7d7cd437e09f1b5724fdd2",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45.ts",
        "bytes": 8473,
        "sha256": "sha256:d7cc0c18f7b8c8cda92beadc89f78aeceee13c015b62c75d869c39f2ecc56bf8",
        "encoding": "utf8"
      },
      {
        "path": "src/state/browser-journal.ts",
        "bytes": 4709,
        "sha256": "sha256:e6b6a51bb724608f1ccffe5c6ccbfe277e9d7b366e9523be00f73f6bc334011e",
        "encoding": "utf8"
      },
      {
        "path": "src/state/command-results.ts",
        "bytes": 15408,
        "sha256": "sha256:b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b",
        "encoding": "utf8"
      },
      {
        "path": "src/state/control-memory.ts",
        "bytes": 3960,
        "sha256": "sha256:80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75",
        "encoding": "utf8"
      },
      {
        "path": "src/state/destination.ts",
        "bytes": 22122,
        "sha256": "sha256:d1c6644511370e65f549ec04b0a392d2b2f60a35dee1deb2d2e568b0fe454222",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-lifecycle.ts",
        "bytes": 1760,
        "sha256": "sha256:1cfc86cc3a7f5bca57bbe531ec5cb99d47b3bc99c90a283df2aeb62cc79f0fed",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-list.ts",
        "bytes": 2519,
        "sha256": "sha256:430d0ebc556bf305896d4b33ec9ed58d2bc576f433e66c1972d53299afbcab72",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-persistence.ts",
        "bytes": 21470,
        "sha256": "sha256:677621bcddf8c2edebd9ba703552db3d3e41062a38e22e050dd7c0fd09060bdd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-values.ts",
        "bytes": 11215,
        "sha256": "sha256:9c8c592ed3d3374728d33cb8b6bd274a96f5b21c4d929f09c30657c32cb295d1",
        "encoding": "utf8"
      },
      {
        "path": "src/state/editor-client.ts",
        "bytes": 132260,
        "sha256": "sha256:86e0d989d26095161a307ddc493a1913a10735a2d6c5d6fcb1f0e40c62c820e1",
        "encoding": "utf8"
      },
      {
        "path": "src/state/export-options.ts",
        "bytes": 2632,
        "sha256": "sha256:9e4064cb4d4b37c8e0173d6c4020e6bf8a05aa8e999571f32e801ac9bb72f1f3",
        "encoding": "utf8"
      },
      {
        "path": "src/state/history-availability.ts",
        "bytes": 1318,
        "sha256": "sha256:51b1c63b3959a18fccfef51662cd974a01eb3ee52070f6a5eedbcc4eff671e5d",
        "encoding": "utf8"
      },
      {
        "path": "src/state/idb-ownership.ts",
        "bytes": 7990,
        "sha256": "sha256:bad165b4193384168a9f0cca3f265796c8389885a5fc1446351dc1452b981291",
        "encoding": "utf8"
      },
      {
        "path": "src/state/keyboard-preferences.ts",
        "bytes": 544,
        "sha256": "sha256:64e4db9f76cce85cf501fb0da6f670df94e70bd8ddda25b7771729c75059dd01",
        "encoding": "utf8"
      },
      {
        "path": "src/state/projection.ts",
        "bytes": 2058,
        "sha256": "sha256:9cf86f8a121bcef8b07879405d5989189df615684b46aa64185da9e0cb0b63f5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/queued-replacement-fence.ts",
        "bytes": 3345,
        "sha256": "sha256:d401f3df1f7b6b92990c52dc0492e48046fea53a46e18ed11ad8607a05f3f5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-cache.ts",
        "bytes": 8215,
        "sha256": "sha256:6171ea3ac2b90d73c7bb7e80963fd272a625f678aea2aed75b3de64aa7dd825f",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-client.ts",
        "bytes": 24263,
        "sha256": "sha256:faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/session-client.ts",
        "bytes": 10034,
        "sha256": "sha256:7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a",
        "encoding": "utf8"
      },
      {
        "path": "src/state/view-models.ts",
        "bytes": 14633,
        "sha256": "sha256:43e59ad5ae379bf48d6cf6e83a7829e411672d83fc20e471d52ab1e81a486509",
        "encoding": "utf8"
      },
      {
        "path": "src/text/admission.ts",
        "bytes": 4357,
        "sha256": "sha256:be0ae31c17e9d0497a27a49d0b15f1be7672c20c5752e8423ad71f0f06fc5e1a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi-data.json",
        "bytes": 19070,
        "sha256": "sha256:df36e677252814e1d84009c9ab735c12ac67deb7460695d64b477beee00b955a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi.ts",
        "bytes": 632,
        "sha256": "sha256:9fbc954b46188247d44c829ce82bba259de40dbcbb0100380c43aa8e7b961350",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bundled-fonts.ts",
        "bytes": 1857,
        "sha256": "sha256:14772cc968adf2512319ee2be18062db6b8ab32a591e1c0bdc3efe0305494c84",
        "encoding": "utf8"
      },
      {
        "path": "src/text/client.ts",
        "bytes": 10443,
        "sha256": "sha256:797c8a655b93bc9991b33d9f11c8ab694f868ea7a5c83625f6a1e5472ed297d4",
        "encoding": "utf8"
      },
      {
        "path": "src/text/contracts.ts",
        "bytes": 9434,
        "sha256": "sha256:08207c5aab6d234ac693fda1d8a0e4f3542bf446d67fc0b8370a5d8b9b024ca3",
        "encoding": "utf8"
      },
      {
        "path": "src/text/core.ts",
        "bytes": 20578,
        "sha256": "sha256:ba210ea0538daab09ded2d4013b1e5eb4948c47cf935afcdc6acd0ef707a7003",
        "encoding": "utf8"
      },
      {
        "path": "src/text/durable.ts",
        "bytes": 9424,
        "sha256": "sha256:6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52",
        "encoding": "utf8"
      },
      {
        "path": "src/text/engine.ts",
        "bytes": 1476,
        "sha256": "sha256:c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830",
        "encoding": "utf8"
      },
      {
        "path": "src/text/font.ts",
        "bytes": 4272,
        "sha256": "sha256:76a715d1e84212ae66dcbe34c55ae8a879e473bfea299987018a7d7bd9380b01",
        "encoding": "utf8"
      },
      {
        "path": "src/text/layout-writer.ts",
        "bytes": 5701,
        "sha256": "sha256:2edb8376e51f8988af0dbb3fdce5789b0c22a2d236835e5e651ca918255477ea",
        "encoding": "utf8"
      },
      {
        "path": "src/text/memory.ts",
        "bytes": 8104,
        "sha256": "sha256:7c2e1c7a90f053ee6ce26898bded8988bcfdc8c7e2abc8086170bc0d9cf81c7b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/profile.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/1c399d52.json",
        "bytes": 18008,
        "sha256": "sha256:140b72169cfae3e5fe727f58a0395b3a21ec7da6cf36283e87c9320a6a6c6ee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/2e9362c1.json",
        "bytes": 18885,
        "sha256": "sha256:acd1585535b30b39843af8615e2a40f95291b178a167e40535bea16528918427",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/304528c9.json",
        "bytes": 15748,
        "sha256": "sha256:13f8dc3e3cbe8b7f572b2c624068a7cbdf683a04bb91a3de87a021621e030033",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/4fd6f6a1.json",
        "bytes": 16958,
        "sha256": "sha256:3b5159888dd22ea25a4a660bc36f788e13eb526db558bb72e6bab44aedee7dcd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/68efa85f.json",
        "bytes": 17134,
        "sha256": "sha256:ea257991e81f2a1ebe4f2c3172c6071628b1a30b4230a5ec7c9b92d35db6c99e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6d77f925.json",
        "bytes": 17478,
        "sha256": "sha256:a00135bd564fa7926b97752024a1a00ec7c23ba520f4aecca63b74ad1cd2e599",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6e8a481e.json",
        "bytes": 15396,
        "sha256": "sha256:15634d19418bc21841fa8093de2ae7598b752c2f158be90f6e7e06216d79d6da",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6f7be5be.json",
        "bytes": 19214,
        "sha256": "sha256:c631086528d51d967a6a692777ff8fd5004ddf410e47b003f3ef7cbd0311a4bf",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/7a4dbc6c.json",
        "bytes": 16782,
        "sha256": "sha256:808650b42cc817012dd5d68df0124171ac78679ce497acd6a6c031409886052d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/891a4688.json",
        "bytes": 18360,
        "sha256": "sha256:f7c063fd77161f6be59b2a20559ddfda42e4bf8fcd2d04297d7321d324232a17",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/95244362.json",
        "bytes": 19390,
        "sha256": "sha256:96403bc29e02fc5e5162a6dbff1ef1387f2d892df9021b74efc2b625f5dd515e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b89503d3.json",
        "bytes": 14238,
        "sha256": "sha256:39b0190db275a08547f01494eb3f2725cdb7d2d3cb7a8e92abe42bbae6c5dee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b96236b0.json",
        "bytes": 18536,
        "sha256": "sha256:0c2857d4033926a7db23957fd3bf002929aa33a201e059626a9f8f286227d288",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c19791ae.json",
        "bytes": 12986,
        "sha256": "sha256:80d5dfb1f0f89548969c97348b57d0ddc6e8098f719de97dfb9feb9839734d2b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c6ca02c2.json",
        "bytes": 17655,
        "sha256": "sha256:d3ef40a7cbf8b4119627dc2f4ce1a11cb1bb1c9eedfb6b9d8321e04afeb249dd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/d047f5be.json",
        "bytes": 15572,
        "sha256": "sha256:d2cd5204fa8822a0ae17f610ada9add6b083ab90097d16b14397193522f54b1e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/e648eede.json",
        "bytes": 18184,
        "sha256": "sha256:1015d4832862ab35edb4fe9010d129d88a8d2fe4d1cefae4ffbe63054e62a6e5",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/f5e8bd34.json",
        "bytes": 16101,
        "sha256": "sha256:2b874883288b0e197153220b4e44ff1dcb751d34c164a3f558668b40733e7d3b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/ff24a513.json",
        "bytes": 15924,
        "sha256": "sha256:82bbff0efe60f4633875efe51917e9526464a2ddc54ab28c2dc048d44267ef36",
        "encoding": "utf8"
      },
      {
        "path": "src/text/returned-description.ts",
        "bytes": 9029,
        "sha256": "sha256:4c20cc4152f1c6777d73a92623cd2d8f0467dd9660f2a13d1ef7e189333e8c40",
        "encoding": "utf8"
      },
      {
        "path": "src/text/split.ts",
        "bytes": 3841,
        "sha256": "sha256:19b7c1b5a41f920f51d163e2cc3d2ecbf05459471554b36f001aee171016590d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/worker.ts",
        "bytes": 2089,
        "sha256": "sha256:7f60b4d87d0557bbe79e3472d643c6fb233ddbfe4923e7738e823fde86fe38be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/appearance.ts",
        "bytes": 676,
        "sha256": "sha256:c35f3badddd70240e30ee8198e7353f0dbb4c9020afcda9380b6e23f7996d787",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/density.ts",
        "bytes": 1236,
        "sha256": "sha256:26cf58af3eb0a582f4b51397ecd18bf5bcdc3f83176a410728e440be5525950b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/shell.css",
        "bytes": 28334,
        "sha256": "sha256:47412ebe81d5e5dcdba9e807f6639f7ad35566bd8a2ed8f1bdfeff9deb6b6c3e",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.companion.css",
        "bytes": 27494,
        "sha256": "sha256:58c83bba8e5560b838a1b822ada08adab200be353ce7ba45be6756fcd88e45be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.css",
        "bytes": 49741,
        "sha256": "sha256:ca1216ca1efc6dd6c99be79b94a366f95939f593bb13eeec73fd5b0b84e6444b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.companion.css",
        "bytes": 58517,
        "sha256": "sha256:83d713adb38f1114fa4f18c38e3882c81240df56ddb42142f95e914c51e3565b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.css",
        "bytes": 99593,
        "sha256": "sha256:0f9d2b4d8a0cc498e73b29dcda5c3990b973d028f4cab58055dc4c953a76284c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapter-library.ts",
        "bytes": 52982,
        "sha256": "sha256:c36e5c21aa53d940b7fe0507a81185eef5525bb5ee628bb59b9d2a4b91ad366e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapters.ts",
        "bytes": 1338,
        "sha256": "sha256:8a3a2476552dba3e8bd33b6d1bbc35e7b6663472e92cbe7999e5409f105b7514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/authoring.ts",
        "bytes": 65513,
        "sha256": "sha256:96eee099eb24452775f166b7c604ac9d46f23ebd2f7c53a2d686045b563d5b53",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.css",
        "bytes": 1614,
        "sha256": "sha256:acea87503cdcb9135eda4c9dccd532596ca05810d10b5b6fd5b4d78ee8f5384e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.ts",
        "bytes": 13006,
        "sha256": "sha256:5af702ccd21ae895fc625ed68028160dff209b297b4ace0862d24de7d7d49659",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-selection.ts",
        "bytes": 1972,
        "sha256": "sha256:77450803a9a542d5eff9518c42bd219a3881162f5499654082233fccddfa4136",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-text-treatment.ts",
        "bytes": 22157,
        "sha256": "sha256:298b25ec1aca29a179432a34d617d7a0cd900a9dfe1879cab08adaba00671125",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/canvas-view.ts",
        "bytes": 23346,
        "sha256": "sha256:69e5d914e0b783e0e1bd39a9570cd0f840ee287a8b7b261e3a4df08759fd04db",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/command-search.ts",
        "bytes": 11251,
        "sha256": "sha256:105d950b9cc16e35f70a4482ced6183d3599ee9ab6ba7e38be72158e0dd543ec",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-view.ts",
        "bytes": 8320,
        "sha256": "sha256:f692decf866069b8cb09101b18dc28512d97e32ddf7b06513b9261fa2ac665c3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-viewport.ts",
        "bytes": 2313,
        "sha256": "sha256:66881c5d3b8a7db109d47f75aae2d46130912f9adfddc37d9f5a08513d17cdf9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition-lifetime.ts",
        "bytes": 3633,
        "sha256": "sha256:2d33911edae29aace3d0e28fbd3b3037408c5d07fb15e357bbeee6499ff1438a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition.ts",
        "bytes": 72688,
        "sha256": "sha256:78b3938609555f581fecca318b16f06f9a384c9ed62791996b6214badf877f80",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/deletion.ts",
        "bytes": 17476,
        "sha256": "sha256:c44d524b1fa34e388bbf9c3752a2fa017d45d902eb87f78c74e9f10b4a63641b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/dialog-ownership.ts",
        "bytes": 3550,
        "sha256": "sha256:2d73cd25c25542b1a07ca870431e92831bbbe8ef9d9e825f4bea02ae028a6101",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-image.ts",
        "bytes": 2275,
        "sha256": "sha256:5a4f4b2206f8c79cc1e3804d3756760f073a1e24d9d34774a6e1988961af6eea",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-tiles.ts",
        "bytes": 21376,
        "sha256": "sha256:1227c3d78426138eca9f99d174b5b55f1866db45963a7fed75f9bccb48033092",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/editor-panels.ts",
        "bytes": 222,
        "sha256": "sha256:317eb7d341385707685a0051b0a0f845106b90216415d784ba37147775633b29",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export-memory.ts",
        "bytes": 4385,
        "sha256": "sha256:2f64b75340851239a90d8b5baad68b7f1f48171bfa42d04d087385eda6207330",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export.ts",
        "bytes": 29218,
        "sha256": "sha256:cfde6a3159485b3436f80571839fa7235109f5239baf38488812a42331bb175f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/font-relink.ts",
        "bytes": 795,
        "sha256": "sha256:f01c60678b5c2228b310b3b381d0fd4fed163ca255e1d03ed73c939f72760a89",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/icons.ts",
        "bytes": 1127,
        "sha256": "sha256:71ce0b0bf30ad2ead51133eb6cfd6d2866f05c6af3ba656fdae8f0ab91eff6f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/image-import.ts",
        "bytes": 39682,
        "sha256": "sha256:967bce89ddcba2922730a0ac1be42df2dd4880bd04d3886238cc4f9b692c7584",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-model.ts",
        "bytes": 6018,
        "sha256": "sha256:e90972c20a71cecbc1e48fc9f66aaa8da5293fa636ac510a008e300dd226969f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-transform.ts",
        "bytes": 3730,
        "sha256": "sha256:5deb71bb46fd6b2b9cc72b22b230772049d560007701d8eb2b7ed4e426c92c9d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/keyboard-scope.ts",
        "bytes": 2505,
        "sha256": "sha256:e2f4a3c60a4939ea34aeae97b2fd14310cb97d8d00586c0d3cf72abe6cf079cd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/model-owner.ts",
        "bytes": 5793,
        "sha256": "sha256:b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-control-memory.ts",
        "bytes": 3643,
        "sha256": "sha256:b8b811e36e6b73f27d01a2a412a657010809f7f8a43923c6bfb02b9a458d18b3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text-preview.ts",
        "bytes": 1165,
        "sha256": "sha256:9d22637412b77397f650608d1494ccab5367015ca61ed2d70464ca26475c65d9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text.ts",
        "bytes": 107073,
        "sha256": "sha256:2cf4f6d756cda567a9b8eb801d1ac0d493e01a1af6f1b06ea75d37d4c2ca777a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/new-document.ts",
        "bytes": 13476,
        "sha256": "sha256:d1ea4f98e67bacfd65fc1f1003e2dff920653c6436edf7377a5f778185989419",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider-payload.ts",
        "bytes": 4230,
        "sha256": "sha256:a100964fd08b21515369099dc3fafa851f209177e7826c1dd25d12f930044368",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider.ts",
        "bytes": 19559,
        "sha256": "sha256:cbf18fa6031136a1f802c9a12a8a259389831cd488b3c75d00aca7542cfc8f17",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/render-models.ts",
        "bytes": 1966,
        "sha256": "sha256:2623824d32f272039dae67ec047622079f4e25c4f01954494ee361b6ae78b9f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-composition-text.ts",
        "bytes": 7915,
        "sha256": "sha256:7d06fbadfddea5bd716d8496362b780d38598885806047e145cad42d28e4da6d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edit-models.ts",
        "bytes": 8234,
        "sha256": "sha256:5c6c04aac0972f4c67dd5b3f16aabcb510ce4a64da83af410aca58b9cc479514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.css",
        "bytes": 1715,
        "sha256": "sha256:37bdaea25e0c49f5ae97136d852e2623099b942ee6fdeccfbc09e3c59668b73a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.ts",
        "bytes": 135585,
        "sha256": "sha256:8d1372de19ba72d4fde71966844ece6ea3115b36e5eb0b2afcb0031f3271aa30",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-entry-memory.ts",
        "bytes": 2129,
        "sha256": "sha256:830a6cba622d2d11486590e2cd478095f9ad9334b8182d83a23cb96e78d196bd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-mask-memory.ts",
        "bytes": 4243,
        "sha256": "sha256:a81f870a76006531b2e769203921925263a2e09241ec3fc7bbbd4e24702720fd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-navigation-memory.ts",
        "bytes": 10321,
        "sha256": "sha256:c3d51c297dc391edfd41d683dab4bb5b82352d253e49af5d3d8c85a84311dbaa",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-prompt-memory.ts",
        "bytes": 9994,
        "sha256": "sha256:32aac1783ba960cd5085af75280d9af8a86035d597b45719e98b8447c7650d1b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-edit.ts",
        "bytes": 25042,
        "sha256": "sha256:e9d0ea843bfdd5ffcdbe9e822bf9fee6fdfdaf955e34acbe3d4cce1cdf9c0e75",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-memory.ts",
        "bytes": 3821,
        "sha256": "sha256:b4a8851853e00ce39c1c2f8770d92c916150299e4c8e5577dd3eed2288e2948c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45.ts",
        "bytes": 6428,
        "sha256": "sha256:242a196022be95eb18486fd22411aeee42f6ac494dbbccb6d449f69a14cac5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request.ts",
        "bytes": 145389,
        "sha256": "sha256:beca244c476feede381c81c1e11909e8721abe3eedbd48e34dc233e093342f0b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/returned-description.ts",
        "bytes": 11135,
        "sha256": "sha256:661db3b3aa1ca2f21eeb8a857d66f3fbc99ba3b356503735cc22d28f35c62fc6",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell-wordmark.ts",
        "bytes": 346,
        "sha256": "sha256:0dfcfe84e68da30bf6a0d66bb4159ef197ae718638989f7716009c66ad1b8aad",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell.ts",
        "bytes": 143087,
        "sha256": "sha256:de6efa4b80d625812f883cce94da3d42c5f80fd227fc88fb94cfe3b9baba9c72",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/storage-library.ts",
        "bytes": 26895,
        "sha256": "sha256:d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-library.ts",
        "bytes": 8785,
        "sha256": "sha256:e8906796f9508e7de560754ed9e44a17cd11009ca13c1b7e3850d053248dcf50",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-treatment.ts",
        "bytes": 35667,
        "sha256": "sha256:d43659f80639eadf89a4acebc4285d15cc095f8b5011b4fb5fdc03e88f86b7d3",
        "encoding": "utf8"
      },
      {
        "path": "tooling/build-evidence.ts",
        "bytes": 20934,
        "sha256": "sha256:483a863f126ff181d94897b3ca5defcbe00ff7104584bfbd8fa42478e54070c7",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/README.txt",
        "bytes": 2039,
        "sha256": "sha256:59d6581f2edc979d0629d088a13c6b4752fcfcf37904df54cec50b16a5cf8255",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.generated.json",
        "bytes": 2017,
        "sha256": "sha256:571457b38a697b09191224d87a72bfd52c7328fff19c2dadb5c9722f5659fe27",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.mjs",
        "bytes": 2585,
        "sha256": "sha256:21e8e47b0ab53f49111824eeef296bc78e09fa85b5d23b8aad8d0e3ee11a2198",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum-source.mjs",
        "bytes": 2195,
        "sha256": "sha256:a45376271626e5b7e9c0d6a296ec7a0d3d4d17d5b7aca98984ab06df6bfdb149",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum.mjs",
        "bytes": 1563,
        "sha256": "sha256:e93a08d41a58da0ebdb78039228412f770eca8a7d50d419b6b4269a6cea4c91f",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.app.json",
        "bytes": 349,
        "sha256": "sha256:1d7a7d0c87b2b0f55f4de437d8e014e0e840cde5d51c42feda80d6f98063db38",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.json",
        "bytes": 394,
        "sha256": "sha256:a65cb3aa05b5e70e54442976cd3b96b21671ebac5c4c5d5cb9ea295cd29cc044",
        "encoding": "utf8"
      },
      {
        "path": "vendor/text/manifest.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "vite.app.config.ts",
        "bytes": 554,
        "sha256": "sha256:ba4874b23f6f789ac56db7916bb0d0b1304bf3d2ff7c9a00bb0b4f298fe6c024",
        "encoding": "utf8"
      }
    ],
    "nativeFiles": [
      {
        "role": "package",
        "path": "node_modules/canvaskit-wasm/package.json",
        "bytes": 270,
        "sha256": "sha256:30863ad6290d1702ff4ef01dcf1f85aaa4f29e5bde0d0fb5ed8ee0666758bf2e",
        "encoding": "utf8"
      },
      {
        "role": "loader",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.js",
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f",
        "encoding": "utf8"
      },
      {
        "role": "wasm",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.wasm",
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19",
        "encoding": "base64"
      }
    ],
    "nativeRenderer": {
      "package": "canvaskit-wasm",
      "version": "0.40.0-ideogram.3",
      "rasterProfile": "ck040-custom3-cpu-rgba8888-unpremul-srgb-transparent-zero-1",
      "js": {
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f"
      },
      "wasm": {
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
      }
    },
    "appAllocation": {
      "contract": APP_OWNED_ALLOCATION_CONTRACT,
      "textResources": TEXT_RESOURCE_OWNERSHIP_CONTRACT,
      "appBuildFiles": [
        {
          "path": "dist/app/.vite/manifest.json",
          "bytes": 5530,
          "sha256": "sha256:b49d9f8e8dad6fc79a7f4c25ab0363a305c885248aada4b83dc5f467be5d4ba3"
        },
        {
          "path": "dist/app/assets/NotoSans-Regular-Dpf_lrdO.ttf",
          "bytes": 569208,
          "sha256": "sha256:b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5"
        },
        {
          "path": "dist/app/assets/NotoSansArabic-Regular-CEibNoL-.ttf",
          "bytes": 240456,
          "sha256": "sha256:ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b"
        },
        {
          "path": "dist/app/assets/NotoSansCJKsc-Regular-DxgKpThH.otf",
          "bytes": 16437364,
          "sha256": "sha256:2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"
        },
        {
          "path": "dist/app/assets/NotoSansSymbols2-Regular-Dcz4cXYm.ttf",
          "bytes": 656852,
          "sha256": "sha256:630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6"
        },
        {
          "path": "dist/app/assets/adapter-upload-ZJUl3sV6.js",
          "bytes": 7945,
          "sha256": "sha256:d770fe65afcc4272804ae9f68fbb859b0dfc6676a81f7419e14d803856e622cb"
        },
        {
          "path": "dist/app/assets/adapter-upload-hook-CZQz_zNG.js",
          "bytes": 148,
          "sha256": "sha256:9167561d48d065cd38224808ab8b4f74db38565eb546e2aed8a6081961fba99b"
        },
        {
          "path": "dist/app/assets/adapters-CoFyKvlB.js",
          "bytes": 568,
          "sha256": "sha256:6bfc66dea0b20c87dd428e790c5a438e1e38817ee7d1aa682b195418f763beb6"
        },
        {
          "path": "dist/app/assets/browser-BlAjsNLe.js",
          "bytes": 22209,
          "sha256": "sha256:423aa3fd78b26420d404903f3620a9397ef49e7672ff5440c513cbcac5f96e9c"
        },
        {
          "path": "dist/app/assets/canvaskit-B2Vb3rWN.wasm",
          "bytes": 4979358,
          "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
        },
        {
          "path": "dist/app/assets/control-memory-Eee2cnCW.js",
          "bytes": 2239,
          "sha256": "sha256:8a58feb1339afe21b4d6018fbe5058f7db4e535a13a1208a9a119f312f6d3677"
        },
        {
          "path": "dist/app/assets/density-b6s3w18k.js",
          "bytes": 917,
          "sha256": "sha256:9660db15fb7713a9dda7b12697cbe194054453f7c7256a8c1508a46fb7733046"
        },
        {
          "path": "dist/app/assets/display-image-BXlXvtE1.js",
          "bytes": 111081,
          "sha256": "sha256:027a854cc755ec72c5e83533396e35da45b3ab1ffea7bdac94fe3499f6532d8e"
        },
        {
          "path": "dist/app/assets/editor-panels-Uvj1nNX6.js",
          "bytes": 9441,
          "sha256": "sha256:108c31fe7c71e64b407c398c82ffc7333afce7e8b9dd5e525091abe7aac22733"
        },
        {
          "path": "dist/app/assets/export-B6GlwDVw.js",
          "bytes": 24691,
          "sha256": "sha256:c0ae962eb24d2cec57abf704f09669333ba63f6bcd79eb9a2eb70c5b28f06d4b"
        },
        {
          "path": "dist/app/assets/icon-bM7BnQq1.js",
          "bytes": 122573,
          "sha256": "sha256:8c3b0c399c780b8bfd9336d3643669e3a11b3a01740fd70211e8d4519486a597"
        },
        {
          "path": "dist/app/assets/image-import-CzkouyFB.js",
          "bytes": 28815,
          "sha256": "sha256:d2a6913c7e56d48e25484baa36861f7896cea9f7e458884fb08b36ecaec0bf5d"
        },
        {
          "path": "dist/app/assets/index-CdsDwA93.css",
          "bytes": 301517,
          "sha256": "sha256:f47ce2a6b67ce6da409243bf95a488dd22b8c9af4488478dacdee01012d09ced"
        },
        {
          "path": "dist/app/assets/index-JpfTi8Hu.js",
          "bytes": 1860,
          "sha256": "sha256:0df7b618fa3f1f573f164e1f06bb7ba29be3049a1d0fa51e9451b6f491a77e10"
        },
        {
          "path": "dist/app/assets/lit-tfDubpWu.js",
          "bytes": 15020,
          "sha256": "sha256:2aa46cc767b30e74b9f957c198780472518bb82cdb1d634b10ab5a575aff9e3d"
        },
        {
          "path": "dist/app/assets/model-memory-CTO-q7Az.js",
          "bytes": 40902,
          "sha256": "sha256:830aaec073215e4b9c739eaef66abed77805f7e177bdeeaebb1e8284daa8b555"
        },
        {
          "path": "dist/app/assets/model-owner-7fizWpfl.js",
          "bytes": 3438,
          "sha256": "sha256:4e1c3239a43214f0ae5b545ed74f4439a69794717235fae815eba400b6c6c4f3"
        },
        {
          "path": "dist/app/assets/preload-helper-BZ1Pz5am.js",
          "bytes": 1218,
          "sha256": "sha256:8820987e6a8afb54d776f21e305917e1ecf83cef678b4db38c2e5a405d04a8bf"
        },
        {
          "path": "dist/app/assets/profile-DER1-N6t.json",
          "bytes": 19566,
          "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a"
        },
        {
          "path": "dist/app/assets/sha256-BfK23X-R.js",
          "bytes": 2060,
          "sha256": "sha256:5bb1f7b8d2fdd5177d6f7ed6b25c7c59ec036088c36d98b9f571c8e51ba680e6"
        },
        {
          "path": "dist/app/assets/shell-C8ihFI8n.css",
          "bytes": 2815,
          "sha256": "sha256:b66733d44b18f5f0c0dec80f5982f92ee084a7eed278c6b15e7864329578d368"
        },
        {
          "path": "dist/app/assets/shell-CY6HBenO.js",
          "bytes": 1229155,
          "sha256": "sha256:3821c35dbda21aa401a7fa6085782e9a5d7735ba2ae5a782ca14b8caec6bc085"
        },
        {
          "path": "dist/app/assets/storage-library-D2zc068i.js",
          "bytes": 26847,
          "sha256": "sha256:d2e8c6c38396b58ca990fade3ef1b2344a5018f136d71fb62ff85c512a67b867"
        },
        {
          "path": "dist/app/assets/worker-MSy9aYeE.js",
          "bytes": 310316,
          "sha256": "sha256:e6d3d6882ae83b73c982b8ffa6ab003d1435a543451b2d6d06acf8a292c5609a"
        },
        {
          "path": "dist/app/build-evidence.json",
          "bytes": 75878,
          "sha256": "sha256:ee96bcd873e3ba5a021443da371a2cc0bbb78b0f1e113ca40dfc4b2d15159c5e"
        },
        {
          "path": "dist/app/index.html",
          "bytes": 1083,
          "sha256": "sha256:5469b7df684bb4fd33b0bc4c120042fd927b40a6201ca63332c7fa89412c5856"
        }
      ],
      "runtimeInputs": [
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/native-text-chromium/receipt.json",
          "bytes": 893670,
          "sha256": "sha256:17f0d75698312abacca2ed6f133dcfa0b3b78cb869edb552e367cf63811dbabd",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/native-text-firefox/receipt.json",
          "bytes": 893866,
          "sha256": "sha256:c40e8fa368854d5d335c92543f2717dd5f92cb9a33d8d9bf3cd37e8c78e6c854",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/native-text-webkit-macos/receipt.json",
          "bytes": 894210,
          "sha256": "sha256:f11e357eac062be164f44673c634e76fbc70e3909775199d55f68c28e892c65a",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/text-chromium/receipt.json",
          "bytes": 901123,
          "sha256": "sha256:b0a2d4a28ff1e3b6bafc63c673e89f1d3ae1775e9bc4a32d4f3f458bcae8ec91",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/text-firefox/receipt.json",
          "bytes": 901271,
          "sha256": "sha256:6e08862a339c7b78a03700b4969a48f99f47ea4bd33aa0dcb22e91ee21c65054",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/final-subject-six-origins-candidate-01/origins/text-webkit-macos/receipt.json",
          "bytes": 902734,
          "sha256": "sha256:852942f4c03f01585bb142d0663bace10e7178e30d70e843385549c440f21b66",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-current-refresh-prerequisites-01/node-components-6d08921-01/hosted-document-lifecycle-origin/run/receipt.json",
          "bytes": 875383,
          "sha256": "sha256:2eeb94da1ee7f6b9dbb73da92c04888573b7dc3e3e7a5c71aad7254a8c4bc67c",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-202-receipt.json",
          "bytes": 830348,
          "sha256": "sha256:a764db1f0280365649b3056b56b7f726caba8b2aaa56382e693622ac063789a4",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-249-receipt.json",
          "bytes": 832472,
          "sha256": "sha256:e59a9d1a6eaeceb4c17f15bea90b6be56cdc3770962f64e67a5fa09912dfa6ea",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-250-receipt.json",
          "bytes": 843682,
          "sha256": "sha256:e2d138ffee348f727c06dea4cea29e57c3ca3125ccc2aa06a6f86d82e1bb949e",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-286-receipt.json",
          "bytes": 837447,
          "sha256": "sha256:f0472713943729f55a64aaad045b7b42e807eebb4dbbe8bbf1be4a9237f924f0",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-298-receipt.json",
          "bytes": 840623,
          "sha256": "sha256:ef1a494f83a2b9c9e379207318c504191dabc22ae3bd044a3775946c77c64b42",
          "encoding": "utf8"
        }
      ]
    }
  },
  {
    "id": "ie-r18-39ac936-20261004",
    "sourceFiles": [
      {
        "path": ".progress-report/project.json",
        "bytes": 1689,
        "sha256": "sha256:fbb5739c4d01fdc4d8e53ba6c6334b87e74dad79d98cd7bab79a508019800fc2",
        "encoding": "utf8"
      },
      {
        "path": "index.html",
        "bytes": 881,
        "sha256": "sha256:2a5f972699a6c978cf2444720572542fd616f5e9741c614d1f567f44517a90a0",
        "encoding": "utf8"
      },
      {
        "path": "package-lock.json",
        "bytes": 71848,
        "sha256": "sha256:b4700ee8777c6f5f7f8f44298475b347c1c097c310259cc51617666fbf3c7333",
        "encoding": "utf8"
      },
      {
        "path": "package.json",
        "bytes": 5176,
        "sha256": "sha256:2fcb28caad63553a8aff9eaaea85d3dacdb68d5bd5006e92cbe96f2a9fb27ab6",
        "encoding": "utf8"
      },
      {
        "path": "server/static.ts",
        "bytes": 5903,
        "sha256": "sha256:a4c7634028f7ad97cfc14089a8851b28c1c4e049ffefb276be29dca82a1db00f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/profile.ts",
        "bytes": 5995,
        "sha256": "sha256:ccf144b64485a45f6188334947fbde9fa932e5bcb4ddb29a89b8de33ed13590f",
        "encoding": "utf8"
      },
      {
        "path": "src/adapters/structure.ts",
        "bytes": 7417,
        "sha256": "sha256:fd16dd585940450b95e3106eb14973111cd71ea10cc8fe06c9ec50351a3b33a7",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/core.ts",
        "bytes": 23205,
        "sha256": "sha256:6fba62d8f28ecfad1469fbb4e9f29d9c64eb8e42a647452ea2abc0c155d2f5a5",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/draft.ts",
        "bytes": 4951,
        "sha256": "sha256:b544c10527e482822676ed4c5c1a06b226b5ca688835932fed454868c4b2318e",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/memory.ts",
        "bytes": 10016,
        "sha256": "sha256:f528c9ef6bd1ff53dab071d4ebcfc4cb726404f494011de27bccd31476c1e391",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/text-export.ts",
        "bytes": 9739,
        "sha256": "sha256:5c4f6491e1d6ac67f68390d5b9d2471d9753b782a5c1a883cf72fd5bca328f20",
        "encoding": "utf8"
      },
      {
        "path": "src/composition/view.ts",
        "bytes": 506,
        "sha256": "sha256:8b784acc9948ca8a519ef415722668834ee454768cb67c1fd555013b21a7b930",
        "encoding": "utf8"
      },
      {
        "path": "src/main.ts",
        "bytes": 964,
        "sha256": "sha256:d185215040eaa0675747b0da9de615683abc0c99d0d228b9590821d668a4febb",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload-hook.ts",
        "bytes": 1214,
        "sha256": "sha256:756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/adapter-upload.ts",
        "bytes": 13589,
        "sha256": "sha256:77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/allocations.ts",
        "bytes": 40091,
        "sha256": "sha256:31a220cd0df3df7577212c64b5e5db3a21c16dc3c95de99f77721c4c6e77ac06",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser-worker-observations.ts",
        "bytes": 3117,
        "sha256": "sha256:00cd9c0b7e19f8a72878d92d31dd79b3578a49df24023b25b2acb343bb8300d2",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/browser.ts",
        "bytes": 21101,
        "sha256": "sha256:bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/composition-observations.ts",
        "bytes": 16019,
        "sha256": "sha256:966cf50aea8c77470a0dad9ffc08accf03ae974f99bb05292b1cefe23de93cfc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/diagnostic-memory.ts",
        "bytes": 7157,
        "sha256": "sha256:1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-control.ts",
        "bytes": 1647,
        "sha256": "sha256:455f5f15d48cac494525de9817ee685db8f476a4161e9887c10eca7f26b8f0a4",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-preview.ts",
        "bytes": 20859,
        "sha256": "sha256:938f3ea3c85c2eb491b4629c4840d107f0d60e2ffe7ed5315b4b5c2414231b8e",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/display-scheduler.ts",
        "bytes": 2969,
        "sha256": "sha256:0a41dc42a8fb9e17efd36d53a3c4f54fd79944473300e11c7349859bb6d2efae",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/model-memory.ts",
        "bytes": 5243,
        "sha256": "sha256:79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/navigation-observations.ts",
        "bytes": 5156,
        "sha256": "sha256:ddcbdfec01b890238fde7a9d33f4843661264aa375a8d3660e4608a239c58490",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/owned-preview.ts",
        "bytes": 5274,
        "sha256": "sha256:0bd894009708bf330aea1c7d217a1e1a0ee5e20aa8b474a366f6a8f0987ea762",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/phases.ts",
        "bytes": 10214,
        "sha256": "sha256:b50dcdadc22f9fbdbbbf6a19d9f453b60a5af94a3dfc17da9990503a81bb265b",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/prompt-memory.ts",
        "bytes": 6877,
        "sha256": "sha256:65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc",
        "encoding": "utf8"
      },
      {
        "path": "src/observability/recovery-memory.ts",
        "bytes": 6093,
        "sha256": "sha256:52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/adapters.ts",
        "bytes": 10834,
        "sha256": "sha256:49cff659b62eeb5ba4df9c21ba589aba60bb42a887734523edcf255db42bf51d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/asset-projection.ts",
        "bytes": 1312,
        "sha256": "sha256:49db7085d8cb0626cd22dba2b87f585b867be8ba6cb101efecbfe54187cd0931",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/assets.ts",
        "bytes": 2837,
        "sha256": "sha256:4e80ddb80e6244f8c30cec7272185fa6548a3ac2c0f5a5172d93cd5684130724",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidate-placement-review.ts",
        "bytes": 6833,
        "sha256": "sha256:dcca33d598d7de3dc6732cfbab57c9104e5f783c9f7c7fb60542bcc2dac5dbfc",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/candidates.ts",
        "bytes": 4080,
        "sha256": "sha256:3452fe398348f40a1c321931ad013b1c4147ccd898c4c976f9e763ce34d5b91c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/deletion.ts",
        "bytes": 893,
        "sha256": "sha256:8eaf9365f73bc56022476de004b4411a76176645029202407dc5baa3a96e3557",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/display.ts",
        "bytes": 2630,
        "sha256": "sha256:28c738c8080ff9765f937b5a312f58be8785c610b9c52a306addf53823963f5e",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/document-creation.ts",
        "bytes": 2150,
        "sha256": "sha256:d281fd9fe57717bde67c4db75026972090c3b36ac16119682fc073b648b4c311",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/encoded-rebuild.ts",
        "bytes": 6540,
        "sha256": "sha256:d6abc810868df34b1cf4aa495baed7d11e255b37c0075e2c25e93f426f839f32",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/export.ts",
        "bytes": 1750,
        "sha256": "sha256:bea072e2d3a6ff5cdc0308da33daca529a40ba4ffcc285570543622e2c9a5b5f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history-validation.ts",
        "bytes": 8071,
        "sha256": "sha256:110fb9cfeb47182bf48d4959e51b987488d2a230ffc801dbab84b1bbff9659e7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/history.ts",
        "bytes": 8792,
        "sha256": "sha256:c31f9c89237f6f1d40b1068b3fc447a3853a0d6fd478b8f0b652538b4dceaeb7",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/json.ts",
        "bytes": 4337,
        "sha256": "sha256:2c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/portable.ts",
        "bytes": 3500,
        "sha256": "sha256:c3788b41d0ab977590f0a22df0f533b364384c57b8dbec2ae76529c7548fb6fd",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/projection-schema.ts",
        "bytes": 3544,
        "sha256": "sha256:f6d7e8de3b2e7636335fcf87936fe3ec91d1a6fd52f4f11721754c4a7a53ab1a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/provider.ts",
        "bytes": 2379,
        "sha256": "sha256:48a05e2bd47d9afc606aa608d1ab96268dca74d52beb39cf347f95d15907c296",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue-events.ts",
        "bytes": 305,
        "sha256": "sha256:cdc923af08d68ce5bd260a2128a92c91dfbb75f2e3dcd593bceee8e22108e545",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/queue.ts",
        "bytes": 4678,
        "sha256": "sha256:7e29a16bdd3459d70611eb44f7f9813e4a06b87b8b64cb95c3ab9a2141012282",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster-import.ts",
        "bytes": 8151,
        "sha256": "sha256:e6216dc80bbc31a66a559a1d13adfae6580a4f8899ad60332ac447787ac7c86d",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/raster.ts",
        "bytes": 2620,
        "sha256": "sha256:4908943e55c50e8ce5af54f9d86de9b5faec800e28de39a69d8c5c25317f7b86",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/recovery.ts",
        "bytes": 2964,
        "sha256": "sha256:7fc1be8bf95007250a6fb6942c999170c88460f02db56cf01450d393dc4c7f7c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/request-edits.ts",
        "bytes": 1980,
        "sha256": "sha256:5eef93ccfc9f3ac930301ba13ca2779b5ce3b3f3e14e06901d28cd263fc9453f",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/session.ts",
        "bytes": 1646,
        "sha256": "sha256:2e3f10e47615fdfee3edaca39f8f7ccfa86635094de4a9f787d45c28f26e1ad4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/sha256.ts",
        "bytes": 2672,
        "sha256": "sha256:6125bfb8366910293774bd3efb05edcbc8f37fddd3642d6c43a7921ed0e73684",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage-repair.ts",
        "bytes": 3715,
        "sha256": "sha256:d07414e14b3cfb5f0648a79ee02058b2639cb4bf21066a0f212857a10ed6582c",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/storage.ts",
        "bytes": 9085,
        "sha256": "sha256:9fe7a525099ab25fb12a0ba4aa7e1655fc24ca50eceaa96bf8c3f0a4aad15df4",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/store.ts",
        "bytes": 3628,
        "sha256": "sha256:f8fd2bdee1da82c4c8f4bbde51c50f186ac06b40da079330f76511ad5863930a",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text-budget.ts",
        "bytes": 5405,
        "sha256": "sha256:cca773c4442c8a1ec218c11c2344ff8e2811067ee8b10e48fae1c0aba85db590",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/text.ts",
        "bytes": 11601,
        "sha256": "sha256:cee1e8e4a1cf2053ba0d14a58f6ea4200ff5bce36da657fa54ab34b342472abe",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/ui.ts",
        "bytes": 2104,
        "sha256": "sha256:bfbb2b10abfef1ea423751dba691e185ded9618d944ca0614846e23c8039c8d5",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/v45-inputs.ts",
        "bytes": 5738,
        "sha256": "sha256:e72fae2dbdaed62bf64588db0cbeda80e3971a805a5a10914ca8cddb6e6fa84b",
        "encoding": "utf8"
      },
      {
        "path": "src/protocol/validate.ts",
        "bytes": 33128,
        "sha256": "sha256:e330cf3ebcfb4ad3482d642ff029b3b6b07c0a319f782bced20621a21f777e38",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/core.ts",
        "bytes": 8804,
        "sha256": "sha256:d8de114ca50149e77c02c5cb5fa5b17b38f2d56cc6933db85a19242c6cd168b3",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mapping.ts",
        "bytes": 1899,
        "sha256": "sha256:b642fac2ac9a0864bb1d4deaef4a31243c5ad1e21adc26aaeeab158c50f87156",
        "encoding": "utf8"
      },
      {
        "path": "src/raster/mask.ts",
        "bytes": 9339,
        "sha256": "sha256:7b1fa5636a925c7b6845002a2c862cf3a2c30efbc534cec66baba2f7f7d5e47c",
        "encoding": "utf8"
      },
      {
        "path": "src/request/core.ts",
        "bytes": 29030,
        "sha256": "sha256:1047aa48fe5d1e7d2af795aa3b05f1b27a8a15c1f987e8b2e582557d6a61deb9",
        "encoding": "utf8"
      },
      {
        "path": "src/request/family.ts",
        "bytes": 9739,
        "sha256": "sha256:77f824dcba1464784d6c39ca3e05fd78a9d9c18e6be0657344ae672a0b38b4e0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/raster-plan.ts",
        "bytes": 26419,
        "sha256": "sha256:3b1b7cbbbae5b42907614d8b05d623653cc44454e92b679696310f0e471a50dc",
        "encoding": "utf8"
      },
      {
        "path": "src/request/review.ts",
        "bytes": 6237,
        "sha256": "sha256:7dfc05b8eee3d434b94ba74177c465855563afc2f1c371c8e6dcfd57b1837bb0",
        "encoding": "utf8"
      },
      {
        "path": "src/request/text-treatment.ts",
        "bytes": 45353,
        "sha256": "sha256:2ab56b85fb685b72a0218b8d00110aab19d32c5a67e572bdb65914c85c52de9d",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-edit.ts",
        "bytes": 15680,
        "sha256": "sha256:fae51b0499780c5fae51d540e822a7871768a32d689f11b13b2be2c1d2f608f5",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-family-edit.ts",
        "bytes": 11475,
        "sha256": "sha256:d971b8173a06ef55dead0e084dd8daa0fbf1154e04fba692fe8d3803c4b97c44",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-prompt.ts",
        "bytes": 1619,
        "sha256": "sha256:bb584866ec006afcabb9081ad39c50f59470a832a330803b8b745f5bfa4c3452",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45-stages.ts",
        "bytes": 1622,
        "sha256": "sha256:f2b093d6b930ce1b191051fce4e362916f98d6033d7d7cd437e09f1b5724fdd2",
        "encoding": "utf8"
      },
      {
        "path": "src/request/v45.ts",
        "bytes": 8473,
        "sha256": "sha256:d7cc0c18f7b8c8cda92beadc89f78aeceee13c015b62c75d869c39f2ecc56bf8",
        "encoding": "utf8"
      },
      {
        "path": "src/state/browser-journal.ts",
        "bytes": 4709,
        "sha256": "sha256:e6b6a51bb724608f1ccffe5c6ccbfe277e9d7b366e9523be00f73f6bc334011e",
        "encoding": "utf8"
      },
      {
        "path": "src/state/command-results.ts",
        "bytes": 15408,
        "sha256": "sha256:b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b",
        "encoding": "utf8"
      },
      {
        "path": "src/state/control-memory.ts",
        "bytes": 3960,
        "sha256": "sha256:80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75",
        "encoding": "utf8"
      },
      {
        "path": "src/state/destination.ts",
        "bytes": 22122,
        "sha256": "sha256:d1c6644511370e65f549ec04b0a392d2b2f60a35dee1deb2d2e568b0fe454222",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-lifecycle.ts",
        "bytes": 1760,
        "sha256": "sha256:1cfc86cc3a7f5bca57bbe531ec5cb99d47b3bc99c90a283df2aeb62cc79f0fed",
        "encoding": "utf8"
      },
      {
        "path": "src/state/document-list.ts",
        "bytes": 2519,
        "sha256": "sha256:430d0ebc556bf305896d4b33ec9ed58d2bc576f433e66c1972d53299afbcab72",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-persistence.ts",
        "bytes": 21470,
        "sha256": "sha256:677621bcddf8c2edebd9ba703552db3d3e41062a38e22e050dd7c0fd09060bdd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/draft-values.ts",
        "bytes": 11215,
        "sha256": "sha256:9c8c592ed3d3374728d33cb8b6bd274a96f5b21c4d929f09c30657c32cb295d1",
        "encoding": "utf8"
      },
      {
        "path": "src/state/editor-client.ts",
        "bytes": 132616,
        "sha256": "sha256:050bb6a57153674cff46f14212de0ac3b1321b647d764f55cd1a28c994a37e92",
        "encoding": "utf8"
      },
      {
        "path": "src/state/export-options.ts",
        "bytes": 2632,
        "sha256": "sha256:9e4064cb4d4b37c8e0173d6c4020e6bf8a05aa8e999571f32e801ac9bb72f1f3",
        "encoding": "utf8"
      },
      {
        "path": "src/state/history-availability.ts",
        "bytes": 1318,
        "sha256": "sha256:51b1c63b3959a18fccfef51662cd974a01eb3ee52070f6a5eedbcc4eff671e5d",
        "encoding": "utf8"
      },
      {
        "path": "src/state/idb-ownership.ts",
        "bytes": 7990,
        "sha256": "sha256:bad165b4193384168a9f0cca3f265796c8389885a5fc1446351dc1452b981291",
        "encoding": "utf8"
      },
      {
        "path": "src/state/keyboard-preferences.ts",
        "bytes": 544,
        "sha256": "sha256:64e4db9f76cce85cf501fb0da6f670df94e70bd8ddda25b7771729c75059dd01",
        "encoding": "utf8"
      },
      {
        "path": "src/state/projection.ts",
        "bytes": 2058,
        "sha256": "sha256:9cf86f8a121bcef8b07879405d5989189df615684b46aa64185da9e0cb0b63f5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/queued-replacement-fence.ts",
        "bytes": 3345,
        "sha256": "sha256:d401f3df1f7b6b92990c52dc0492e48046fea53a46e18ed11ad8607a05f3f5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-cache.ts",
        "bytes": 8215,
        "sha256": "sha256:6171ea3ac2b90d73c7bb7e80963fd272a625f678aea2aed75b3de64aa7dd825f",
        "encoding": "utf8"
      },
      {
        "path": "src/state/recovery-client.ts",
        "bytes": 24263,
        "sha256": "sha256:faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd",
        "encoding": "utf8"
      },
      {
        "path": "src/state/session-client.ts",
        "bytes": 10034,
        "sha256": "sha256:7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a",
        "encoding": "utf8"
      },
      {
        "path": "src/state/view-models.ts",
        "bytes": 14633,
        "sha256": "sha256:43e59ad5ae379bf48d6cf6e83a7829e411672d83fc20e471d52ab1e81a486509",
        "encoding": "utf8"
      },
      {
        "path": "src/text/admission.ts",
        "bytes": 4357,
        "sha256": "sha256:be0ae31c17e9d0497a27a49d0b15f1be7672c20c5752e8423ad71f0f06fc5e1a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi-data.json",
        "bytes": 19070,
        "sha256": "sha256:df36e677252814e1d84009c9ab735c12ac67deb7460695d64b477beee00b955a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bidi.ts",
        "bytes": 632,
        "sha256": "sha256:9fbc954b46188247d44c829ce82bba259de40dbcbb0100380c43aa8e7b961350",
        "encoding": "utf8"
      },
      {
        "path": "src/text/bundled-fonts.ts",
        "bytes": 1857,
        "sha256": "sha256:14772cc968adf2512319ee2be18062db6b8ab32a591e1c0bdc3efe0305494c84",
        "encoding": "utf8"
      },
      {
        "path": "src/text/client.ts",
        "bytes": 10443,
        "sha256": "sha256:797c8a655b93bc9991b33d9f11c8ab694f868ea7a5c83625f6a1e5472ed297d4",
        "encoding": "utf8"
      },
      {
        "path": "src/text/contracts.ts",
        "bytes": 9434,
        "sha256": "sha256:08207c5aab6d234ac693fda1d8a0e4f3542bf446d67fc0b8370a5d8b9b024ca3",
        "encoding": "utf8"
      },
      {
        "path": "src/text/core.ts",
        "bytes": 20578,
        "sha256": "sha256:ba210ea0538daab09ded2d4013b1e5eb4948c47cf935afcdc6acd0ef707a7003",
        "encoding": "utf8"
      },
      {
        "path": "src/text/durable.ts",
        "bytes": 9424,
        "sha256": "sha256:6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52",
        "encoding": "utf8"
      },
      {
        "path": "src/text/engine.ts",
        "bytes": 1476,
        "sha256": "sha256:c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830",
        "encoding": "utf8"
      },
      {
        "path": "src/text/font.ts",
        "bytes": 4272,
        "sha256": "sha256:76a715d1e84212ae66dcbe34c55ae8a879e473bfea299987018a7d7bd9380b01",
        "encoding": "utf8"
      },
      {
        "path": "src/text/layout-writer.ts",
        "bytes": 5701,
        "sha256": "sha256:2edb8376e51f8988af0dbb3fdce5789b0c22a2d236835e5e651ca918255477ea",
        "encoding": "utf8"
      },
      {
        "path": "src/text/memory.ts",
        "bytes": 8104,
        "sha256": "sha256:7c2e1c7a90f053ee6ce26898bded8988bcfdc8c7e2abc8086170bc0d9cf81c7b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/profile.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/1c399d52.json",
        "bytes": 18008,
        "sha256": "sha256:140b72169cfae3e5fe727f58a0395b3a21ec7da6cf36283e87c9320a6a6c6ee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/2e9362c1.json",
        "bytes": 18885,
        "sha256": "sha256:acd1585535b30b39843af8615e2a40f95291b178a167e40535bea16528918427",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/304528c9.json",
        "bytes": 15748,
        "sha256": "sha256:13f8dc3e3cbe8b7f572b2c624068a7cbdf683a04bb91a3de87a021621e030033",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/4fd6f6a1.json",
        "bytes": 16958,
        "sha256": "sha256:3b5159888dd22ea25a4a660bc36f788e13eb526db558bb72e6bab44aedee7dcd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/68efa85f.json",
        "bytes": 17134,
        "sha256": "sha256:ea257991e81f2a1ebe4f2c3172c6071628b1a30b4230a5ec7c9b92d35db6c99e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6d77f925.json",
        "bytes": 17478,
        "sha256": "sha256:a00135bd564fa7926b97752024a1a00ec7c23ba520f4aecca63b74ad1cd2e599",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6e8a481e.json",
        "bytes": 15396,
        "sha256": "sha256:15634d19418bc21841fa8093de2ae7598b752c2f158be90f6e7e06216d79d6da",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/6f7be5be.json",
        "bytes": 19214,
        "sha256": "sha256:c631086528d51d967a6a692777ff8fd5004ddf410e47b003f3ef7cbd0311a4bf",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/7a4dbc6c.json",
        "bytes": 16782,
        "sha256": "sha256:808650b42cc817012dd5d68df0124171ac78679ce497acd6a6c031409886052d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/891a4688.json",
        "bytes": 18360,
        "sha256": "sha256:f7c063fd77161f6be59b2a20559ddfda42e4bf8fcd2d04297d7321d324232a17",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/95244362.json",
        "bytes": 19390,
        "sha256": "sha256:96403bc29e02fc5e5162a6dbff1ef1387f2d892df9021b74efc2b625f5dd515e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b89503d3.json",
        "bytes": 14238,
        "sha256": "sha256:39b0190db275a08547f01494eb3f2725cdb7d2d3cb7a8e92abe42bbae6c5dee8",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/b96236b0.json",
        "bytes": 18536,
        "sha256": "sha256:0c2857d4033926a7db23957fd3bf002929aa33a201e059626a9f8f286227d288",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c19791ae.json",
        "bytes": 12986,
        "sha256": "sha256:80d5dfb1f0f89548969c97348b57d0ddc6e8098f719de97dfb9feb9839734d2b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/c6ca02c2.json",
        "bytes": 17655,
        "sha256": "sha256:d3ef40a7cbf8b4119627dc2f4ce1a11cb1bb1c9eedfb6b9d8321e04afeb249dd",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/d047f5be.json",
        "bytes": 15572,
        "sha256": "sha256:d2cd5204fa8822a0ae17f610ada9add6b083ab90097d16b14397193522f54b1e",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/e648eede.json",
        "bytes": 18184,
        "sha256": "sha256:1015d4832862ab35edb4fe9010d129d88a8d2fe4d1cefae4ffbe63054e62a6e5",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/f5e8bd34.json",
        "bytes": 16101,
        "sha256": "sha256:2b874883288b0e197153220b4e44ff1dcb751d34c164a3f558668b40733e7d3b",
        "encoding": "utf8"
      },
      {
        "path": "src/text/retained-profiles/ff24a513.json",
        "bytes": 15924,
        "sha256": "sha256:82bbff0efe60f4633875efe51917e9526464a2ddc54ab28c2dc048d44267ef36",
        "encoding": "utf8"
      },
      {
        "path": "src/text/returned-description.ts",
        "bytes": 9029,
        "sha256": "sha256:4c20cc4152f1c6777d73a92623cd2d8f0467dd9660f2a13d1ef7e189333e8c40",
        "encoding": "utf8"
      },
      {
        "path": "src/text/split.ts",
        "bytes": 3841,
        "sha256": "sha256:19b7c1b5a41f920f51d163e2cc3d2ecbf05459471554b36f001aee171016590d",
        "encoding": "utf8"
      },
      {
        "path": "src/text/worker.ts",
        "bytes": 2089,
        "sha256": "sha256:7f60b4d87d0557bbe79e3472d643c6fb233ddbfe4923e7738e823fde86fe38be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/appearance.ts",
        "bytes": 676,
        "sha256": "sha256:c35f3badddd70240e30ee8198e7353f0dbb4c9020afcda9380b6e23f7996d787",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/density.ts",
        "bytes": 1236,
        "sha256": "sha256:26cf58af3eb0a582f4b51397ecd18bf5bcdc3f83176a410728e440be5525950b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/shell.css",
        "bytes": 28431,
        "sha256": "sha256:cf85c85de1cb4285c3bc76fe34234fc8f0f85e86c9cf76fbab458f34072338b3",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.companion.css",
        "bytes": 27494,
        "sha256": "sha256:58c83bba8e5560b838a1b822ada08adab200be353ce7ba45be6756fcd88e45be",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.css",
        "bytes": 49741,
        "sha256": "sha256:ca1216ca1efc6dd6c99be79b94a366f95939f593bb13eeec73fd5b0b84e6444b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.companion.css",
        "bytes": 58517,
        "sha256": "sha256:83d713adb38f1114fa4f18c38e3882c81240df56ddb42142f95e914c51e3565b",
        "encoding": "utf8"
      },
      {
        "path": "src/theme/spectrum.density.css",
        "bytes": 99593,
        "sha256": "sha256:0f9d2b4d8a0cc498e73b29dcda5c3990b973d028f4cab58055dc4c953a76284c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapter-library.ts",
        "bytes": 52982,
        "sha256": "sha256:c36e5c21aa53d940b7fe0507a81185eef5525bb5ee628bb59b9d2a4b91ad366e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/adapters.ts",
        "bytes": 1338,
        "sha256": "sha256:8a3a2476552dba3e8bd33b6d1bbc35e7b6663472e92cbe7999e5409f105b7514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/authoring.ts",
        "bytes": 65513,
        "sha256": "sha256:96eee099eb24452775f166b7c604ac9d46f23ebd2f7c53a2d686045b563d5b53",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.css",
        "bytes": 1614,
        "sha256": "sha256:acea87503cdcb9135eda4c9dccd532596ca05810d10b5b6fd5b4d78ee8f5384e",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-comparison.ts",
        "bytes": 13006,
        "sha256": "sha256:5af702ccd21ae895fc625ed68028160dff209b297b4ace0862d24de7d7d49659",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-selection.ts",
        "bytes": 1972,
        "sha256": "sha256:77450803a9a542d5eff9518c42bd219a3881162f5499654082233fccddfa4136",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/candidate-text-treatment.ts",
        "bytes": 22157,
        "sha256": "sha256:298b25ec1aca29a179432a34d617d7a0cd900a9dfe1879cab08adaba00671125",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/canvas-view.ts",
        "bytes": 23346,
        "sha256": "sha256:69e5d914e0b783e0e1bd39a9570cd0f840ee287a8b7b261e3a4df08759fd04db",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/command-search.ts",
        "bytes": 11251,
        "sha256": "sha256:105d950b9cc16e35f70a4482ced6183d3599ee9ab6ba7e38be72158e0dd543ec",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-view.ts",
        "bytes": 8320,
        "sha256": "sha256:f692decf866069b8cb09101b18dc28512d97e32ddf7b06513b9261fa2ac665c3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/comparison-viewport.ts",
        "bytes": 2313,
        "sha256": "sha256:66881c5d3b8a7db109d47f75aae2d46130912f9adfddc37d9f5a08513d17cdf9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition-lifetime.ts",
        "bytes": 3633,
        "sha256": "sha256:2d33911edae29aace3d0e28fbd3b3037408c5d07fb15e357bbeee6499ff1438a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/composition.ts",
        "bytes": 72688,
        "sha256": "sha256:78b3938609555f581fecca318b16f06f9a384c9ed62791996b6214badf877f80",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/deletion.ts",
        "bytes": 17476,
        "sha256": "sha256:c44d524b1fa34e388bbf9c3752a2fa017d45d902eb87f78c74e9f10b4a63641b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/dialog-ownership.ts",
        "bytes": 3550,
        "sha256": "sha256:2d73cd25c25542b1a07ca870431e92831bbbe8ef9d9e825f4bea02ae028a6101",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-image.ts",
        "bytes": 2275,
        "sha256": "sha256:5a4f4b2206f8c79cc1e3804d3756760f073a1e24d9d34774a6e1988961af6eea",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/display-tiles.ts",
        "bytes": 21376,
        "sha256": "sha256:1227c3d78426138eca9f99d174b5b55f1866db45963a7fed75f9bccb48033092",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/editor-panels.ts",
        "bytes": 222,
        "sha256": "sha256:317eb7d341385707685a0051b0a0f845106b90216415d784ba37147775633b29",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export-memory.ts",
        "bytes": 4385,
        "sha256": "sha256:2f64b75340851239a90d8b5baad68b7f1f48171bfa42d04d087385eda6207330",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/export.ts",
        "bytes": 29218,
        "sha256": "sha256:cfde6a3159485b3436f80571839fa7235109f5239baf38488812a42331bb175f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/font-relink.ts",
        "bytes": 795,
        "sha256": "sha256:f01c60678b5c2228b310b3b381d0fd4fed163ca255e1d03ed73c939f72760a89",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/icons.ts",
        "bytes": 1127,
        "sha256": "sha256:71ce0b0bf30ad2ead51133eb6cfd6d2866f05c6af3ba656fdae8f0ab91eff6f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/image-import.ts",
        "bytes": 39682,
        "sha256": "sha256:967bce89ddcba2922730a0ac1be42df2dd4880bd04d3886238cc4f9b692c7584",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-model.ts",
        "bytes": 6018,
        "sha256": "sha256:e90972c20a71cecbc1e48fc9f66aaa8da5293fa636ac510a008e300dd226969f",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/inspector-transform.ts",
        "bytes": 3730,
        "sha256": "sha256:5deb71bb46fd6b2b9cc72b22b230772049d560007701d8eb2b7ed4e426c92c9d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/keyboard-scope.ts",
        "bytes": 2505,
        "sha256": "sha256:e2f4a3c60a4939ea34aeae97b2fd14310cb97d8d00586c0d3cf72abe6cf079cd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/model-owner.ts",
        "bytes": 5793,
        "sha256": "sha256:b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-control-memory.ts",
        "bytes": 3643,
        "sha256": "sha256:b8b811e36e6b73f27d01a2a412a657010809f7f8a43923c6bfb02b9a458d18b3",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text-preview.ts",
        "bytes": 1165,
        "sha256": "sha256:9d22637412b77397f650608d1494ccab5367015ca61ed2d70464ca26475c65d9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/native-text.ts",
        "bytes": 107073,
        "sha256": "sha256:2cf4f6d756cda567a9b8eb801d1ac0d493e01a1af6f1b06ea75d37d4c2ca777a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/new-document.ts",
        "bytes": 13476,
        "sha256": "sha256:d1ea4f98e67bacfd65fc1f1003e2dff920653c6436edf7377a5f778185989419",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider-payload.ts",
        "bytes": 4230,
        "sha256": "sha256:a100964fd08b21515369099dc3fafa851f209177e7826c1dd25d12f930044368",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/provider.ts",
        "bytes": 19559,
        "sha256": "sha256:cbf18fa6031136a1f802c9a12a8a259389831cd488b3c75d00aca7542cfc8f17",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/render-models.ts",
        "bytes": 1966,
        "sha256": "sha256:2623824d32f272039dae67ec047622079f4e25c4f01954494ee361b6ae78b9f9",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-composition-text.ts",
        "bytes": 7915,
        "sha256": "sha256:7d06fbadfddea5bd716d8496362b780d38598885806047e145cad42d28e4da6d",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edit-models.ts",
        "bytes": 8234,
        "sha256": "sha256:5c6c04aac0972f4c67dd5b3f16aabcb510ce4a64da83af410aca58b9cc479514",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.css",
        "bytes": 1715,
        "sha256": "sha256:37bdaea25e0c49f5ae97136d852e2623099b942ee6fdeccfbc09e3c59668b73a",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-edits.ts",
        "bytes": 135585,
        "sha256": "sha256:8d1372de19ba72d4fde71966844ece6ea3115b36e5eb0b2afcb0031f3271aa30",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-entry-memory.ts",
        "bytes": 2129,
        "sha256": "sha256:830a6cba622d2d11486590e2cd478095f9ad9334b8182d83a23cb96e78d196bd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-mask-memory.ts",
        "bytes": 4243,
        "sha256": "sha256:a81f870a76006531b2e769203921925263a2e09241ec3fc7bbbd4e24702720fd",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-navigation-memory.ts",
        "bytes": 10321,
        "sha256": "sha256:c3d51c297dc391edfd41d683dab4bb5b82352d253e49af5d3d8c85a84311dbaa",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-prompt-memory.ts",
        "bytes": 9994,
        "sha256": "sha256:32aac1783ba960cd5085af75280d9af8a86035d597b45719e98b8447c7650d1b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-edit.ts",
        "bytes": 25042,
        "sha256": "sha256:e9d0ea843bfdd5ffcdbe9e822bf9fee6fdfdaf955e34acbe3d4cce1cdf9c0e75",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45-memory.ts",
        "bytes": 3821,
        "sha256": "sha256:b4a8851853e00ce39c1c2f8770d92c916150299e4c8e5577dd3eed2288e2948c",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request-v45.ts",
        "bytes": 6428,
        "sha256": "sha256:242a196022be95eb18486fd22411aeee42f6ac494dbbccb6d449f69a14cac5d5",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/request.ts",
        "bytes": 145389,
        "sha256": "sha256:beca244c476feede381c81c1e11909e8721abe3eedbd48e34dc233e093342f0b",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/returned-description.ts",
        "bytes": 11135,
        "sha256": "sha256:661db3b3aa1ca2f21eeb8a857d66f3fbc99ba3b356503735cc22d28f35c62fc6",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell-wordmark.ts",
        "bytes": 346,
        "sha256": "sha256:0dfcfe84e68da30bf6a0d66bb4159ef197ae718638989f7716009c66ad1b8aad",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/shell.ts",
        "bytes": 143087,
        "sha256": "sha256:de6efa4b80d625812f883cce94da3d42c5f80fd227fc88fb94cfe3b9baba9c72",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/storage-library.ts",
        "bytes": 26895,
        "sha256": "sha256:d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-library.ts",
        "bytes": 8785,
        "sha256": "sha256:e8906796f9508e7de560754ed9e44a17cd11009ca13c1b7e3850d053248dcf50",
        "encoding": "utf8"
      },
      {
        "path": "src/ui/text-treatment.ts",
        "bytes": 35667,
        "sha256": "sha256:d43659f80639eadf89a4acebc4285d15cc095f8b5011b4fb5fdc03e88f86b7d3",
        "encoding": "utf8"
      },
      {
        "path": "tooling/build-evidence.ts",
        "bytes": 20934,
        "sha256": "sha256:483a863f126ff181d94897b3ca5defcbe00ff7104584bfbd8fa42478e54070c7",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/README.txt",
        "bytes": 2039,
        "sha256": "sha256:59d6581f2edc979d0629d088a13c6b4752fcfcf37904df54cec50b16a5cf8255",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.generated.json",
        "bytes": 2017,
        "sha256": "sha256:571457b38a697b09191224d87a72bfd52c7328fff19c2dadb5c9722f5659fe27",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/density.mjs",
        "bytes": 2585,
        "sha256": "sha256:21e8e47b0ab53f49111824eeef296bc78e09fa85b5d23b8aad8d0e3ee11a2198",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum-source.mjs",
        "bytes": 2195,
        "sha256": "sha256:a45376271626e5b7e9c0d6a296ec7a0d3d4d17d5b7aca98984ab06df6bfdb149",
        "encoding": "utf8"
      },
      {
        "path": "tooling/theme/spectrum.mjs",
        "bytes": 1563,
        "sha256": "sha256:e93a08d41a58da0ebdb78039228412f770eca8a7d50d419b6b4269a6cea4c91f",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.app.json",
        "bytes": 349,
        "sha256": "sha256:1d7a7d0c87b2b0f55f4de437d8e014e0e840cde5d51c42feda80d6f98063db38",
        "encoding": "utf8"
      },
      {
        "path": "tsconfig.json",
        "bytes": 394,
        "sha256": "sha256:a65cb3aa05b5e70e54442976cd3b96b21671ebac5c4c5d5cb9ea295cd29cc044",
        "encoding": "utf8"
      },
      {
        "path": "vendor/text/manifest.json",
        "bytes": 19566,
        "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a",
        "encoding": "utf8"
      },
      {
        "path": "vite.app.config.ts",
        "bytes": 554,
        "sha256": "sha256:ba4874b23f6f789ac56db7916bb0d0b1304bf3d2ff7c9a00bb0b4f298fe6c024",
        "encoding": "utf8"
      }
    ],
    "nativeFiles": [
      {
        "role": "package",
        "path": "node_modules/canvaskit-wasm/package.json",
        "bytes": 270,
        "sha256": "sha256:30863ad6290d1702ff4ef01dcf1f85aaa4f29e5bde0d0fb5ed8ee0666758bf2e",
        "encoding": "utf8"
      },
      {
        "role": "loader",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.js",
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f",
        "encoding": "utf8"
      },
      {
        "role": "wasm",
        "path": "node_modules/canvaskit-wasm/bin/canvaskit.wasm",
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19",
        "encoding": "base64"
      }
    ],
    "nativeRenderer": {
      "package": "canvaskit-wasm",
      "version": "0.40.0-ideogram.3",
      "rasterProfile": "ck040-custom3-cpu-rgba8888-unpremul-srgb-transparent-zero-1",
      "js": {
        "bytes": 73594,
        "sha256": "sha256:867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f"
      },
      "wasm": {
        "bytes": 4979358,
        "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
      }
    },
    "appAllocation": {
      "contract": {
        "contract": "application-owned-conservative-reservations-v1",
        "scope": "application-owned-conservative-reservations",
        "resourceKeys": [
          "cpuBytes",
          "gpuBytes",
          "previewCacheBytes",
          "handles"
        ],
        "excluded": [
          "native-image-and-canvas-implementation-overhead",
          "native-blob-residency",
          "engine-and-dom-allocations"
        ],
        "globalCoverageComplete": false
      },
      "appBuildFiles": [
        {
          "path": "dist/app/.vite/manifest.json",
          "bytes": 5530,
          "sha256": "sha256:da7888fb394a7962081009296b71d169e67b9a3e4a1f78fddf7684dd918f9a20"
        },
        {
          "path": "dist/app/assets/NotoSans-Regular-Dpf_lrdO.ttf",
          "bytes": 569208,
          "sha256": "sha256:b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5"
        },
        {
          "path": "dist/app/assets/NotoSansArabic-Regular-CEibNoL-.ttf",
          "bytes": 240456,
          "sha256": "sha256:ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b"
        },
        {
          "path": "dist/app/assets/NotoSansCJKsc-Regular-DxgKpThH.otf",
          "bytes": 16437364,
          "sha256": "sha256:2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"
        },
        {
          "path": "dist/app/assets/NotoSansSymbols2-Regular-Dcz4cXYm.ttf",
          "bytes": 656852,
          "sha256": "sha256:630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6"
        },
        {
          "path": "dist/app/assets/adapter-upload-ZJUl3sV6.js",
          "bytes": 7945,
          "sha256": "sha256:d770fe65afcc4272804ae9f68fbb859b0dfc6676a81f7419e14d803856e622cb"
        },
        {
          "path": "dist/app/assets/adapter-upload-hook-CZQz_zNG.js",
          "bytes": 148,
          "sha256": "sha256:9167561d48d065cd38224808ab8b4f74db38565eb546e2aed8a6081961fba99b"
        },
        {
          "path": "dist/app/assets/adapters-CoFyKvlB.js",
          "bytes": 568,
          "sha256": "sha256:6bfc66dea0b20c87dd428e790c5a438e1e38817ee7d1aa682b195418f763beb6"
        },
        {
          "path": "dist/app/assets/browser-BlAjsNLe.js",
          "bytes": 22209,
          "sha256": "sha256:423aa3fd78b26420d404903f3620a9397ef49e7672ff5440c513cbcac5f96e9c"
        },
        {
          "path": "dist/app/assets/canvaskit-B2Vb3rWN.wasm",
          "bytes": 4979358,
          "sha256": "sha256:26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19"
        },
        {
          "path": "dist/app/assets/control-memory-Eee2cnCW.js",
          "bytes": 2239,
          "sha256": "sha256:8a58feb1339afe21b4d6018fbe5058f7db4e535a13a1208a9a119f312f6d3677"
        },
        {
          "path": "dist/app/assets/density-b6s3w18k.js",
          "bytes": 917,
          "sha256": "sha256:9660db15fb7713a9dda7b12697cbe194054453f7c7256a8c1508a46fb7733046"
        },
        {
          "path": "dist/app/assets/display-image-BXlXvtE1.js",
          "bytes": 111081,
          "sha256": "sha256:027a854cc755ec72c5e83533396e35da45b3ab1ffea7bdac94fe3499f6532d8e"
        },
        {
          "path": "dist/app/assets/editor-panels-Uvj1nNX6.js",
          "bytes": 9441,
          "sha256": "sha256:108c31fe7c71e64b407c398c82ffc7333afce7e8b9dd5e525091abe7aac22733"
        },
        {
          "path": "dist/app/assets/export-B6GlwDVw.js",
          "bytes": 24691,
          "sha256": "sha256:c0ae962eb24d2cec57abf704f09669333ba63f6bcd79eb9a2eb70c5b28f06d4b"
        },
        {
          "path": "dist/app/assets/icon-bM7BnQq1.js",
          "bytes": 122573,
          "sha256": "sha256:8c3b0c399c780b8bfd9336d3643669e3a11b3a01740fd70211e8d4519486a597"
        },
        {
          "path": "dist/app/assets/image-import-CzkouyFB.js",
          "bytes": 28815,
          "sha256": "sha256:d2a6913c7e56d48e25484baa36861f7896cea9f7e458884fb08b36ecaec0bf5d"
        },
        {
          "path": "dist/app/assets/index-BsTyrtrL.css",
          "bytes": 301531,
          "sha256": "sha256:2f24db1e07f194c1c6c0882317686f5765d1199797df36366b1d098c7f66e56a"
        },
        {
          "path": "dist/app/assets/index-TVp7Gt_x.js",
          "bytes": 1860,
          "sha256": "sha256:31b3735311cd8e125e2e968c2a4a7d5d4fbd1ea8bb852b22f34808ba3477e89c"
        },
        {
          "path": "dist/app/assets/lit-tfDubpWu.js",
          "bytes": 15020,
          "sha256": "sha256:2aa46cc767b30e74b9f957c198780472518bb82cdb1d634b10ab5a575aff9e3d"
        },
        {
          "path": "dist/app/assets/model-memory-CTO-q7Az.js",
          "bytes": 40902,
          "sha256": "sha256:830aaec073215e4b9c739eaef66abed77805f7e177bdeeaebb1e8284daa8b555"
        },
        {
          "path": "dist/app/assets/model-owner-7fizWpfl.js",
          "bytes": 3438,
          "sha256": "sha256:4e1c3239a43214f0ae5b545ed74f4439a69794717235fae815eba400b6c6c4f3"
        },
        {
          "path": "dist/app/assets/preload-helper-BZ1Pz5am.js",
          "bytes": 1218,
          "sha256": "sha256:8820987e6a8afb54d776f21e305917e1ecf83cef678b4db38c2e5a405d04a8bf"
        },
        {
          "path": "dist/app/assets/profile-DER1-N6t.json",
          "bytes": 19566,
          "sha256": "sha256:96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a"
        },
        {
          "path": "dist/app/assets/sha256-BfK23X-R.js",
          "bytes": 2060,
          "sha256": "sha256:5bb1f7b8d2fdd5177d6f7ed6b25c7c59ec036088c36d98b9f571c8e51ba680e6"
        },
        {
          "path": "dist/app/assets/shell-C8ihFI8n.css",
          "bytes": 2815,
          "sha256": "sha256:b66733d44b18f5f0c0dec80f5982f92ee084a7eed278c6b15e7864329578d368"
        },
        {
          "path": "dist/app/assets/shell-DzJ8ZCAW.js",
          "bytes": 1229289,
          "sha256": "sha256:4b532e8e41c7afc145b8ec95efd9a031a46187e643999e82406af23601fe155b"
        },
        {
          "path": "dist/app/assets/storage-library-D2zc068i.js",
          "bytes": 26847,
          "sha256": "sha256:d2e8c6c38396b58ca990fade3ef1b2344a5018f136d71fb62ff85c512a67b867"
        },
        {
          "path": "dist/app/assets/worker-MSy9aYeE.js",
          "bytes": 310316,
          "sha256": "sha256:e6d3d6882ae83b73c982b8ffa6ab003d1435a543451b2d6d06acf8a292c5609a"
        },
        {
          "path": "dist/app/build-evidence.json",
          "bytes": 75877,
          "sha256": "sha256:28ce587276a4bb6b18630c49e57761504622c97631975d3e578df4d776d7b1fa"
        },
        {
          "path": "dist/app/index.html",
          "bytes": 1083,
          "sha256": "sha256:e31a2cd74274a0c495d95a5fd45e9b3b8a2fa2db92996a5940c5a122d656578d"
        }
      ],
      "runtimeInputs": [
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/document-lifecycle/receipt.json",
          "bytes": 880828,
          "sha256": "sha256:f7c020c5daa93d1ac1da84c99d0476b2ebb787069ba7e8f4dd126bdef8cbb521",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/editor-native-text-chromium/receipt.json",
          "bytes": 900141,
          "sha256": "sha256:61478300e91dd945b4da046e4a626e90588e1681340dc257e30022157393dbe8",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/editor-native-text-firefox/receipt.json",
          "bytes": 900322,
          "sha256": "sha256:b327c28975867684f1376aed510228761921ee384c372680093bda2ce660a091",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/editor-native-text-webkit/receipt.json",
          "bytes": 900687,
          "sha256": "sha256:bb56f467d75db33e67aae6a3c625164d3c05e459528e6c80ce785cc1d5a220f3",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/text-chromium/receipt.json",
          "bytes": 907597,
          "sha256": "sha256:93eaa8d245a73f82d5601c63b1d3b67723ff7be4f906fe1a523f0cd39559bb64",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/text-firefox/receipt.json",
          "bytes": 907757,
          "sha256": "sha256:0d710a08a343e9e1ec76fdcc0c78d4357a5fddb38175dc8027f37c6d8f13f90f",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/r18-final-source-39ac936-acquisition-01/successor-assembly-pending-01/origins/text-webkit/receipt.json",
          "bytes": 908078,
          "sha256": "sha256:a6b081ea0841870df8014c7b3638532b0df59a9d8785daac7b804b238a531f2e",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-202-receipt.json",
          "bytes": 830348,
          "sha256": "sha256:a764db1f0280365649b3056b56b7f726caba8b2aaa56382e693622ac063789a4",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-249-receipt.json",
          "bytes": 832472,
          "sha256": "sha256:e59a9d1a6eaeceb4c17f15bea90b6be56cdc3770962f64e67a5fa09912dfa6ea",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-250-receipt.json",
          "bytes": 843682,
          "sha256": "sha256:e2d138ffee348f727c06dea4cea29e57c3ca3125ccc2aa06a6f86d82e1bb949e",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-286-receipt.json",
          "bytes": 837447,
          "sha256": "sha256:f0472713943729f55a64aaad045b7b42e807eebb4dbbe8bbf1be4a9237f924f0",
          "encoding": "utf8"
        },
        {
          "role": "correctness-receipt",
          "path": "artifacts/integration-corrections/renderer-ownership-approval-preparation-01/component-original-receipts-cache-01/run-298-receipt.json",
          "bytes": 840623,
          "sha256": "sha256:ef1a494f83a2b9c9e379207318c504191dabc22ae3bd044a3775946c77c64b42",
          "encoding": "utf8"
        }
      ],
      "textResources": {
        "contract": "font-shaping-reservations-and-owned-glyphs-v1",
        "scope": "font-shaping-conservative-owned-reservations",
        "cpuKinds": [
          "font",
          "text",
          "control",
          "prompt",
          "staging",
          "scratch",
          "copy"
        ],
        "textPool": "text-category-only",
        "nativeCoverage": [
          "font-parser",
          "shaping-worker",
          "bounded-wasm-heap",
          "font-cache",
          "prepared-output"
        ],
        "includesSharedBookkeeping": true,
        "glyphGpu": "application-owned-software-renderer-zero",
        "physicalAllocations": false
      }
    }
  }
]);

const sourceRequirements = new Set(['index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json',
  'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts',
  'server/static.ts', 'vendor/text/manifest.json']);
const buildSourceRequirements = new Set([...sourceRequirements].filter(path => path !== 'server/static.ts'));
const sourceRequired = path => path.startsWith('src/') || path.startsWith('tooling/theme/') || sourceRequirements.has(path);
const buildSourceRequired = path => path.startsWith('src/') || path.startsWith('tooling/theme/') || buildSourceRequirements.has(path);
function relativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe renderer ownership input path');
  return path;
}
function identities(files, source = false) {
  if (!Array.isArray(files) || !files.length || files.length > 100_000) throw Error('Renderer ownership requires independent file identities');
  const result = new Map();
  for (const file of files) {
    relativePath(file?.path);
    if (result.has(file.path)) throw Error('Duplicate renderer ownership file identity');
    if (source && file.deleted === true) {
      if (!exactKeys(file, ['path', 'deleted'])) throw Error('Malformed deleted renderer source');
      result.set(file.path, null); continue;
    }
    if (!integer(file.bytes) || !(source ? BARE_HASH : HASH).test(file.sha256 ?? '')) throw Error('Malformed renderer ownership file identity');
    result.set(file.path, { path: file.path, bytes: file.bytes, sha256: source ? 'sha256:' + file.sha256 : file.sha256 });
  }
  return result;
}
function contextIdentity({ sourceFiles, buildFiles, executableIdentity }) {
  const sources = identities(sourceFiles, true), builds = identities(buildFiles);
  if (!exactKeys(executableIdentity, ['sourceDigest', 'buildDigest', 'toolsDigest']) || !BARE_HASH.test(executableIdentity.sourceDigest ?? '') ||
    !HASH.test(executableIdentity.buildDigest ?? '') || !HASH.test(executableIdentity.toolsDigest ?? '') ||
    digestJSON(sourceFiles) !== executableIdentity.sourceDigest || digest(buildFiles) !== executableIdentity.buildDigest) throw Error('Renderer ownership executable identity differs from its parent manifests');
  return { sources, builds, executableIdentity };
}
function pinIdentity(pin) {
  relativePath(pin?.path);
  if (!integer(pin.bytes) || pin.bytes > MAX_EVIDENCE_BYTES || !HASH.test(pin.sha256 ?? '') || !['utf8', 'base64'].includes(pin.encoding)) throw Error('Invalid reviewed renderer input');
  return { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
}
const reviewDigests = new WeakMap();
function reviewIdentity(review) {
  // The registry is deeply frozen. Its potentially large source closure is
  // hashed once, never once per 100ms sampled metadata check.
  let identity = reviewDigests.get(review);
  if (!identity) { identity = digest(canonical({ ...review, contract: CANVAS2D_RENDERER_CONTRACT })); reviewDigests.set(review, identity); }
  return identity;
}
function reviewedSources(review, sources) {
  if (!review || typeof review.id !== 'string' || !review.id || !Array.isArray(review.sourceFiles) || !review.sourceFiles.length ||
    !Array.isArray(review.nativeFiles) || !review.nativeRenderer) throw Error('Incomplete renderer ownership review');
  const names = new Set();
  for (const pin of review.sourceFiles) {
    const identity = pinIdentity(pin);
    if (names.has(pin.path)) throw Error('Duplicate reviewed renderer source');
    names.add(pin.path); same(sources.get(pin.path), identity, 'Renderer source differs from the reviewed closure');
  }
  if ([...sourceRequirements].some(path => !names.has(path)) || [...sources].some(([path, value]) => value && sourceRequired(path) && !names.has(path))) throw Error('Renderer review omits an application source or entry input');
  same(review.nativeFiles.map(file => file.role).sort(), ['loader', 'package', 'wasm'], 'Renderer review lacks the exact native package/loader/WASM closure');
  for (const file of review.nativeFiles) {
    pinIdentity(file);
    if (!file.path.startsWith('node_modules/canvaskit-wasm/')) throw Error('Reviewed native renderer is outside its sealed package');
  }
}
const validatedAppReviews = new WeakSet();
function reviewedAppAllocation(review, context) {
  const app = review.appAllocation;
  if (!validatedAppReviews.has(review)) {
    if (!exactKeys(app, ['contract', 'appBuildFiles', 'runtimeInputs', ...(Object.hasOwn(app ?? {}, 'textResources') ? ['textResources'] : [])])) throw Error('Missing fixed application allocation review');
    same(app.contract, APP_OWNED_ALLOCATION_CONTRACT, 'Application allocation review has another scope');
    if (Object.hasOwn(app, 'textResources')) same(app.textResources, TEXT_RESOURCE_OWNERSHIP_CONTRACT, 'Text resource review has another scope');
    // Only the application subject is approved here. Campaign tooling changes
    // after the actual correctness run cannot introduce a self-referential seal.
    if (review.sourceFiles.some(pin => !sourceRequired(pin.path))) throw Error('Application approval includes nonapplication source inputs');
    if (!Array.isArray(app.appBuildFiles) || !app.appBuildFiles.length || app.appBuildFiles.length > 100_000) throw Error('Application allocation review lacks its actual build');
    const builds = new Set();
    for (const pin of app.appBuildFiles) {
      if (!exactKeys(pin, ['path', 'bytes', 'sha256']) || !integer(pin.bytes) || !HASH.test(pin.sha256 ?? '') || !relativePath(pin.path).startsWith('dist/app/') || builds.has(pin.path)) throw Error('Malformed reviewed application build identity');
      builds.add(pin.path);
    }
    if (!builds.has('dist/app/build-evidence.json')) throw Error('Reviewed application build lacks finalized evidence');
    if (!Array.isArray(app.runtimeInputs) || !app.runtimeInputs.length || app.runtimeInputs.length > 32) throw Error('Application allocation review lacks actual correctness evidence');
    const names = new Set(); let bytes = 0;
    for (const pin of app.runtimeInputs) {
      if (!exactKeys(pin, ['role', 'path', 'bytes', 'sha256', 'encoding']) || pin.role !== 'correctness-receipt' || pin.bytes === 0 || names.has(pin.path)) throw Error('Malformed reviewed application runtime receipt');
      pinIdentity(pin); names.add(pin.path); bytes += pin.bytes;
    }
    if (bytes > MAX_EVIDENCE_BYTES) throw Error('Reviewed runtime receipts exceed the retained evidence bound');
    // Registry entries are deeply frozen; sampling never rescans their closure.
    validatedAppReviews.add(review);
  }
  if (context) same([...app.appBuildFiles].sort((a, b) => a.path.localeCompare(b.path)), [...context.builds.values()].filter(pin => pin.path.startsWith('dist/app/')).sort((a, b) => a.path.localeCompare(b.path)), 'Application build differs from approved runtime subject');
  return app;
}
function selectedReview(context) {
  return REVIEWED_RENDERER_OWNERSHIP.find(review => {
    try { reviewedSources(review, context.sources); if (review.appAllocation) reviewedAppAllocation(review, context); return true; } catch { return false; }
  });
}
function proofReview(proof) {
  if (!exactKeys(proof, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'artifact']) || !['renderer-ownership-proof-1', 'renderer-ownership-proof-2'].includes(proof.kind) ||
    proof.contract !== CANVAS2D_RENDERER_CONTRACT.contract || Buffer.byteLength(JSON.stringify(proof)) > MAX_PROOF_BYTES) throw Error('Malformed renderer ownership proof metadata');
  const review = REVIEWED_RENDERER_OWNERSHIP.find(value => value.id === proof.reviewId);
  if (!review || proof.reviewSha256 !== reviewIdentity(review)) throw Error('Renderer ownership has no exact approved source review');
  if (proof.kind === 'renderer-ownership-proof-2') reviewedAppAllocation(review);
  const evidenceFile = proof.kind === 'renderer-ownership-proof-2' ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  const identity = proof.executableIdentity, artifact = proof.artifact;
  if (!exactKeys(identity, ['sourceDigest', 'buildDigest', 'toolsDigest']) || !BARE_HASH.test(identity.sourceDigest ?? '') || !HASH.test(identity.buildDigest ?? '') || !HASH.test(identity.toolsDigest ?? '') ||
    !exactKeys(artifact, ['path', 'retainedPath', 'bytes', 'sha256']) || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path ||
    artifact.retainedPath !== evidenceFile || !artifact.path.endsWith(sep + evidenceFile) || !integer(artifact.bytes) || artifact.bytes === 0 || artifact.bytes > MAX_EVIDENCE_BYTES || !HASH.test(artifact.sha256 ?? '')) throw Error('Malformed renderer ownership identity or retained artifact');
  return review;
}

/** This serialized predicate is only the metric gate. Receipt verification
 * must independently replay the retained artifact before accepting a verdict. */
export function isRendererTextureNotApplicable(rendererOwnership, proof, { gpuBytes } = {}) {
  try {
    proofReview(proof);
    if (!exactKeys(rendererOwnership, [...Object.keys(CANVAS2D_RENDERER_CONTRACT), 'rgbaBackingEstimateBytes']) || !integer(gpuBytes) || rendererOwnership.rgbaBackingEstimateBytes !== gpuBytes) return false;
    const { rgbaBackingEstimateBytes: _bytes, ...contract } = rendererOwnership;
    return isDeepStrictEqual(contract, CANVAS2D_RENDERER_CONTRACT);
  } catch { return false; }
}

const allocationKinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
const amountKeys = APP_OWNED_ALLOCATION_CONTRACT.resourceKeys;
const cpuMissing = ['app-payload-ownership-incomplete', ...APP_OWNED_ALLOCATION_CONTRACT.excluded, 'renderer-ownership-proof-required'];
const appFailures = ['counter-overflow', 'kind-reconciliation', 'sequence-reconciliation', 'cpu-window-binding', 'observer-incomplete'];
const cpuFailures = ['text-observer-unavailable', 'text-observer-rebound', 'text-observer-disconnected', 'text-sequence-discontinuity', 'text-observer-fault', 'text-observation-invalid', 'clock-invalid', 'observer-reentrant'];
const valid = (condition, message) => { if (!condition) throw Error('Invalid application ownership observation: ' + message); };
const finiteTime = value => Number.isFinite(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exactObservation = (value, keys, label) => valid(exactKeys(value, keys), label + ' keys');
const unsigned = (value, label) => valid(integer(value), label);
const nullableUnsigned = (value, label) => valid(value === null || integer(value), label);
function failureList(values, allowed, label) {
  valid(Array.isArray(values) && values.length <= allowed.length && new Set(values).size === values.length && values.every(value => allowed.includes(value)), label);
}
function counts(value, withRecords, label) {
  exactObservation(value, [...(withRecords ? ['records'] : []), ...amountKeys], label);
  for (const [key, number] of Object.entries(value)) unsigned(number, label + '.' + key);
  valid(value.previewCacheBytes <= value.cpuBytes + value.gpuBytes, label + ' cache subset');
  valid(!withRecords || value.records > 0 || amountKeys.every(key => value[key] === 0), label + ' ownership without a record');
}
function sumKinds(rows, select) {
  const total = { records: 0, cpuBytes: 0, gpuBytes: 0, previewCacheBytes: 0, handles: 0 };
  for (const row of rows) for (const key of Object.keys(total)) { total[key] += select(row)[key] ?? 0; unsigned(total[key], 'kind sum ' + key); }
  return total;
}
function cpuObservation(value) {
  exactObservation(value, ['kind', 'schemaVersion', 'scope', 'ledgerInstanceId', 'sequence', 'currentBytes', 'observedPeakBytes', 'observationComplete', 'ownerCoverageComplete', 'missing', 'window'], 'CPU observation');
  valid(value.kind === 'combined-cpu-observation-1' && value.schemaVersion === 1 && value.scope === 'browser-ledger-plus-text-reservations' && identifier(value.ledgerInstanceId), 'CPU identity');
  for (const key of ['sequence', 'currentBytes', 'observedPeakBytes']) unsigned(value[key], 'CPU ' + key);
  valid(value.observedPeakBytes >= value.currentBytes && value.observationComplete === false && value.ownerCoverageComplete === false, 'CPU lifetime scope');
  same(value.missing, cpuMissing, 'CPU observation omits explicit ownership gaps');
  const window = value.window; if (window === null) return null;
  exactObservation(window, ['kind', 'schemaVersion', 'ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'peakAtMs', 'startSequence', 'endSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence', 'textEndSequence', 'sealed', 'observationComplete', 'ownerCoverageComplete', 'failures', 'missing'], 'CPU window');
  valid(window.kind === 'combined-cpu-window-1' && window.schemaVersion === 1 && window.ledgerInstanceId === value.ledgerInstanceId && typeof window.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(window.id), 'CPU window identity');
  valid(window.clock === 'browser-performance' && finiteTime(window.clockOriginMs) && finiteTime(window.startMs) && finiteTime(window.peakAtMs) && window.peakAtMs >= window.startMs, 'CPU window clock');
  for (const key of ['ordinal', 'startSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence']) unsigned(window[key], 'CPU window ' + key);
  valid(window.ordinal > 0 && window.peakSequence >= window.startSequence && window.peakSequence <= value.sequence && window.peakBytes >= window.currentBytes && window.peakBytes === window.ledgerBytesAtPeak + window.textBytesAtPeak && value.observedPeakBytes >= window.peakBytes, 'CPU window peak');
  valid(typeof window.sealed === 'boolean' && typeof window.observationComplete === 'boolean' && window.ownerCoverageComplete === false, 'CPU window flags');
  failureList(window.failures, cpuFailures, 'CPU failures'); same(window.missing, cpuMissing, 'CPU window omits explicit ownership gaps');
  valid(!window.observationComplete || window.failures.length === 0, 'complete CPU window has failures');
  if (window.sealed) {
    const textRebound = !window.observationComplete && window.failures.some(reason => ['text-observer-rebound', 'text-sequence-discontinuity'].includes(reason));
    valid(finiteTime(window.endMs) && window.endMs >= window.peakAtMs && integer(window.endSequence) && window.endSequence >= window.peakSequence && window.endSequence <= value.sequence && integer(window.textEndSequence) && (window.textEndSequence >= window.textStartSequence || textRebound), 'CPU sealed boundary');
  } else {
    valid(window.endMs === null && window.endSequence === null && window.textEndSequence === null && window.currentBytes === value.currentBytes, 'CPU open boundary');
  }
  return window;
}

/** Pure shape/arithmetic validation, never approval. Incomplete diagnostics are
 * valid evidence when their counters and failure classifications are coherent.
 * B0's initial numeric CPU join is separately checked against retained samples:
 * a final CPU v1 window intentionally has no invented initial-byte field. */
export function validateAppOwnershipObservation(appOwnership, combinedCpu) {
  const cpuWindow = cpuObservation(combinedCpu);
  exactObservation(appOwnership, ['kind', 'schemaVersion', 'ledgerInstanceId', 'transitionSequence', 'point', 'window'], 'application observation');
  valid(appOwnership.kind === 'app-ownership-observation-1' && appOwnership.schemaVersion === 1 && appOwnership.ledgerInstanceId === combinedCpu.ledgerInstanceId, 'application identity');
  unsigned(appOwnership.transitionSequence, 'application transition sequence');
  const point = appOwnership.point;
  exactObservation(point, ['kind', 'schemaVersion', 'ledgerInstanceId', 'transitionSequence', 'cpuSequence', 'clock', 'clockOriginMs', 'atMs', 'totals', 'centralCpuBytes', 'textBytes', 'textSequence', 'kinds', 'observationComplete', 'globalCoverageComplete'], 'application point');
  valid(point.kind === 'app-ownership-point-1' && point.schemaVersion === 1 && point.ledgerInstanceId === appOwnership.ledgerInstanceId && point.transitionSequence === appOwnership.transitionSequence && point.cpuSequence === combinedCpu.sequence, 'application point identity');
  valid(point.clock === 'browser-performance' && finiteTime(point.clockOriginMs) && (point.atMs === null || finiteTime(point.atMs)) && typeof point.observationComplete === 'boolean' && point.globalCoverageComplete === false, 'application point clock/flags');
  unsigned(point.centralCpuBytes, 'point central CPU'); nullableUnsigned(point.textBytes, 'point text bytes'); nullableUnsigned(point.textSequence, 'point text sequence');
  exactObservation(point.totals, amountKeys, 'point totals');
  for (const key of amountKeys) key === 'cpuBytes' ? nullableUnsigned(point.totals[key], 'point CPU total') : unsigned(point.totals[key], 'point ' + key);
  valid(Array.isArray(point.kinds) && point.kinds.length === allocationKinds.length, 'point kind inventory');
  for (let i = 0; i < allocationKinds.length; i++) {
    const row = point.kinds[i]; exactObservation(row, ['kind', 'records', ...amountKeys], 'point kind'); valid(row.kind === allocationKinds[i], 'point kind order');
    const { kind: _kind, ...amounts } = row; counts(amounts, true, 'point kind amounts');
  }
  const pointTotal = sumKinds(point.kinds, row => row);
  valid(pointTotal.cpuBytes === point.centralCpuBytes, 'point central CPU reconciliation');
  for (const key of amountKeys.filter(key => key !== 'cpuBytes')) valid(pointTotal[key] === point.totals[key], 'point reconciliation ' + key);
  valid(point.textBytes === null ? point.totals.cpuBytes === null : point.totals.cpuBytes === point.centralCpuBytes + point.textBytes, 'point text CPU reconciliation');
  if (point.observationComplete) valid(point.atMs !== null && point.textBytes !== null && point.textSequence !== null && point.totals.cpuBytes === combinedCpu.currentBytes, 'complete point CPU binding');
  const window = appOwnership.window;
  if (window === null) { valid(cpuWindow === null, 'one window absent'); return { point, window, cpuWindow }; }
  valid(cpuWindow !== null, 'CPU window absent');
  exactObservation(window, ['kind', 'schemaVersion', 'scope', 'ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'cpuStartSequence', 'cpuEndSequence', 'ledgerStartSequence', 'ledgerEndSequence', 'lastTransitionSequence', 'sealed', 'budgetRefusals', 'kinds', 'text', 'peaks', 'observationComplete', 'reconciled', 'failures', 'globalCoverageComplete'], 'application window');
  valid(window.kind === 'app-ownership-window-1' && window.schemaVersion === 1 && window.scope === APP_OWNED_ALLOCATION_CONTRACT.scope && window.ledgerInstanceId === appOwnership.ledgerInstanceId, 'application window identity');
  for (const key of ['id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'sealed']) valid(window[key] === cpuWindow[key], 'application/CPU window ' + key);
  valid(window.clockOriginMs === point.clockOriginMs && (point.atMs === null || point.atMs >= (window.endMs ?? cpuWindow.peakAtMs)), 'point/window clock');
  valid(window.cpuStartSequence === cpuWindow.startSequence && window.cpuEndSequence === cpuWindow.endSequence, 'application/CPU boundary sequences');
  for (const key of ['ledgerStartSequence', 'lastTransitionSequence', 'budgetRefusals']) unsigned(window[key], 'application window ' + key);
  nullableUnsigned(window.ledgerEndSequence, 'application window end sequence');
  valid(window.lastTransitionSequence >= window.ledgerStartSequence && (window.sealed ? window.ledgerEndSequence === window.lastTransitionSequence && appOwnership.transitionSequence >= window.lastTransitionSequence : window.ledgerEndSequence === null && appOwnership.transitionSequence === window.lastTransitionSequence), 'application transition bounds');
  valid(typeof window.observationComplete === 'boolean' && typeof window.reconciled === 'boolean' && window.globalCoverageComplete === false, 'application window flags');
  failureList(window.failures, appFailures, 'application failures');
  valid(!window.observationComplete || window.reconciled && window.failures.length === 0 && cpuWindow.observationComplete, 'complete window has missing observation');
  valid(Array.isArray(window.kinds) && window.kinds.length === allocationKinds.length, 'window kind inventory');
  let transitions = 0, reconciled = true;
  for (let i = 0; i < allocationKinds.length; i++) {
    const row = window.kinds[i]; exactObservation(row, ['kind', 'initial', 'current', 'transitions', 'added', 'removed'], 'window kind'); valid(row.kind === allocationKinds[i], 'window kind order');
    counts(row.initial, true, 'initial kind amounts'); counts(row.current, true, 'current kind amounts');
    // Added/removed vectors describe independent component deltas, not owned
    // snapshots; their preview delta need not itself be a CPU/GPU subset.
    for (const name of ['added', 'removed']) { exactObservation(row[name], amountKeys, name); for (const key of amountKeys) unsigned(row[name][key], name + ' ' + key); }
    exactObservation(row.transitions, ['reserved', 'resized', 'released', 'observed'], 'kind transitions');
    let kindTransitions = 0;
    for (const [key, count] of Object.entries(row.transitions)) { unsigned(count, 'kind transition ' + key); kindTransitions += count; transitions += count; unsigned(transitions, 'total transitions'); }
    valid(kindTransitions > 0 || amountKeys.every(key => row.added[key] === 0 && row.removed[key] === 0), 'kind deltas without a transition');
    reconciled &&= BigInt(row.initial.records) + BigInt(row.transitions.reserved) - BigInt(row.transitions.released) === BigInt(row.current.records);
    for (const key of amountKeys) reconciled &&= BigInt(row.initial[key]) + BigInt(row.added[key]) - BigInt(row.removed[key]) === BigInt(row.current[key]);
  }
  const sequenceReconciled = transitions === window.lastTransitionSequence - window.ledgerStartSequence;
  valid(!window.reconciled || reconciled && sequenceReconciled, 'claimed reconciliation differs from counters');
  valid(reconciled || window.failures.includes('kind-reconciliation'), 'unclassified kind reconciliation failure');
  valid(sequenceReconciled || window.failures.includes('sequence-reconciliation'), 'unclassified sequence reconciliation failure');
  exactObservation(window.text, ['initialBytes', 'currentBytes', 'startSequence', 'endSequence', 'observationComplete'], 'window text');
  for (const key of ['initialBytes', 'currentBytes', 'startSequence', 'endSequence']) nullableUnsigned(window.text[key], 'window text ' + key);
  valid(typeof window.text.observationComplete === 'boolean' && window.text.startSequence === cpuWindow.textStartSequence && window.text.endSequence === cpuWindow.textEndSequence, 'window text source binding');
  const initial = sumKinds(window.kinds, row => row.initial), current = sumKinds(window.kinds, row => row.current);
  exactObservation(window.peaks, ['gpuBytes', 'previewCacheBytes', 'handles'], 'window peaks');
  for (const key of ['gpuBytes', 'previewCacheBytes', 'handles']) { unsigned(window.peaks[key], 'window peak ' + key); valid(window.peaks[key] >= initial[key] && window.peaks[key] >= current[key], 'window peak lower bound ' + key); }
  if (window.observationComplete) {
    valid(window.text.observationComplete && window.text.initialBytes !== null && window.text.currentBytes !== null && current.cpuBytes + window.text.currentBytes === cpuWindow.currentBytes && cpuWindow.peakBytes >= initial.cpuBytes + window.text.initialBytes, 'complete window CPU reconciliation');
  }
  // Sealed witnesses stay frozen while the live point advances. Equal owner
  // sequences still describe the same owned records, unless an incomplete
  // saturated counter can no longer attest continuity.
  if (!window.sealed || appOwnership.transitionSequence === window.lastTransitionSequence && (point.observationComplete || appOwnership.transitionSequence < Number.MAX_SAFE_INTEGER))
    same(window.kinds.map(row => ({ kind: row.kind, ...row.current })), point.kinds, 'Application window differs from its unchanged live ownership');
  if (!window.sealed) valid(window.text.currentBytes === point.textBytes, 'open text point');
  if (window.sealed && combinedCpu.sequence === cpuWindow.endSequence) {
    valid(combinedCpu.currentBytes === cpuWindow.currentBytes && (point.atMs === null || point.atMs === cpuWindow.endMs), 'sealed CPU point differs at the same sequence');
    if (point.observationComplete && window.text.observationComplete)
      valid(point.textBytes === window.text.currentBytes && point.textSequence === window.text.endSequence, 'sealed text point differs at the same sequence');
  }
  return { point, window, cpuWindow };
}

function approvedAppScope(proof, resourceKey) {
  const review = proofReview(proof);
  valid(proof.kind === 'renderer-ownership-proof-2' && amountKeys.includes(resourceKey), 'approved resource scope');
  return review;
}
/** The fixed review approves app-owned conservative coverage only. These
 * predicates do not certify RSS, physical GPU backing, or opaque engine bytes.
 * Receipt verification must independently replay the exact retained v2 proof. */
export function isAppOwnedAllocationPoint(proof, { appOwnership, combinedCpu, resourceKey } = {}) {
  try { approvedAppScope(proof, resourceKey); return validateAppOwnershipObservation(appOwnership, combinedCpu).point.observationComplete; } catch { return false; }
}
export function isAppOwnedAllocationScope(proof, { appOwnership, combinedCpu, resourceKey } = {}) {
  try { approvedAppScope(proof, resourceKey); const { window, cpuWindow } = validateAppOwnershipObservation(appOwnership, combinedCpu); return !!window?.sealed && window.observationComplete && window.reconciled && cpuWindow.observationComplete; } catch { return false; }
}

/** A generic renderer/allocation review cannot approve R35 by implication.
 * The fixed review must explicitly cover parser/worker/WASM and shared owners. */
export function isTextResourceOwnershipProof(proof) {
  try {const review=approvedAppScope(proof,'cpuBytes');return isDeepStrictEqual(review.appAllocation.textResources,TEXT_RESOURCE_OWNERSHIP_CONTRACT);} catch {return false;}
}

/** Validate provenance structure, never grant source or runtime approval. The
 * fixed reviewed build seal and the producer's native pre/post checks bind these
 * records to compilation; caller-supplied records cannot create a registry row. */
export function validateRendererWorkerProvenance(evidence, nativeFiles) {
  if (!Array.isArray(evidence?.outputs) || !Array.isArray(evidence.nativeInputs) || !Array.isArray(nativeFiles)) throw Error('Renderer requires sealed native and worker build provenance');
  const expected = nativeFiles.map(pin => ({ path: pin.path, bytes: pin.bytes, sha256: pin.sha256.slice(7) })).sort((a, b) => a.path.localeCompare(b.path));
  same([...evidence.nativeInputs].sort((a, b) => a.path.localeCompare(b.path)), expected, 'Renderer compiled native inputs differ from the reviewed pins');
  const entries = new Map(), files = new Set(); let loaderIncluded = false;
  const loader = nativeFiles.find(file => file.role === 'loader');
  if (!loader) throw Error('Renderer worker provenance lacks its reviewed loader');
  for (const output of evidence.outputs) {
    if (!Object.hasOwn(output, 'workerBundle')) continue;
    const worker = output.workerBundle;
    if (!exactKeys(worker, ['schema', 'phase', 'format', 'entry', 'chunkEntry', 'facade', 'file', 'bytes', 'sha256', 'modules', 'imports']) ||
      worker.schema !== 1 || worker.phase !== 'generateBundle' || worker.format !== 'iife' || typeof worker.chunkEntry !== 'boolean' ||
      !integer(worker.bytes) || !BARE_HASH.test(worker.sha256 ?? '') || output.entry !== false) throw Error('Malformed renderer worker bundle provenance');
    relativePath(worker.entry); relativePath(worker.file);
    if (worker.facade !== null) relativePath(worker.facade);
    for (const key of ['modules', 'imports']) {
      if (!Array.isArray(worker[key]) || worker[key].some(value => typeof value !== 'string' || !value) || new Set(worker[key]).size !== worker[key].length) throw Error('Malformed renderer worker module/import inventory');
      same(worker[key], output[key], 'Renderer worker module/import provenance differs from emitted output');
    }
    worker.imports.forEach(relativePath);
    same({ file: worker.file, bytes: worker.bytes, sha256: worker.sha256 }, { file: output.file, bytes: output.bytes, sha256: output.sha256 }, 'Renderer worker bytes differ from emitted output');
    if (files.has(worker.file)) throw Error('Duplicate renderer worker output');
    files.add(worker.file);
    const count = entries.get(worker.entry) ?? 0;
    if (worker.chunkEntry && (worker.facade !== worker.entry || !worker.modules.includes(worker.entry))) throw Error('Renderer worker entry differs from its actual facade');
    entries.set(worker.entry, count + Number(worker.chunkEntry));
    loaderIncluded ||= worker.modules.includes(loader.path);
  }
  if (!entries.size || [...entries.values()].some(count => count !== 1)) throw Error('Renderer worker bundle lacks exactly one emitted entry');
  if (!loaderIncluded) throw Error('Sealed native renderer loader is absent from the actual worker bundle');
}

function decodeInput(input, pin) {
  if (!exactKeys(input, ['path', 'encoding', 'content']) || input.path !== pin.path || input.encoding !== pin.encoding || typeof input.content !== 'string') throw Error('Retained renderer input differs from its reviewed role');
  let bytes;
  if (input.encoding === 'utf8') bytes = Buffer.from(input.content, 'utf8');
  else {
    bytes = Buffer.from(input.content, 'base64');
    if (bytes.toString('base64') !== input.content) throw Error('Retained renderer binary encoding is not canonical');
  }
  if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) throw Error('Retained renderer input bytes differ from the reviewed pin');
  return bytes;
}
function parse(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function replay(payload, review, context) {
  const app = payload?.kind === 'renderer-ownership-evidence-2';
  if (!exactKeys(payload, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'sourceClosure', 'nativeRenderer', 'retainedSources', 'retainedNativeInputs', 'buildEvidence', ...(app ? ['appAllocation', 'retainedRuntimeInputs'] : [])]) || !['renderer-ownership-evidence-1', 'renderer-ownership-evidence-2'].includes(payload.kind)) throw Error('Malformed retained renderer ownership evidence');
  same(payload.reviewId, review.id, 'Retained renderer review differs');
  same(payload.reviewSha256, reviewIdentity(review), 'Retained renderer review seal differs');
  same(payload.contract, CANVAS2D_RENDERER_CONTRACT, 'Retained renderer contract differs');
  same(payload.executableIdentity, context.executableIdentity, 'Retained renderer executable identity differs');
  reviewedSources(review, context.sources);
  same(payload.sourceClosure, review.sourceFiles, 'Retained renderer closure differs from the fixed review');
  same(payload.nativeRenderer, review.nativeRenderer, 'Retained native renderer differs from the fixed review');
  if (!Array.isArray(payload.retainedSources) || payload.retainedSources.length !== review.sourceFiles.length || !Array.isArray(payload.retainedNativeInputs) || payload.retainedNativeInputs.length !== review.nativeFiles.length) throw Error('Retained renderer source/native input inventory differs');
  const sourceBytes = new Map(review.sourceFiles.map((pin, index) => [pin.path, decodeInput(payload.retainedSources[index], pin)]));
  const nativeBytes = new Map(review.nativeFiles.map((pin, index) => [pin.role, decodeInput(payload.retainedNativeInputs[index], pin)]));
  if (app) {
    const approved = reviewedAppAllocation(review, context);
    same(payload.appAllocation, approved, 'Retained application approval differs from the fixed review');
    if (!Array.isArray(payload.retainedRuntimeInputs) || payload.retainedRuntimeInputs.length !== approved.runtimeInputs.length) throw Error('Retained application correctness receipts differ from the fixed review');
    for (let index = 0; index < approved.runtimeInputs.length; index++) decodeInput(payload.retainedRuntimeInputs[index], approved.runtimeInputs[index]);
  }
  const native = review.nativeRenderer;
  if (native.package !== 'canvaskit-wasm' || typeof native.version !== 'string' || typeof native.rasterProfile !== 'string' || !native.rasterProfile.includes('cpu-rgba8888')) throw Error('Reviewed native renderer is not the sealed CPU RGBA profile');
  const pkg = parse(nativeBytes.get('package'));
  if (pkg.name !== native.package || pkg.version !== native.version) throw Error('Retained native package identity differs');
  for (const path of ['src/text/profile.json', 'vendor/text/manifest.json']) {
    const profile = parse(sourceBytes.get(path));
    if (profile.rasterProfile !== native.rasterProfile || profile.engine?.package !== native.package || profile.engine?.version !== native.version) throw Error('Retained native text profile differs');
    for (const [role, name] of [['loader', 'js'], ['wasm', 'wasm']]) {
      const bytes = nativeBytes.get(role), declared = native[name];
      if (bytes.length !== declared?.bytes || digest(bytes) !== declared?.sha256 || profile.engine?.[name]?.bytes !== declared.bytes || 'sha256:' + profile.engine?.[name]?.sha256 !== declared.sha256) throw Error('Retained native renderer bytes differ from the exact profile');
    }
  }
  const build = payload.buildEvidence;
  if (!exactKeys(build, ['path', 'bytes', 'sha256', 'content']) || build.path !== 'dist/app/build-evidence.json' || typeof build.content !== 'string') throw Error('Renderer build evidence is absent');
  const bytes = Buffer.from(build.content, 'utf8');
  same(context.builds.get(build.path), { path: build.path, bytes: bytes.length, sha256: digest(bytes) }, 'Renderer build evidence differs from the actual parent build');
  if (build.bytes !== bytes.length || build.sha256 !== digest(bytes)) throw Error('Retained renderer build evidence seal differs');
  const evidence = parse(bytes);
  if (evidence.schema !== 1 || evidence.capture?.phase !== 'writeBundle' || evidence.capture?.finalized !== true || evidence.toolchain?.node !== '26.10.0' || evidence.toolchain?.npm !== '12.1.0' || !Array.isArray(evidence.sourceInputs) || !Array.isArray(evidence.outputs)) throw Error('Renderer requires finalized production build evidence');
  validateRendererWorkerProvenance(evidence, review.nativeFiles);
  const expectedSources = [...context.sources.values()].filter(file => file && buildSourceRequired(file.path)).map(file => ({ ...file, sha256: file.sha256.slice(7) })).sort((a, b) => a.path.localeCompare(b.path));
  same([...evidence.sourceInputs].sort((a, b) => a.path.localeCompare(b.path)), expectedSources, 'Renderer build inputs differ from actual selected source');
  const outputs = new Map();
  for (const output of evidence.outputs) {
    relativePath(output.file);
    if (outputs.has(output.file) || !Array.isArray(output.modules)) throw Error('Duplicate or malformed renderer output');
    same(context.builds.get('dist/app/' + output.file), { path: 'dist/app/' + output.file, bytes: output.bytes, sha256: 'sha256:' + output.sha256 }, 'Renderer output differs from actual parent build');
    outputs.set(output.file, output);
  }
  for (const [path] of context.builds) if (path.startsWith('dist/app/') && !['dist/app/build-evidence.json', 'dist/app/.vite/manifest.json'].includes(path) && !outputs.has(path.slice('dist/app/'.length))) throw Error('Renderer build evidence omits a production output');
  const loader = review.nativeFiles.find(file => file.role === 'loader');
  if (![...outputs.values()].some(output => output.modules.includes(loader.path))) throw Error('Sealed native renderer loader is absent from the actual bundle');
  if (![...outputs.values()].some(output => output.file.endsWith('.wasm') && output.bytes === native.wasm.bytes && 'sha256:' + output.sha256 === native.wasm.sha256)) throw Error('Sealed native renderer WASM is absent from the actual build');
}

async function readInput(root, path, limit = MAX_EVIDENCE_BYTES) {
  relativePath(path); let current = root;
  for (const part of path.split('/')) {
    current = join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error('Renderer ownership inputs cannot contain symbolic links');
  }
  const file = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw Error('Renderer ownership input exceeds its ordinary-file bound');
    const bytes = await file.readFile(), after = await file.stat(), pathAfter = await lstat(current);
    if (bytes.length !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      pathAfter.ino !== after.ino || pathAfter.dev !== after.dev || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs || await realpath(current) !== current) throw Error('Renderer ownership input changed during retention');
    return bytes;
  } finally { await file.close(); }
}

/** Prepare once before B0. Never run file hashing during a sampled observation. */
export async function captureRendererOwnershipProof({ repo, output, sourceFiles, buildFiles, executableIdentity }) {
  const context = contextIdentity({ sourceFiles, buildFiles, executableIdentity }), review = selectedReview(context);
  if (!review) return { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] };
  if (typeof repo !== 'string' || typeof output !== 'string' || !isAbsolute(repo) || !isAbsolute(output) || await realpath(repo) !== repo || await realpath(output) !== output) throw Error('Renderer ownership requires canonical existing source and evidence directories');
  const retain = async pin => {
    const bytes = await readInput(repo, pin.path);
    const input = { path: pin.path, encoding: pin.encoding, content: pin.encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('base64') };
    decodeInput(input, pin); return input;
  };
  const retainedSources = [], retainedNativeInputs = [], retainedRuntimeInputs = [];
  for (const pin of review.sourceFiles) retainedSources.push(await retain(pin));
  for (const pin of review.nativeFiles) retainedNativeInputs.push(await retain(pin));
  const app = review.appAllocation;
  if (app) for (const pin of app.runtimeInputs) retainedRuntimeInputs.push(await retain(pin));
  const buildBytes = await readInput(repo, 'dist/app/build-evidence.json');
  const payload = { kind: app ? 'renderer-ownership-evidence-2' : 'renderer-ownership-evidence-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT,
    executableIdentity, sourceClosure: review.sourceFiles, nativeRenderer: review.nativeRenderer, retainedSources, retainedNativeInputs,
    buildEvidence: { path: 'dist/app/build-evidence.json', bytes: buildBytes.length, sha256: digest(buildBytes), content: new TextDecoder('utf-8', { fatal: true }).decode(buildBytes) },
    ...(app ? { appAllocation: app, retainedRuntimeInputs } : {}) };
  replay(payload, review, context);
  const bytes = Buffer.from(json(payload));
  if (bytes.length > MAX_EVIDENCE_BYTES) throw Error('Renderer ownership retained evidence exceeds its fixed bound');
  const evidenceFile = app ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  const artifact = { path: join(output, evidenceFile), retainedPath: evidenceFile, bytes: bytes.length, sha256: digest(bytes) };
  const proof = { kind: app ? 'renderer-ownership-proof-2' : 'renderer-ownership-proof-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT.contract, executableIdentity: structuredClone(executableIdentity), artifact };
  proofReview(proof);
  await exclusiveJSON(artifact.path, payload);
  return { proof: frozen(proof), artifact: proof.artifact, missing: [] };
}

/** readRetained must read this group's file through its outer immutable seal.
 * The callback returns verified bytes, never a subject/build pathname. */
export async function verifyRendererOwnershipProof(proof, { output, sourceFiles, buildFiles, executableIdentity, readRetained } = {}) {
  const review = proofReview(proof), context = contextIdentity({ sourceFiles, buildFiles, executableIdentity });
  const evidenceFile = proof.kind === 'renderer-ownership-proof-2' ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  same(proof.executableIdentity, executableIdentity, 'Renderer proof belongs to another parent executable identity');
  if (typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output || proof.artifact.path !== join(output, evidenceFile) || typeof readRetained !== 'function') throw Error('Renderer proof does not belong to the exact retained group');
  const bytes = await readRetained(evidenceFile);
  if (!Buffer.isBuffer(bytes) || bytes.length !== proof.artifact.bytes || digest(bytes) !== proof.artifact.sha256) throw Error('Renderer retained artifact identity differs');
  const payload = parse(bytes);
  if (payload.kind !== (proof.kind === 'renderer-ownership-proof-2' ? 'renderer-ownership-evidence-2' : 'renderer-ownership-evidence-1')) throw Error('Renderer proof and retained evidence versions differ');
  replay(payload, review, context);
  return frozen(structuredClone(proof));
}
