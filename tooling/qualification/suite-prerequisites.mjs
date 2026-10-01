// Shared, side-effect-free prerequisite metadata for every execution entry point.
export function requiredSuiteEnvironment(files) {
  return files.some(file => file.startsWith('tests/campaigns/')) ? {IE_CAMPAIGN_PRODUCT_INTEGRATION: '1'} : {};
}
export const nodeGroups = Object.freeze({
  base: ['session', 'store', 'protocol', 'assets', 'raster', 'history'],
  features: ['provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'portable', 'recovery'],
  helpers: ['browser', 'editor', 'text', 'qualification', 'campaigns'],
});
export const nodeGuard = group => group === 'store' ? 'tests/store/no-network.mjs' : group === 'provider' ? 'tests/provider/no-egress.mjs' : 'tests/session/no-egress.mjs';

// Measured together at ~2.2 seconds for 136 controller/core cases. These use
// compiled modules, but no real service, database, native worker or browser.
// Unknown files keep their conservative integration lane until reviewed.
export const fastNodeFiles = Object.freeze([
  'tests/request/core.test.mjs',
  'tests/request/queue-availability.test.mjs',
  'tests/request/queue-busy.test.mjs',
  'tests/request/queue-lifetime.test.mjs',
]);

// ~4 seconds for 192 controller/destination cases. These transform source
// directly and need the verified install, but no server/app/native build.
export const buildFreeFastNodeFiles = Object.freeze([
  'tests/export/client-cancel.test.mjs',
  'tests/export/destination-allocations.test.mjs',
  'tests/export/ui.test.mjs',
]);
