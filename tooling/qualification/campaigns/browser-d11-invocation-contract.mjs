import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readD11RegistrationArchiveMember } from './browser-d11-registration.mjs';
import { verifyD11ApplicationProfile } from './browser-d11-application-profile.mjs';

const PROFILE = 'd11-export-invocation-1';
const SOURCE = '37341d7a644cdfb37e6ba06d5c051e560306417d61a80705558bd78bd0c02cc4';
const MAX_ARCHIVE = 2 * 1024 * 1024, MAX_MEMBER = 64 * 1024, MAX_LOCK = 16 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw Error('D11 invocation ' + label + ' differs'); };
const decoder = new TextDecoder('utf-8', { fatal: true });
export const D11_COMPILATION_INPUT_PATHS = Object.freeze(['.progress-report/project.json', 'tooling/build-evidence.ts', 'vite.app.config.ts']);
const REVIEWED_COMPILATION = [
  { path: 'vite.app.config.ts', rawBytes: 554, sha256: 'sha256:ba4874b23f6f789ac56db7916bb0d0b1304bf3d2ff7c9a00bb0b4f298fe6c024' },
  { path: 'tooling/build-evidence.ts', rawBytes: 20934, sha256: 'sha256:483a863f126ff181d94897b3ca5defcbe00ff7104584bfbd8fa42478e54070c7' },
];

