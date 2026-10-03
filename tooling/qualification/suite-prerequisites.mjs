// Shared, side-effect-free prerequisite metadata for every execution entry point.
export function requiredSuiteEnvironment(files) {
  return files.some(file => file.startsWith('tests/campaigns/')) ? {IE_CAMPAIGN_PRODUCT_INTEGRATION: '1'} : {};
}
// These exact ordinary Node files consume the current finalized application
// output. Development selectors must retain its build after focused filtering.
const applicationBuildFiles = new Set([
  'tests/campaigns/browser-d11-build.test.mjs',
  'tests/campaigns/renderer-ownership-approved.test.mjs',
]);
export const requiresApplicationBuild = files => files.some(file => applicationBuildFiles.has(file));

// These Node files eagerly load the current application identity and, where
// applicable, its issuer manifest. Other completion tests are self-contained.
const completionIdentityFiles = new Set([
  'tests/editor/completion/restored-native.test.mjs',
  'tests/editor/completion/host-final.test.mjs',
  'tests/editor/completion/ancillary-favicon.test.mjs',
  'tests/editor/completion/protocol-membership.test.mjs',
  'tests/editor/completion/font-state.test.mjs',
  'tests/editor/completion/operation.test.mjs',
  'tests/editor/completion/busy-state.test.mjs',
  'tests/editor/completion/receipts.test.mjs',
  'tests/editor/completion/candidate-corrections.test.mjs',
  'tests/editor/completion/header-receipt.test.mjs',
]);
export function completionPrerequisitesFor(files) {
  if (files.some(file => ['tests/editor/completion/protocol-membership.test.mjs', 'tests/editor/completion/handler-source.test.mjs'].includes(file))) return {kind: 'current-issuers-original-monitor-independent-capture-1'};
  return files.some(file => completionIdentityFiles.has(file)) ? {kind: 'current-issuers-1'} : undefined;
}
export const nodeGroups = Object.freeze({
  base: ['session', 'store', 'protocol', 'assets', 'raster', 'history'],
  features: ['provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'ui-state', 'portable', 'recovery', 'editor-capability-preflight'],
  helpers: ['browser', 'editor', 'text', 'qualification', 'campaigns'],
});
export const nodeGuard = group => ['store', 'ui-state', 'editor-capability-preflight'].includes(group) ? 'tests/store/no-network.mjs' : group === 'provider' ? 'tests/provider/no-egress.mjs' : 'tests/session/no-egress.mjs';

// This whole file observes the parent and retained storage writer through one
// shared strict counter buffer. The guard must be an actual launch preload so
// native Worker inheritance includes it; mutating process.execArgv is not enough.
export const nodeGuardOverrides = Object.freeze([
  Object.freeze({group: 'campaigns', suffix: 'store', guard: 'tests/store/no-network.mjs', files: Object.freeze([
    'tests/campaigns/backend-composition-warm.test.mjs',
  ])}),
]);
export const nodeGuardForFile = (group, file) => nodeGuardOverrides.find(item => item.group === group && item.files.includes(file))?.guard ?? nodeGuard(group);

// A parent selector covers all of its guard partitions, even when discovery
// produces only an override partition. Return each real gate exactly once.
export function expandNodeGateSelection(gates, requested) {
  return [...new Set(requested.flatMap(id => {
    const matches = gates.filter(gate => gate.id === id || gate.selectionGroup === id);
    return matches.length ? matches.map(gate => gate.id) : [id];
  }))];
}

// These exact migration tests install and verify the schema18 executable packet
// in each private fixture root. Resume must execute that preparation again.
const schema18FixtureFiles = new Set([
  'tests/assets/storage.test.mjs',
  'tests/candidates/compatibility.test.mjs',
  'tests/composition/schema.test.mjs',
  'tests/history/mask-schema.test.mjs',
  'tests/history/retained-mask-schema.test.mjs',
  'tests/history/schema.test.mjs',
  'tests/portable/compatibility.test.mjs',
  'tests/portable/legacy.test.mjs',
  'tests/portable/schema.test.mjs',
  'tests/portable/transaction-schema.test.mjs',
  'tests/protocol/recovery.test.mjs',
  'tests/raster/schema.test.mjs',
  'tests/raster/storage.test.mjs',
  'tests/recovery/compatibility.test.mjs',
  'tests/recovery/p2-schema.test.mjs',
  'tests/recovery/request-family-schema.test.mjs',
  'tests/text-state/placement-schema.test.mjs',
  'tests/text-state/schema.test.mjs',
]);
export const freshFixtureFiles = files => files.filter(file => schema18FixtureFiles.has(file));

// Historical committed-main measurement: ~2.2 seconds for 136 cases. These use
// compiled modules, but no real service, database, native worker or browser.
// Unknown files keep their conservative integration lane until reviewed.
export const fastNodeFiles = Object.freeze([
  'tests/request/core.test.mjs',
  'tests/request/queue-availability.test.mjs',
  'tests/request/queue-busy.test.mjs',
  'tests/request/queue-lifetime.test.mjs',
]);

// Historical committed-main measurement: ~4 seconds for 192 cases. These transform source
// directly and need the verified install, but no server/app/native build.
export const buildFreeFastNodeFiles = Object.freeze([
  'tests/export/client-cancel.test.mjs',
  'tests/export/destination-allocations.test.mjs',
  'tests/export/ui.test.mjs',
]);