// These are reviewed production members, not package-name exemptions. Runtime
// sources are retained with their npm archives and independently bound to the
// finalized build's dependency inputs. Development/SSR variants cannot stand in
// for these browser implementations.
const PACKAGES = [
  { name: 'lit', version: '3.3.3', integrity: 'sha512-fycuvZg/hkpozL00lm1pEJH5nN/lr9ZXd6mJI2HSN4+Bzc+LDNdEApJ6HFbPkdFNHLvOplIIuJvxkS4XUxqirw==', members: [
    ['package.json', 10758, 'b96d657d4a2e94394569b6a0f25881a4e4908a2682094d20d3b251ef7e1198a6'],
    ['index.js', 157, 'b1993a57ee9b162bc5af6b2f4bc44623c0bd3496be5119c83d5325b04093b65c'],
    ['directives/repeat.js', 79, '1dd0dea44a8f3c956689a92360a16ccd7a412091c24906d5066196be45168ca0'],
  ] },
  { name: 'lit-element', version: '4.2.2', integrity: 'sha512-aFKhNToWxoyhkNDmWZwEva2SlQia+jfG0fjIWV//YeTaWrVnOxD89dPKfigCUspXFmjzOEUQpOkejH5Ly6sG0w==', members: [
    ['package.json', 7887, '30f4bdf2fa9f991060faa0b1e54fde10fe8923bf339aea38dfbfafa14e16928d'],
    ['lit-element.js', 1124, 'ee09e38303bb39c36959a961fb0a52663c798ee44493914472c3a61e84e55e3c'],
  ] },
  { name: 'lit-html', version: '3.3.3', integrity: 'sha512-el8M6jK2o3RXBnrSHX3ZKrsN8zEV63pSExTO1wYJz7QndGYZ8353e2a5PPX+qHe2aGayfnchQmkAojaWAREOIA==', members: [
    ['package.json', 20151, '9c0052af049941508481d808ff092dc8b9077faa58dad60316c24832089487e6'],
    ['lit-html.js', 7309, 'b878e7f95dec8a9b6e9b217faca6b6a11bad82ebc44c0caa77419ed83edd81f2'],
    ['directives/repeat.js', 1606, '083140026ecd8665fedd15b17769f9d516252a9f1502f1e91e6967686ee82626'],
    ['directive.js', 481, '3344c4f41c69cd0701d3937e8f9ef90bd845614bf6456d0b8314b7c51d415b9d'],
    ['directive-helpers.js', 1272, 'f7fb1154b8f72ed2cc08b05eaeed71c99270e9ad2d48620ed24688a1af4c2b62'],
  ] },
  { name: '@lit/reactive-element', version: '2.1.2', integrity: 'sha512-pbCDiVMnne1lYUIaYNN5wrwQXDtHaYtg7YEFPeW+hws6U47WeFvISGUWekPGKWOP1ygrs0ef0o1VJMk1exos5A==', members: [
    ['package.json', 15312, '71099ad5c6f15cbea26035d1bf151fd9d0957b79867bc5c3999e24b903f0b2ae'],
    ['reactive-element.js', 6306, '76e9815ec67d16684bff1444224bf62532d6318dbd8f25e7c1e9546158b1335f'],
  ] },
  { name: '@en-reve/elements', version: '0.1.0', filename: 'en-reve-elements-0.1.0.tgz',
    archiveSha256: 'sha256:01baeb4da2f42cf7ae14e2e0bf91b5199c7a10c23a8f899b289fed57827db11b',
    integrity: 'sha512-TyP4vV7EfglBb3IYwLO27ONejewFrIx5qCN8XUsmTQAUj3lFaAZBi7gu/QFWTlLlXyIXkw9Av4+03Ki0aiW31g==', members: [
      ['package.json', 1174, '90bdf39411df3e527e2ccbf26dabad33289a9da929237a3db11a390afe087507'],
      ['dist/definitions/tree.js', 330, '4c024a599491811f7ae7e94c6accd680dc18d96ac1e50fd55335f3934c16a96a'],
      ['dist/tree.js', 74, '333b17b51680453b3e5e3e16f56a45d66da9e2f04411cc58486c0f72c5ebdafc'],
      ['dist/tree/index.js', 72, '258cdca84bc0fad7d5186474d7aeb96e03fdabd5d7d63421aa1223faa1d48e8e'],
      ['dist/tree/element.js', 16226, 'e6a5d23ad49b2dab7c8999417d2ed83dacc38a4170afc8ae8f003cbeb47de07b'],
      ['dist/tree/interaction-controller.js', 20936, '9d2126a4d00af94ed70cd4ff80f2f89f222f07cdfa4254a4328a372649935192'],
      ['dist/tree/data-controller.js', 13913, 'eba34aee851a3e138dcb89821159efb24aa98d54134ba7d606dcd91597d62eb2'],
      ['dist/tree/lazy-controller.js', 4220, '0a5850d4e2a8067fe7fabd235bae3679386966b614fa1a5e4b0c7d296773fe76'],
      ['dist/tree/move-controller.js', 19566, '9928e5106a286a3dcbba96509ee29d53f825f4cff31427e6c8322e39c32febb5'],
      ['dist/internal/child-upgrades.js', 4314, 'f9e8bc73582ddd471ef08e7ee241b9610e88065a7ed65984246d9f2c2ce6b1e8'],
      ['dist/internal/dom-kind.js', 726, '8c135093cef7ba4e6c7f05089565df34e953a5c4ebd76d0672c030ad9a2ad1eb'],
      ['dist/definitions/button.js', 249, '01bda170373066f086311dccef844de29fb5cd24cf6222f1fc15f1ea7dd0961c'],
      ['dist/button.js', 80, '6da2cac2a5da37f804edc4c0be5bfed92e04a73dc3c84a766a11f3a01926aba8'],
      ['dist/button/index.js', 74, '9d864437ebca5b8a407c78e1a3180c8122bd647d7a32ee63e1286a9750bfa975'],
      ['dist/button/element.js', 8818, '13032a5ac7a8c27e95f5b334acfebf74e15d57e9388a94f0b5f8165c77625f22'],
      ['dist/button/template.js', 1093, '62222041a4c66d91175f39b86b1304f724373671bf4a99061db6458ef4cffa48'],
      ['dist/definitions/file-upload.js', 422, '3c63c700de391465ad9fd99f3d72ab68b8893eabc42c473048c5efcbae0c57a8'],
      ['dist/file-upload.js', 94, 'b9c14d22fe295ebcf7f816545c73a70ad70638e829330391fff42f8c2a43bdce'],
      ['dist/file-upload/index.js', 78, 'ab7ab69b8d50a066a41e4d6726a576305635507b447af63e06bae363647cf71f'],
      ['dist/file-upload/element.js', 16858, '367e7d49aaaa45f409188dbd206133ddace69c5783e391584c8218bdb670b39a'],
      ['dist/file-upload/template.js', 2069, 'b89225be43b2fff9beaf8b7c38c74fe23b6bff504dc54a4711d5158d4a3bb00c'],
      ['dist/file-upload/drop-controller.js', 4422, '54ac4969f0b064c36ab63919831b56833441c8ae97c3ef62ce5bad1da7cf98a8'],
      ['dist/forms-private/validation-feedback.js', 1260, '5110ef04fac2e949768d9edf063369d00e32a288a9c487d1c1cbe6f05f224af0'],
      ['dist/internal/en-element.js', 6691, 'fd3e011a019b31f46965191be3241e84435929c89842e53b238fef20136cc472'],
      ['dist/internal/focus-participant.js', 2458, '1dd4bc6cb676ed29017e96716f6276405ba600526dc894838b2ba20ab1b4bce5'],
      ['dist/internal/element-registry.js', 922, '2366b0126eabc41f8226e7b09af76c8fef2aeb6be25ba2d41c8d88519c304dab'],
    ] },
  { name: '@en-reve/primitives', version: '0.1.0', filename: 'en-reve-primitives-0.1.0.tgz',
    archiveSha256: 'sha256:769baf6ac5652966e1a791688291d0ef87596ea1ed270ebe10735f4d51cf65c2',
    integrity: 'sha512-8UGr4RS/eW19iP9HBWpU5K7Q5GEMnQRPvq6G7FI8azibCecqfdBf7Nz4dFF0m8Ti12QIcTBEfvhiqGeweqqcoA==', members: [
      ['package.json', 1103, '28534fd92e36e4e027afcafb806dbb6cc4bb9e285ef86b5213b09bb5a1254662'],
      ['dist/interactions/tree.js', 12494, '9d0cd649522d8e00f0e0e8ca9043063a53d568bcab00c1ebfeb2825388251068'],
      ['dist/state/value.js', 948, '298634112d3954da08c15c2b2db1b9fe05185e4efa16bac3401fe5e169450364'],
      ['dist/interactions/signal-controller.js', 1211, 'dacb99acdfe7312df80a0760e4889a9e9915e7e8d13ca7567368687c716a3ad6'],
      ['dist/interactions/virtual-collection.js', 33490, 'f26f6868d65eaf8fb30ba339b8d22a934ec05ec861520d8e303985fd9d656190'],
      ['dist/interactions/scroll-into-view.js', 11992, 'e3f204cf6b403f0c418730435f1942ce9bac7873478e9e476a5624d4016b3fd9'],
      ['dist/interactions/editing-controller.js', 5194, 'a82457b0e8ced258808675721c29f475734373c5b2672204fa59ac5a50736fee'],
      ['dist/interactions/events.js', 4279, 'eb0569335d5266defd088066c9315366a16bc081aa0ee4b7bbd1dee2b91bf422'],
      ['dist/interactions/form-controller.js', 2526, '0a34c27866fe964fd4fb588548fecfb7f604ac8606bdea15a7cbc4a11ceb9a79'],
      ['dist/interactions/file-selection.js', 1360, '1fc1780c9feb20749908d657b6c70c321122825d0a3164216c881f7ae3d75708'],
      ['dist/interactions/static-styles.js', 6120, 'daa549156db3e728263cdb86ae1d73210831a1146ff617caac57547b306209aa'],
    ] },
  { name: 'signal-polyfill', version: '0.2.2', integrity: 'sha512-p63Y4Er5/eMQ9RHg0M0Y64NlsQKpiu6MDdhBXpyywRuWiPywhJTpKJ1iB5K2hJEbFZ0BnDS7ZkJ+0AfTuL37Rg==', members: [
    ['package.json', 1187, '2d92c7369892b149c34c53c7de4dd30d9d1fe8ab686570db699c7154c440ca4d'],
    ['dist/index.js', 19825, 'eb9e97575cca78070eed9b53f4873fb8c7391946b305c709373c605806371187'],
  ] },
  { name: 'signal-utils', version: '0.21.1', integrity: 'sha512-i9cdLSvVH4j8ql8mz2lyrA93xL499P8wEbIev3ldSriXeUwqh+wM4Q5VPhIZ19gPtIS4BOopJuKB8l1+wH9LCg==', members: [
    ['package.json', 1925, '5b8d69f9d83eae024a29f4cac1fdc3e3ae68eaad0f78a1b441a65d1c720eef4f'],
    ['dist/subtle/reaction.ts.js', 2251, '041143f354bb847126b100d30bcb203b48e76d0e0d5c78d82c9d8c8dc19e15ab'],
  ] },
].map(item => Object.freeze({ ...item,
  lockPath: 'node_modules/' + item.name,
  resolved: item.filename ? 'file:vendor/en-reve/' + SOURCE + '/' + item.filename
    : 'https://registry.npmjs.org/' + item.name + '/-/' + item.name.split('/').at(-1) + '-' + item.version + '.tgz',
  members: Object.freeze(item.members.map(([path, rawBytes, hash]) => Object.freeze({ memberPath: 'package/' + path,
    installedPath: 'node_modules/' + item.name + '/' + path, rawBytes, sha256: 'sha256:' + hash }))),
}));

export const D11_INVOCATION_DEPENDENCY_PATHS = Object.freeze(PACKAGES.flatMap(item => item.members.map(member => member.installedPath)).sort());

function fields(value, expected, label) {
  if (!object(value)) throw Error('Invalid D11 invocation ' + label);
  equal(Object.keys(value).sort(), [...expected].sort(), label + ' fields');
}
function text(bytes) {
  let value; try { value = decoder.decode(bytes); } catch { throw Error('D11 invocation member is not UTF-8'); }
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 || !Buffer.from(value).equals(bytes)) throw Error('D11 invocation member does not round-trip as exact UTF-8');
  return value;
}
function bounded(bytes, maximum, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) throw Error('D11 invocation ' + label + ' exceeds its byte bound');
  return bytes;
}
function identity(path, bytes) { return { path, rawBytes: bytes.length, sha256: sha(bytes) }; }
function parse(bytes) { try { return JSON.parse(text(bytes)); } catch { throw Error('D11 invocation retained JSON is invalid'); } }

/** Reproduce the finalized compilation capture against retained source bytes.
 * This establishes capture consistency only. The invocation contract below
 * additionally requires the reviewed source hashes; callers cannot substitute
 * a different config or compiler guard as an approved effect implementation. */
export function verifyD11CompilationCapture(compilation, { sourceTextByPath } = {}) {
  if (!object(sourceTextByPath)) throw Error('D11 compilation requires retained source bytes');
  const inputs = D11_COMPILATION_INPUT_PATHS.map(path => {
    const value = sourceTextByPath[path];
    if (typeof value !== 'string') throw Error('D11 compilation source is missing: ' + path);
    const bytes = bounded(Buffer.from(value), MAX_MEMBER, 'compilation source');
    if (text(bytes) !== value) throw Error('D11 compilation source does not round-trip');
    return identity(path, bytes);
  });
  equal(compilation, { schema: 1, profile: 'reviewed-vite-app-2', configFile: 'vite.app.config.ts', configLoader: 'bundle',
    command: 'build', mode: 'production', env: { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true },
    configInputs: inputs.map(input => ({ path: input.path, bytes: input.rawBytes, sha256: input.sha256.slice(7) })),
    inlineTransformOptions: 'none', userPlugins: ['consumer-build-evidence'], worker: { format: 'iife', userPlugins: ['consumer-worker-build-evidence'] } }, 'compilation capture');
  return { kind: 'verified-d11-compilation-capture-1', inputs };
}
function lockPackages(lock) {
  if (!object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages)) throw Error('D11 invocation requires the retained npm lock');
  const compiler = lock.packages['node_modules/vite'];
  if (Object.keys(lock.packages).filter(path => path === 'node_modules/vite' || path.endsWith('/node_modules/vite')).length !== 1
    || !object(compiler) || compiler.version !== '8.3.1' || compiler.resolved !== 'https://registry.npmjs.org/vite/-/vite-8.3.1.tgz'
    || compiler.integrity !== 'sha512-/bvH9E9tmCXRGp2uXY3WbOldqpTwFkbha/8ANaEQ6VkxhH60KyqLwgZq6lG2y+4uT55x9+9eUHMpQ7uGnOCKjA==' || compiler.link === true)
    throw Error('D11 invocation compiler differs from the reviewed Vite configuration profile');
  for (const item of PACKAGES) {
    const locked = lock.packages[item.lockPath], matches = Object.keys(lock.packages).filter(path => path === item.lockPath || path.endsWith('/' + item.lockPath));
    if (matches.length !== 1 || !object(locked) || locked.version !== item.version || locked.resolved !== item.resolved || locked.integrity !== item.integrity || locked.link === true) throw Error('D11 invocation package differs from the reviewed lock profile: ' + item.name);
    if (item.filename && lock.packages['']?.dependencies?.[item.name] !== item.resolved) throw Error('D11 invocation local archive root differs from the retained lock');
  }
}
function dependencies(values) {
  if (!Array.isArray(values) || values.length !== D11_INVOCATION_DEPENDENCY_PATHS.length) throw Error('D11 invocation dependency input inventory differs');
  const found = new Map();
  for (const input of values) {
    fields(input, ['path', 'rawBytes', 'sha256'], 'dependency input');
    if (!D11_INVOCATION_DEPENDENCY_PATHS.includes(input.path) || found.has(input.path) || !Number.isSafeInteger(input.rawBytes) || input.rawBytes < 0 || !HASH.test(input.sha256 ?? '')) throw Error('D11 invocation dependency identity is invalid');
    found.set(input.path, input);
  }
  return found;
}

// Rolldown can omit these two declaration-only forwarding modules. Their exact
// archived and installed bytes still participate in the exact member capture. This
// fixed binding chain is checked only after authentication; it is not a generic
// exemption for an index file or a missing emitted module.
function verifiedTreeForwarding(authenticatedText, emitted) {
  const root = 'node_modules/@en-reve/elements/dist/';
  const definition = root + 'definitions/tree.js', leaf = root + 'tree/element.js';
  equal(authenticatedText.get(definition), [
    "import { EnTree } from '../tree.js';",
    "import { treeItemDefinition } from './tree-item.js';",
    '/** Registration metadata only; importing this module does not define elements. */',
    'export const treeDefinition = {', "    tagName: 'en-tree',", '    elementClass: EnTree,',
    '    dependencies: [treeItemDefinition],', '};', '//# sourceMappingURL=tree.js.map',
  ].join('\n'), 'tree definition forwarding binding');
  const links = [
    { path: root + 'tree.js', specifier: './tree/index.js', target: root + 'tree/index.js', sourceMap: 'tree.js.map' },
    { path: root + 'tree/index.js', specifier: './element.js', target: leaf, sourceMap: 'index.js.map' },
  ];
  for (const link of links) equal(authenticatedText.get(link.path),
    "export { EnTree } from '" + link.specifier + "';\n//# sourceMappingURL=" + link.sourceMap,
    'tree pure forwarding member');
  if (!emitted.has(definition) || !emitted.has(leaf)) throw Error('D11 invocation tree definition or implementation leaf was not in the compiled module graph');
  return { kind: 'verified-d11-tree-forwarding-1', exportName: 'EnTree', definition, leaf,
    links: links.map(({ sourceMap, ...link }) => ({ ...link, emitted: emitted.has(link.path) })) };
}

// Button public entrypoints are also pure named reexports in the pinned
// package. Authenticate this exact chain after all member/archive checks; this
// does not authorize omission of another barrel or of the emitted implementation.
function verifiedButtonForwarding(authenticatedText, emitted) {
  const root = 'node_modules/@en-reve/elements/dist/', definition = root + 'definitions/button.js', leaf = root + 'button/element.js';
  equal(authenticatedText.get(definition), [
    "import { EnButton } from '../button.js';",
    '/** Registration metadata only; importing this module does not define elements. */',
    'export const buttonDefinition = {', "    tagName: 'en-button',", '    elementClass: EnButton,',
    '};', '//# sourceMappingURL=button.js.map',
  ].join('\n'), 'button definition forwarding binding');
  const links = [
    { path: root + 'button.js', specifier: './button/index.js', target: root + 'button/index.js', sourceMap: 'button.js.map' },
    { path: root + 'button/index.js', specifier: './element.js', target: leaf, sourceMap: 'index.js.map' },
  ];
  for (const link of links) equal(authenticatedText.get(link.path),
    "export { EnButton } from '" + link.specifier + "';\n//# sourceMappingURL=" + link.sourceMap,
    'button pure forwarding member');
  if (!emitted.has(definition) || !emitted.has(leaf)) throw Error('D11 invocation button definition or implementation leaf was not in the compiled module graph');
  return { kind: 'verified-d11-button-forwarding-1', exportName: 'EnButton', definition, leaf,
    links: links.map(({ sourceMap, ...link }) => ({ ...link, emitted: emitted.has(link.path) })) };
}

// FileUpload forwards native change/drop and explicit removal through propose.
// Its reviewed constructor, files setter, form reset/restore, update callbacks
// and adoption of pre-upgrade native files never dispatch en-change. This is
// own-lifecycle silence, not an isTrusted or user-authorization assertion.
// The source proof must still exclude synthetic events and direct calls.
function verifiedFileUploadForwarding(authenticatedText, emitted) {
  const root = 'node_modules/@en-reve/elements/dist/', definition = root + 'definitions/file-upload.js', leaf = root + 'file-upload/element.js';
  equal(authenticatedText.get(definition), [
    "import { EnFileUpload } from '../file-upload.js';",
    "import { buttonDefinition } from './button.js';",
    "import { iconDefinition } from './icon.js';",
    '/** Registration metadata only; importing this module does not define elements. */',
    'export const fileUploadDefinition = {', "    tagName: 'en-file-upload',", '    elementClass: EnFileUpload,',
    '    dependencies: [buttonDefinition, iconDefinition],', '};', '//# sourceMappingURL=file-upload.js.map',
  ].join('\n'), 'file-upload definition forwarding binding');
  const links = [
    { path: root + 'file-upload.js', specifier: './file-upload/index.js', target: root + 'file-upload/index.js', sourceMap: 'file-upload.js.map' },
    { path: root + 'file-upload/index.js', specifier: './element.js', target: leaf, sourceMap: 'index.js.map' },
  ];
  for (const link of links) equal(authenticatedText.get(link.path),
    "export { EnFileUpload } from '" + link.specifier + "';\n//# sourceMappingURL=" + link.sourceMap,
    'file-upload pure forwarding member');
  if (!emitted.has(definition) || !emitted.has(leaf)) throw Error('D11 invocation file-upload definition or implementation leaf was not in the compiled module graph');
  return { kind: 'verified-d11-file-upload-forwarding-1', exportName: 'EnFileUpload', definition, leaf,
    links: links.map(({ sourceMap, ...link }) => ({ ...link, emitted: emitted.has(link.path) })) };
}

/** Pure archive/member and build-input verification. This returns narrowly
 * reviewed effects; it never certifies a class, a callback escape, absence of
 * synthetic events, or absence of the optional framework hooks. Those remain
 * obligations of the source-bound target proof and fixed browser context. */
export function verifyD11InvocationContract(contract, { lock, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile } = {}) {
  fields(contract, ['kind', 'profile', 'packages'], 'contract');
  if (contract.kind !== 'perf-d11-invocation-contract-1' || contract.profile !== PROFILE) throw Error('D11 invocation profile is unsupported');
  lockPackages(lock); const installed = dependencies(dependencyInputs);
  const compiled = verifyD11CompilationCapture(compilation, { sourceTextByPath });
  for (const input of REVIEWED_COMPILATION) equal(compiled.inputs.find(value => value.path === input.path), input, 'reviewed compilation source');
  const applicationSourceProfile = verifyD11ApplicationProfile({ sourceTextByPath, sourceInputs, bootstrapText: outputTextByFile?.['inline:bootstrap'] });
  if (!Array.isArray(emittedModules) || emittedModules.length > 100_000 || emittedModules.some(path => typeof path !== 'string' || path.length > 8192)) throw Error('D11 invocation emitted module inventory is absent or invalid');
  const emitted = new Set(emittedModules);
  // The forwarded imports must select the reviewed production browser modules.
  // Merely retaining an unused reviewed file beside a different resolved module
  // cannot supply the event contract.
  for (const path of emitted) for (const item of PACKAGES) {
    if (path.includes('/' + item.lockPath + '/')) throw Error('D11 invocation compiled graph includes an unreviewed nested package identity');
    if (path.startsWith(item.lockPath + '/') && (/\/(?:development|node)\//.test(path.slice(item.lockPath.length)) || /[?#]/.test(path))) throw Error('D11 invocation compiled graph includes an unreviewed development, server or transformed variant');
  }
  if (!Array.isArray(contract.packages) || contract.packages.length !== PACKAGES.length) throw Error('D11 invocation requires the exact reviewed packages');
  const inputs = [], localArchiveInputs = [], authenticatedText = new Map();
  for (const [index, item] of PACKAGES.entries()) {
    const packed = contract.packages[index];
    fields(packed, ['name', 'lockPath', 'version', 'resolved', 'integrity', 'archive', 'members'], 'package');
    for (const key of ['name', 'lockPath', 'version', 'resolved', 'integrity']) equal(packed[key], item[key], 'package ' + key);
    const archive = packed.archive;
    fields(archive, ['encoding', 'data', 'rawBytes', 'sha256'], 'archive');
    if (archive.encoding !== 'base64' || typeof archive.data !== 'string' || archive.data.length > Math.ceil(MAX_ARCHIVE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(archive.data)) throw Error('Invalid D11 invocation archive encoding');
    const bytes = bounded(Buffer.from(archive.data, 'base64'), MAX_ARCHIVE, 'archive');
    if (bytes.toString('base64') !== archive.data || bytes.length !== archive.rawBytes || sha(bytes) !== archive.sha256 || sri(bytes) !== item.integrity || item.archiveSha256 && sha(bytes) !== item.archiveSha256) throw Error('D11 invocation archive differs from reviewed lock integrity');
    if (item.filename) localArchiveInputs.push(identity(item.resolved.slice(5), bytes));
    if (!Array.isArray(packed.members) || packed.members.length !== item.members.length) throw Error('D11 invocation selected member inventory differs');
    for (const [memberIndex, member] of item.members.entries()) {
      const selected = bounded(readD11RegistrationArchiveMember(bytes, member.memberPath).bytes, MAX_MEMBER, 'member');
      if (selected.length !== member.rawBytes || sha(selected) !== member.sha256) throw Error('D11 invocation member differs from reviewed production bytes');
      equal(packed.members[memberIndex], { ...member, text: text(selected) }, 'member provenance');
      authenticatedText.set(member.installedPath, text(selected));
      const input = identity(member.installedPath, selected);
      equal(installed.get(member.installedPath), input, 'compiled dependency member');
      inputs.push(input);
      if (member.installedPath.endsWith('/package.json')) {
        const metadata = parse(selected);
        if (metadata.name !== item.name || metadata.version !== item.version || metadata.type !== 'module') throw Error('D11 invocation package metadata differs');
      }
    }
  }
  const treeForwarding = verifiedTreeForwarding(authenticatedText, emitted);
  const buttonForwarding = verifiedButtonForwarding(authenticatedText, emitted);
  const fileUploadForwarding = verifiedFileUploadForwarding(authenticatedText, emitted);
  const omittedForwarders = new Set([...treeForwarding.links, ...buttonForwarding.links, ...fileUploadForwarding.links].filter(link => !link.emitted).map(link => link.path));
  for (const item of PACKAGES) for (const member of item.members) if (!member.installedPath.endsWith('/package.json') && !emitted.has(member.installedPath) && !omittedForwarders.has(member.installedPath)) throw Error('D11 invocation reviewed runtime member was not in the compiled module graph: ' + member.installedPath);
  return { kind: 'verified-d11-invocation-contract-1', profile: PROFILE,
    effects: { plainArrowEventBinding: 'stored-until-dispatch', eventInvocation: 'EventPart.handleEvent', nativeButtonStartupClick: 'not-dispatched-by-reviewed-own-lifecycle',
      nativeFileUploadStartupChange: 'not-dispatched-by-reviewed-own-lifecycle',
      repeatRender: 'eager-key-and-item-render-with-child-part-commit', nativeEditingBridgeStartup: 'no-preview-or-apply-dispatch',
      supportedCompilation: 'reviewed-vite-app-config-and-build-evidence', applicationSourceProfile: 'reviewed-d11-startup-corpus-1',
      treeSelectedKeys: 'immutable-string-array-from-reviewed-value-model' },
    requiredAbsentGlobals: ['reactiveElementPolyfillSupport', 'litElementHydrateSupport', 'litElementPolyfillSupport', 'litHtmlPolyfillSupport'],
    inputs, localArchiveInputs, compilationInputs: compiled.inputs, applicationSourceProfile, treeForwarding, buttonForwarding, fileUploadForwarding };
}

/** Preparation performs bounded reads only. Registry archive acquisition is
 * explicit and injected; this module never installs packages or uses a network.
 * The caller's repo reader must enforce its canonical/stable file boundary. */
export async function prepareD11InvocationContract({ read, readArchive, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile } = {}) {
  if (typeof read !== 'function' || typeof readArchive !== 'function') throw Error('D11 invocation preparation requires explicit repo and archive readers');
  const obtain = async (path, maximum) => bounded((await read(path, maximum)).bytes, maximum, path);
  const lock = parse(await obtain('package-lock.json', MAX_LOCK)); lockPackages(lock);
  for (const path of D11_COMPILATION_INPUT_PATHS) equal(sourceTextByPath?.[path], text(await obtain(path, MAX_MEMBER)), 'prepared compilation source');
  const contract = { kind: 'perf-d11-invocation-contract-1', profile: PROFILE, packages: [] };
  for (const item of PACKAGES) {
    const bytes = bounded(item.filename ? await obtain(item.resolved.slice(5), MAX_ARCHIVE)
      : await readArchive({ name: item.name, lockPath: item.lockPath, resolved: item.resolved, integrity: item.integrity, maxBytes: MAX_ARCHIVE }), MAX_ARCHIVE, 'archive');
    if (sri(bytes) !== item.integrity || item.archiveSha256 && sha(bytes) !== item.archiveSha256) throw Error('D11 invocation archive identity differs before member preparation');
    const members = [];
    for (const member of item.members) {
      const selected = readD11RegistrationArchiveMember(bytes, member.memberPath).bytes;
      if (selected.length !== member.rawBytes || sha(selected) !== member.sha256) throw Error('D11 invocation reviewed member differs before installed read');
      if (!selected.equals(await obtain(member.installedPath, MAX_MEMBER))) throw Error('D11 invocation installed member differs from retained archive');
      members.push({ ...member, text: text(selected) });
    }
    contract.packages.push({ name: item.name, lockPath: item.lockPath, version: item.version, resolved: item.resolved, integrity: item.integrity,
      archive: { encoding: 'base64', data: bytes.toString('base64'), rawBytes: bytes.length, sha256: sha(bytes) }, members });
  }
  verifyD11InvocationContract(contract, { lock, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile });
  return contract;
}

/** Optional local reader for npm's SHA512-addressed content cache. A caller must
 * explicitly select an absolute canonical cache directory; no default cache,
 * npm invocation, download, package import, or cache write occurs. */
export function createD11NpmArchiveReader({ cacheDirectory } = {}) {
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory) || resolve(cacheDirectory) !== cacheDirectory) throw Error('D11 invocation npm cache must be an explicit absolute canonical directory');
  return async ({ integrity, maxBytes = MAX_ARCHIVE } = {}) => {
    if (!SRI.test(integrity ?? '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARCHIVE) throw Error('D11 invocation cache request is invalid');
    const digest = Buffer.from(integrity.slice(7), 'base64');
    if (digest.length !== 64 || digest.toString('base64') !== integrity.slice(7)) throw Error('D11 invocation cache integrity is not canonical');
    const hex = digest.toString('hex'), parts = ['_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)];
    if (await realpath(cacheDirectory) !== cacheDirectory || !(await lstat(cacheDirectory)).isDirectory()) throw Error('D11 invocation npm cache root is not a canonical directory');
    let path = cacheDirectory;
    for (const [index, part] of parts.entries()) {
      path = join(path, part); const entry = await lstat(path);
      if (entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw Error('D11 invocation cache contains a symlink or non-regular path');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw Error('D11 invocation cache archive exceeds its byte bound');
      // Read into a fixed bound even if a concurrently modified cache entry
      // grows after stat; readFile() would allocate for the untrusted growth.
      const buffer = Buffer.alloc(maxBytes + 1); let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > maxBytes) throw Error('D11 invocation cache archive exceeds its byte bound');
      const bytes = buffer.subarray(0, count), after = await handle.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || sri(bytes) !== integrity) throw Error('D11 invocation cache archive changed or differs from lock integrity');
      return bytes;
    } finally { await handle.close(); }
  };
}
